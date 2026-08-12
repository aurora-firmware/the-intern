use std::{
    fs,
    path::{Path, PathBuf},
};

use bob_core::error::{ServiceError, ServiceResult};

use crate::{
    config::{resolve_init_paths_for_env, ResolvedInitPaths},
    init_assets::embedded_pi_skill_assets,
};

const CONTEXT_PLACEHOLDER: &str = "# Workspace Instructions\n\nWorkspace-specific instructions belong in this file. Bob treats this file as trusted pi context for this workspace.\n";
const EMAIL_TRIAGE_TEMPLATE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../email-skills/config/email-triage.example.toml"
));

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MaterializationReport {
    pub workspace_path: PathBuf,
    pub config_path: PathBuf,
    pub skill_install_path: PathBuf,
    pub created_paths: Vec<PathBuf>,
    pub replaced_paths: Vec<PathBuf>,
    pub skipped_paths: Vec<PathBuf>,
}

pub fn materialize_workspace(
    workspace_path: &Path,
    force: bool,
) -> ServiceResult<MaterializationReport> {
    let current_dir = std::env::current_dir().map_err(|err| ServiceError::InvalidRequest {
        detail: format!("failed to resolve current working directory: {err}"),
    })?;
    let env = std::env::vars().collect();
    let resolved_paths = resolve_init_paths_for_env(&env, current_uid());

    materialize_workspace_with_paths(workspace_path, &current_dir, &resolved_paths, force)
}

pub(crate) fn materialize_workspace_with_paths(
    workspace_path: &Path,
    current_dir: &Path,
    resolved_paths: &ResolvedInitPaths,
    force: bool,
) -> ServiceResult<MaterializationReport> {
    let workspace_path = resolve_workspace_path(workspace_path, current_dir);
    reject_git_metadata_target(&workspace_path)?;
    ensure_directory(&workspace_path)?;

    let mut report = MaterializationReport {
        workspace_path: workspace_path.clone(),
        config_path: resolved_paths.config_path.clone(),
        skill_install_path: resolved_paths.skill_install_path.clone(),
        created_paths: vec![],
        replaced_paths: vec![],
        skipped_paths: vec![],
    };

    install_shared_skills(&resolved_paths.skill_install_path, force, &mut report)?;
    materialize_workspace_files(&workspace_path, force, &mut report)?;
    write_live_config(
        &resolved_paths.config_path,
        &resolved_paths.skill_install_path,
        force,
        &mut report,
    )?;

    Ok(report)
}

fn materialize_workspace_files(
    workspace_path: &Path,
    force: bool,
    report: &mut MaterializationReport,
) -> ServiceResult<()> {
    ensure_directory(workspace_path)?;
    ensure_directory(&workspace_path.join("config"))?;
    ensure_directory(&workspace_path.join("worklog"))?;

    write_generated_file(
        &workspace_path.join("AGENTS.md"),
        CONTEXT_PLACEHOLDER.as_bytes(),
        force,
        report,
    )?;
    write_generated_file(
        &workspace_path.join("CLAUDE.md"),
        CONTEXT_PLACEHOLDER.as_bytes(),
        force,
        report,
    )?;
    write_generated_file(
        &workspace_path.join("config").join("email-triage.toml"),
        EMAIL_TRIAGE_TEMPLATE.as_bytes(),
        force,
        report,
    )?;

    Ok(())
}

fn install_shared_skills(
    skill_install_path: &Path,
    force: bool,
    report: &mut MaterializationReport,
) -> ServiceResult<()> {
    ensure_directory(skill_install_path)?;

    for asset in embedded_pi_skill_assets() {
        let asset_path = skill_install_path.join(asset.relative_path());
        let parent = asset_path
            .parent()
            .ok_or_else(|| ServiceError::InvalidRequest {
                detail: format!(
                    "embedded asset path has no parent: {}",
                    asset_path.display()
                ),
            })?;
        ensure_directory(parent)?;
        write_generated_file(&asset_path, asset.bytes(), force, report)?;
    }

    Ok(())
}

fn write_live_config(
    config_path: &Path,
    skill_install_path: &Path,
    force: bool,
    report: &mut MaterializationReport,
) -> ServiceResult<()> {
    if config_path.exists() && !force {
        return Err(ServiceError::InvalidRequest {
            detail: format!(
                "live config already exists at {}; rerun with --force to replace it",
                config_path.display()
            ),
        });
    }

    let config_parent = config_path
        .parent()
        .ok_or_else(|| ServiceError::InvalidRequest {
            detail: format!("live config path has no parent: {}", config_path.display()),
        })?;
    ensure_directory(config_parent)?;

    write_generated_file(
        config_path,
        render_live_config(skill_install_path).as_bytes(),
        force,
        report,
    )
}

fn write_generated_file(
    path: &Path,
    contents: &[u8],
    force: bool,
    report: &mut MaterializationReport,
) -> ServiceResult<()> {
    if path.exists() {
        let metadata = fs::metadata(path).map_err(|err| ServiceError::Persistence {
            detail: format!("failed to inspect existing path {}: {err}", path.display()),
        })?;
        if !metadata.is_file() {
            return Err(ServiceError::InvalidRequest {
                detail: format!(
                    "refusing to replace non-file path {}; remove it manually first",
                    path.display()
                ),
            });
        }
        if !force {
            report.skipped_paths.push(path.to_path_buf());
            return Ok(());
        }
        fs::write(path, contents).map_err(|err| ServiceError::Persistence {
            detail: format!("failed to replace generated file {}: {err}", path.display()),
        })?;
        set_owner_only_mode(path, 0o600)?;
        report.replaced_paths.push(path.to_path_buf());
        return Ok(());
    }

    fs::write(path, contents).map_err(|err| ServiceError::Persistence {
        detail: format!("failed to write generated file {}: {err}", path.display()),
    })?;
    set_owner_only_mode(path, 0o600)?;
    report.created_paths.push(path.to_path_buf());
    Ok(())
}

fn ensure_directory(path: &Path) -> ServiceResult<()> {
    if path.exists() {
        let metadata = fs::metadata(path).map_err(|err| ServiceError::Persistence {
            detail: format!("failed to inspect directory {}: {err}", path.display()),
        })?;
        if !metadata.is_dir() {
            return Err(ServiceError::InvalidRequest {
                detail: format!(
                    "expected directory at {}, found a non-directory path",
                    path.display()
                ),
            });
        }
        set_owner_only_mode(path, 0o700)?;
        return Ok(());
    }

    fs::create_dir_all(path).map_err(|err| ServiceError::Persistence {
        detail: format!("failed to create directory {}: {err}", path.display()),
    })?;
    set_owner_only_mode(path, 0o700)
}

fn render_live_config(skill_install_path: &Path) -> String {
    let escaped_path = escape_toml_basic_string(&skill_install_path.display().to_string());
    format!(
        r#"skill_install_path = "{escaped_path}"

[[policy.action_rules]]
tool = "bash"

[[policy.action_rules]]
tool = "read"

[[policy.action_rules]]
tool = "write"

[[policy.action_rules]]
tool = "edit"
"#
    )
}

fn escape_toml_basic_string(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

fn resolve_workspace_path(workspace_path: &Path, current_dir: &Path) -> PathBuf {
    let raw = if workspace_path.is_absolute() {
        workspace_path.to_path_buf()
    } else {
        current_dir.join(workspace_path)
    };

    normalize_path(raw)
}

fn normalize_path(path: PathBuf) -> PathBuf {
    use std::path::Component;

    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir => normalized.push(Path::new("/")),
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            Component::Normal(part) => normalized.push(part),
        }
    }
    normalized
}

fn reject_git_metadata_target(path: &Path) -> ServiceResult<()> {
    if path
        .components()
        .any(|component| component.as_os_str() == ".git")
    {
        return Err(ServiceError::InvalidRequest {
            detail: format!(
                "workspace path {} targets git metadata; choose a directory outside .git",
                path.display()
            ),
        });
    }

    Ok(())
}

#[cfg(unix)]
fn set_owner_only_mode(path: &Path, mode: u32) -> ServiceResult<()> {
    use std::os::unix::fs::PermissionsExt;

    fs::set_permissions(path, fs::Permissions::from_mode(mode)).map_err(|err| {
        ServiceError::Persistence {
            detail: format!("failed to set permissions on {}: {err}", path.display()),
        }
    })
}

#[cfg(not(unix))]
fn set_owner_only_mode(_path: &Path, _mode: u32) -> ServiceResult<()> {
    Ok(())
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn current_uid() -> u32 {
    nix::unistd::Uid::current().as_raw()
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn current_uid() -> u32 {
    0
}

#[cfg(test)]
mod tests {
    use std::{collections::BTreeMap, fs, os::unix::fs::PermissionsExt, path::Path};

    use policy_control::{PolicyEngine, RulesetSnapshot};
    use serde_json::json;

    use super::*;

    fn init_env(temp: &tempfile::TempDir) -> BTreeMap<String, String> {
        BTreeMap::from([
            (
                "XDG_CONFIG_HOME".to_string(),
                temp.path().join("xdg-config").display().to_string(),
            ),
            (
                "XDG_DATA_HOME".to_string(),
                temp.path().join("xdg-data").display().to_string(),
            ),
        ])
    }

    fn assert_mode(path: &Path, expected_mode: u32) {
        let actual = fs::metadata(path)
            .unwrap_or_else(|err| panic!("stat {}: {err}", path.display()))
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(
            actual,
            expected_mode,
            "unexpected mode for {}",
            path.display()
        );
    }

    #[test]
    fn materializes_new_workspace_and_shared_assets_with_owner_only_permissions() {
        let temp = tempfile::tempdir().expect("tempdir should be created");
        let env = init_env(&temp);
        let resolved_paths = crate::config::resolve_init_paths_for_env(&env, 4242);

        let report = materialize_workspace_with_paths(
            Path::new("workspace"),
            temp.path(),
            &resolved_paths,
            false,
        )
        .expect("fresh materialization should succeed");

        let workspace = temp.path().join("workspace");
        assert_eq!(report.workspace_path, workspace);
        assert_eq!(report.config_path, resolved_paths.config_path);
        assert_eq!(report.skill_install_path, resolved_paths.skill_install_path);

        let agents = workspace.join("AGENTS.md");
        let claude = workspace.join("CLAUDE.md");
        let workspace_config = workspace.join("config").join("email-triage.toml");
        let worklog = workspace.join("worklog");
        let shared_skill = resolved_paths
            .skill_install_path
            .join("email-triage")
            .join("SKILL.md");
        let live_config = resolved_paths.config_path.clone();

        assert_eq!(
            fs::read_to_string(&agents).expect("AGENTS.md should exist"),
            CONTEXT_PLACEHOLDER
        );
        assert_eq!(
            fs::read_to_string(&claude).expect("CLAUDE.md should exist"),
            CONTEXT_PLACEHOLDER
        );
        assert_eq!(
            fs::read_to_string(&workspace_config).expect("email-triage config should exist"),
            EMAIL_TRIAGE_TEMPLATE
        );
        assert!(
            worklog.is_dir(),
            "worklog directory should be created at {}",
            worklog.display()
        );
        assert!(
            shared_skill.is_file(),
            "embedded skill asset should be installed at {}",
            shared_skill.display()
        );
        assert!(
            live_config.is_file(),
            "live config should be created at {}",
            live_config.display()
        );

        assert_mode(&workspace, 0o700);
        assert_mode(&workspace.join("config"), 0o700);
        assert_mode(&worklog, 0o700);
        assert_mode(&resolved_paths.skill_install_path, 0o700);
        assert_mode(
            &resolved_paths.skill_install_path.join("email-triage"),
            0o700,
        );
        assert_mode(&agents, 0o600);
        assert_mode(&claude, 0o600);
        assert_mode(&workspace_config, 0o600);
        assert_mode(&shared_skill, 0o600);
        assert_mode(&live_config, 0o600);
    }

    #[test]
    fn generates_loader_valid_config_with_four_bootstrap_rules_and_no_admin_socket() {
        let temp = tempfile::tempdir().expect("tempdir should be created");
        let env = BTreeMap::from([
            (
                "XDG_CONFIG_HOME".to_string(),
                temp.path().join("xdg-config").display().to_string(),
            ),
            (
                "XDG_DATA_HOME".to_string(),
                temp.path().join("xdg-data").display().to_string(),
            ),
            (
                "XDG_STATE_HOME".to_string(),
                temp.path().join("xdg-state").display().to_string(),
            ),
            (
                "XDG_RUNTIME_DIR".to_string(),
                temp.path().join("xdg-runtime").display().to_string(),
            ),
        ]);
        let resolved_paths = crate::config::resolve_init_paths_for_env(&env, 4242);

        materialize_workspace_with_paths(
            Path::new("workspace"),
            temp.path(),
            &resolved_paths,
            false,
        )
        .expect("fresh materialization should succeed");

        let live_config = fs::read_to_string(&resolved_paths.config_path)
            .expect("live config should exist after materialization");
        assert!(
            live_config.contains(&format!(
                "skill_install_path = \"{}\"",
                resolved_paths.skill_install_path.display()
            )),
            "live config should name the resolved shared skill install path"
        );
        assert_eq!(
            live_config.matches("[[policy.action_rules]]").count(),
            4,
            "live config should contain exactly four bootstrap rules"
        );

        let loaded = crate::config::load_with_test_sources(
            env,
            Some(resolved_paths.config_path.clone()),
            4242,
        )
        .expect("generated config should load through BobConfig");

        let snapshot = RulesetSnapshot::from_config(loaded.policy.clone())
            .expect("generated policy should validate");
        let configured_tools = snapshot
            .action_rules()
            .iter()
            .map(|rule| rule.tool.as_str())
            .collect::<Vec<_>>();
        assert_eq!(configured_tools, ["bash", "read", "write", "edit"]);
        assert!(
            snapshot
                .action_rules()
                .iter()
                .all(|rule| rule.arg_matchers.is_empty()),
            "bootstrap rules should allow the named tools without argument matchers"
        );

        let unsupported = PolicyEngine::evaluate_action(&snapshot, "fetch", &json!({}));
        assert!(
            !unsupported.allow,
            "tools outside the bootstrap set must remain denied"
        );
        assert!(
            !loaded.admin_sock_path.exists(),
            "filesystem-only materialization must not create the admin socket path"
        );
    }

    #[test]
    fn skips_existing_workspace_files_without_force_and_reports_them() {
        let temp = tempfile::tempdir().expect("tempdir should be created");
        let env = init_env(&temp);
        let resolved_paths = crate::config::resolve_init_paths_for_env(&env, 4242);
        let workspace = temp.path().join("workspace");
        fs::create_dir_all(&workspace).expect("workspace directory should be created");

        let existing_agents = workspace.join("AGENTS.md");
        fs::write(&existing_agents, "keep me\n").expect("existing AGENTS.md should be seeded");

        let report = materialize_workspace_with_paths(
            Path::new("workspace"),
            temp.path(),
            &resolved_paths,
            false,
        )
        .expect("workspace conflicts without live config should still succeed");

        assert_eq!(
            fs::read_to_string(&existing_agents).expect("AGENTS.md should remain readable"),
            "keep me\n",
            "existing generated workspace files must remain unchanged without force"
        );
        assert!(
            report.skipped_paths.contains(&existing_agents),
            "report should name skipped workspace files"
        );
    }

    #[test]
    fn leaves_existing_live_config_unchanged_and_returns_an_error_without_force() {
        let temp = tempfile::tempdir().expect("tempdir should be created");
        let env = init_env(&temp);
        let resolved_paths = crate::config::resolve_init_paths_for_env(&env, 4242);

        let config_parent = resolved_paths
            .config_path
            .parent()
            .expect("config path should have a parent");
        fs::create_dir_all(config_parent).expect("config parent should be created");
        fs::write(
            &resolved_paths.config_path,
            "skill_install_path = \"/keep/me\"\n",
        )
        .expect("existing live config should be seeded");

        let err = materialize_workspace_with_paths(
            Path::new("workspace"),
            temp.path(),
            &resolved_paths,
            false,
        )
        .expect_err("existing live config must block no-force materialization");

        assert!(
            matches!(err, ServiceError::InvalidRequest { ref detail } if detail.contains("live config already exists")),
            "expected live-config conflict error, got {err:?}"
        );
        assert_eq!(
            fs::read_to_string(&resolved_paths.config_path)
                .expect("live config should remain readable"),
            "skill_install_path = \"/keep/me\"\n",
            "live config must remain unchanged when force is absent"
        );
    }

    #[test]
    fn force_replaces_only_generated_files_and_preserves_git_directory_contents() {
        let temp = tempfile::tempdir().expect("tempdir should be created");
        let env = init_env(&temp);
        let resolved_paths = crate::config::resolve_init_paths_for_env(&env, 4242);
        let workspace = temp.path().join("workspace");
        let workspace_config_dir = workspace.join("config");
        let git_dir = workspace.join(".git");
        let untouched_note = workspace.join("notes.txt");

        fs::create_dir_all(&workspace_config_dir).expect("config dir should be created");
        fs::create_dir_all(&git_dir).expect(".git dir should be created");
        fs::write(workspace.join("AGENTS.md"), "old agents\n").expect("AGENTS should be seeded");
        fs::write(workspace.join("CLAUDE.md"), "old claude\n").expect("CLAUDE should be seeded");
        fs::write(
            workspace_config_dir.join("email-triage.toml"),
            "manager_address = \"old@example.invalid\"\n",
        )
        .expect("workspace config should be seeded");
        fs::write(&untouched_note, "do not touch\n").expect("note should be seeded");
        fs::write(git_dir.join("HEAD"), "ref: refs/heads/main\n").expect("HEAD should be seeded");

        let shared_skill = resolved_paths
            .skill_install_path
            .join("email-triage")
            .join("SKILL.md");
        fs::create_dir_all(
            shared_skill
                .parent()
                .expect("shared skill path should have a parent"),
        )
        .expect("shared skill parent should be created");
        fs::write(&shared_skill, "old skill\n").expect("shared skill should be seeded");

        let config_parent = resolved_paths
            .config_path
            .parent()
            .expect("config path should have a parent");
        fs::create_dir_all(config_parent).expect("config parent should be created");
        fs::write(
            &resolved_paths.config_path,
            "skill_install_path = \"/old/skills\"\n",
        )
        .expect("live config should be seeded");

        let report = materialize_workspace_with_paths(
            Path::new("workspace"),
            temp.path(),
            &resolved_paths,
            true,
        )
        .expect("force should replace generated files");

        assert_eq!(
            fs::read_to_string(workspace.join("AGENTS.md")).expect("AGENTS should exist"),
            CONTEXT_PLACEHOLDER
        );
        assert_eq!(
            fs::read_to_string(workspace.join("CLAUDE.md")).expect("CLAUDE should exist"),
            CONTEXT_PLACEHOLDER
        );
        assert_eq!(
            fs::read_to_string(workspace_config_dir.join("email-triage.toml"))
                .expect("workspace config should exist"),
            EMAIL_TRIAGE_TEMPLATE
        );
        assert_eq!(
            fs::read_to_string(&untouched_note).expect("note should remain readable"),
            "do not touch\n",
            "force must not modify non-generated workspace files"
        );
        assert_eq!(
            fs::read_to_string(git_dir.join("HEAD")).expect("HEAD should remain readable"),
            "ref: refs/heads/main\n",
            "force must never modify the target .git directory"
        );
        assert!(
            report.replaced_paths.contains(&workspace.join("AGENTS.md")),
            "report should record replaced generated workspace files"
        );
        assert!(
            report.replaced_paths.contains(&resolved_paths.config_path),
            "report should record the replaced live config"
        );
    }

    #[test]
    fn rejects_git_metadata_targets_before_any_filesystem_mutation() {
        for target in [Path::new(".git"), Path::new(".git/hooks")] {
            let temp = tempfile::tempdir().expect("tempdir should be created");
            let env = init_env(&temp);
            let resolved_paths = crate::config::resolve_init_paths_for_env(&env, 4242);
            let git_dir = temp.path().join(".git");
            let hooks_dir = git_dir.join("hooks");
            let head_path = git_dir.join("HEAD");
            let hook_path = hooks_dir.join("pre-commit");

            fs::create_dir_all(&hooks_dir).expect(".git/hooks should be created");
            fs::write(&head_path, "ref: refs/heads/main\n").expect("HEAD should be seeded");
            fs::write(&hook_path, "#!/bin/sh\necho keep\n").expect("hook should be seeded");
            fs::set_permissions(&git_dir, fs::Permissions::from_mode(0o755))
                .expect(".git permissions should be set");
            fs::set_permissions(&hooks_dir, fs::Permissions::from_mode(0o755))
                .expect("hooks permissions should be set");

            let git_mode_before = fs::metadata(&git_dir)
                .expect("stat .git before materialization")
                .permissions()
                .mode()
                & 0o777;
            let hooks_mode_before = fs::metadata(&hooks_dir)
                .expect("stat hooks before materialization")
                .permissions()
                .mode()
                & 0o777;

            let err = materialize_workspace_with_paths(target, temp.path(), &resolved_paths, true)
                .expect_err("workspace targets at or inside .git must be rejected");

            assert!(
                matches!(err, ServiceError::InvalidRequest { ref detail } if detail.contains(".git")),
                "expected .git safeguard error, got {err:?}"
            );
            assert_eq!(
                fs::read_to_string(&head_path).expect("HEAD should remain readable"),
                "ref: refs/heads/main\n",
                ".git contents must remain unchanged after rejection"
            );
            assert_eq!(
                fs::read_to_string(&hook_path).expect("hook should remain readable"),
                "#!/bin/sh\necho keep\n",
                "nested git metadata must remain unchanged after rejection"
            );
            assert_eq!(
                fs::metadata(&git_dir)
                    .expect("stat .git after materialization")
                    .permissions()
                    .mode()
                    & 0o777,
                git_mode_before,
                ".git directory permissions must remain unchanged after rejection"
            );
            assert_eq!(
                fs::metadata(&hooks_dir)
                    .expect("stat hooks after materialization")
                    .permissions()
                    .mode()
                    & 0o777,
                hooks_mode_before,
                "nested .git directory permissions must remain unchanged after rejection"
            );
            assert!(
                !resolved_paths.skill_install_path.exists(),
                "shared skill install path must not be created when the workspace target is invalid"
            );
            assert!(
                !resolved_paths.config_path.exists(),
                "live config must not be created when the workspace target is invalid"
            );
        }
    }
}
