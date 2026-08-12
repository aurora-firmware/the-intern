use std::{
    io::{self, Write},
    path::Path,
};

use bob_core::error::ServiceResult;

use crate::init_materializer::{materialize_workspace, MaterializationReport};

pub(super) fn run(path: &str, force: bool) -> ServiceResult<()> {
    let mut out = io::stdout();
    run_with_materializer(path, force, &mut out, |workspace_path, force| {
        materialize_workspace(Path::new(workspace_path), force)
    })
}

fn run_with_materializer(
    path: &str,
    force: bool,
    out: &mut impl Write,
    mut materialize: impl FnMut(&str, bool) -> ServiceResult<MaterializationReport>,
) -> ServiceResult<()> {
    let report = materialize(path, force)?;
    write_report(out, &report)
}

fn write_report(out: &mut impl Write, report: &MaterializationReport) -> ServiceResult<()> {
    writeln!(out, "initialized bob workspace")
        .and_then(|_| writeln!(out, "workspace: {}", report.workspace_path.display()))
        .and_then(|_| writeln!(out, "live config: {}", report.config_path.display()))
        .and_then(|_| {
            writeln!(
                out,
                "shared skills: {}",
                report.skill_install_path.display()
            )
        })
        .map_err(write_error)?;

    write_path_section(out, "created", &report.created_paths)?;
    write_path_section(out, "replaced", &report.replaced_paths)?;
    write_path_section(out, "skipped existing", &report.skipped_paths)?;

    writeln!(out)
        .and_then(|_| writeln!(out, "Warning: the generated bootstrap policy grants broad authority."))
        .and_then(|_| {
            writeln!(
                out,
                "It permits arbitrary shell commands and unrestricted reads, writes, and edits available to bob's uid for these tools:"
            )
        })
        .and_then(|_| writeln!(out, "- bash"))
        .and_then(|_| writeln!(out, "- read"))
        .and_then(|_| writeln!(out, "- write"))
        .and_then(|_| writeln!(out, "- edit"))
        .and_then(|_| {
            writeln!(
                out,
                "Review and narrow {} before relying on it as a security control.",
                report.config_path.display()
            )
        })
        .and_then(|_| writeln!(out))
        .and_then(|_| writeln!(out, "Next steps:"))
        .and_then(|_| {
            writeln!(
                out,
                "1. set manager_address in {}",
                report
                    .workspace_path
                    .join("config")
                    .join("email-triage.toml")
                    .display()
            )
        })
        .and_then(|_| writeln!(out, "2. start bob with `bob serve`"))
        .and_then(|_| {
            writeln!(
                out,
                "3. review and narrow {}",
                report.config_path.display()
            )
        })
        .map_err(write_error)
}

fn write_path_section(
    out: &mut impl Write,
    title: &str,
    paths: &[std::path::PathBuf],
) -> ServiceResult<()> {
    if paths.is_empty() {
        return Ok(());
    }

    writeln!(out, "{title}:").map_err(write_error)?;
    for path in paths {
        writeln!(out, "  {}", path.display()).map_err(write_error)?;
    }
    Ok(())
}

fn write_error(err: io::Error) -> bob_core::error::ServiceError {
    crate::cli::commands::invalid_request_error(format!("failed to write init output: {err}"))
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use bob_core::error::{ServiceError, ServiceResult};

    use crate::init_materializer::MaterializationReport;

    #[test]
    fn init_success_output_lists_paths_warning_and_next_steps() {
        let workspace = PathBuf::from("/tmp/project/workspace");
        let config_path = PathBuf::from("/tmp/xdg-config/bob/config.toml");
        let skill_install_path = PathBuf::from("/tmp/xdg-data/bob/skills");
        let mut out = Vec::new();

        let report = MaterializationReport {
            workspace_path: workspace.clone(),
            config_path: config_path.clone(),
            skill_install_path: skill_install_path.clone(),
            created_paths: vec![
                workspace.join("AGENTS.md"),
                workspace.join("config").join("email-triage.toml"),
                config_path.clone(),
            ],
            replaced_paths: vec![skill_install_path.join("email-triage").join("SKILL.md")],
            skipped_paths: vec![workspace.join("CLAUDE.md")],
        };

        run_with_materializer("./workspace", true, &mut out, move |path, force| {
            assert_eq!(path, "./workspace");
            assert!(force);
            Ok(report.clone())
        })
        .expect("init should render success output");

        let text = String::from_utf8(out).expect("utf8 output");
        for expected in [
            "workspace: /tmp/project/workspace",
            "live config: /tmp/xdg-config/bob/config.toml",
            "shared skills: /tmp/xdg-data/bob/skills",
            "created:",
            "/tmp/project/workspace/AGENTS.md",
            "replaced:",
            "/tmp/xdg-data/bob/skills/email-triage/SKILL.md",
            "skipped existing:",
            "/tmp/project/workspace/CLAUDE.md",
            "Warning: the generated bootstrap policy grants broad authority.",
            "bash",
            "read",
            "write",
            "edit",
            "permits arbitrary shell commands",
            "set manager_address in /tmp/project/workspace/config/email-triage.toml",
            "start bob with `bob serve`",
            "review and narrow /tmp/xdg-config/bob/config.toml",
        ] {
            assert!(
                text.contains(expected),
                "expected output to contain {expected:?}, got:\n{text}"
            );
        }
    }

    #[test]
    fn init_returns_existing_live_config_conflict_with_path() {
        let mut out = Vec::new();

        let error = run_with_materializer("workspace", false, &mut out, |_path, _force| {
            Err(ServiceError::InvalidRequest {
                detail: "live config already exists at /tmp/xdg-config/bob/config.toml; rerun with --force to replace it".to_string(),
            })
        })
        .expect_err("conflicting live config should fail");

        assert!(matches!(
            error,
            ServiceError::InvalidRequest { ref detail }
                if detail.contains("/tmp/xdg-config/bob/config.toml")
        ));
        assert!(
            out.is_empty(),
            "errors should not emit partial success output"
        );
    }

    fn run_with_materializer(
        path: &str,
        force: bool,
        out: &mut Vec<u8>,
        materialize: impl FnMut(&str, bool) -> ServiceResult<MaterializationReport>,
    ) -> ServiceResult<()> {
        super::run_with_materializer(path, force, out, materialize)
    }
}
