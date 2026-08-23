use std::{
    fs,
    path::{Component, Path, PathBuf},
};

use bob_core::error::{ServiceError, ServiceResult};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BoardOperation {
    Read,
    Write,
    Move,
}

pub fn resolve_board_path(
    current_dir: &Path,
    explicit_override: Option<&Path>,
    env_override: Option<&Path>,
    operation: BoardOperation,
) -> ServiceResult<PathBuf> {
    let current_dir = absolute_path_from_base(
        current_dir,
        &std::env::current_dir().map_err(|err| ServiceError::InvalidRequest {
            detail: format!("failed to resolve process working directory: {err}"),
        })?,
    );

    let candidate = if let Some(path) = explicit_override {
        validate_override_path(path, "explicit board override")?;
        absolute_path_from_base(path, &current_dir)
    } else if let Some(path) = env_override {
        validate_override_path(path, "TASKS_DIR")?;
        absolute_path_from_base(path, &current_dir)
    } else {
        find_nearest_board(&current_dir).unwrap_or_else(|| current_dir.join("tasks"))
    };

    match fs::metadata(&candidate) {
        Ok(metadata) => {
            if metadata.is_dir() {
                Ok(candidate)
            } else {
                Err(ServiceError::InvalidRequest {
                    detail: format!(
                        "task board path is not a directory: {}",
                        candidate.display()
                    ),
                })
            }
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => match operation {
            BoardOperation::Write => {
                create_board_directory(&candidate)?;
                Ok(candidate)
            }
            BoardOperation::Read | BoardOperation::Move => Err(ServiceError::InvalidRequest {
                detail: format!(
                    "no task board found while searching upward from {}; expected {}",
                    current_dir.display(),
                    candidate.display()
                ),
            }),
        },
        Err(err) => Err(ServiceError::Persistence {
            detail: format!(
                "failed to inspect task board path {}: {err}",
                candidate.display()
            ),
        }),
    }
}

fn validate_override_path(path: &Path, label: &str) -> ServiceResult<()> {
    if path.as_os_str().is_empty() {
        return Err(ServiceError::InvalidRequest {
            detail: format!("{label} must not be empty"),
        });
    }

    Ok(())
}

fn find_nearest_board(current_dir: &Path) -> Option<PathBuf> {
    let mut search_dir = Some(current_dir);
    while let Some(dir) = search_dir {
        let candidate = dir.join("tasks");
        if candidate.is_dir() {
            return Some(candidate);
        }
        search_dir = dir.parent();
    }

    None
}

fn absolute_path_from_base(path: &Path, base: &Path) -> PathBuf {
    normalize_path(if path.is_absolute() {
        path.to_path_buf()
    } else {
        base.join(path)
    })
}

fn normalize_path(path: PathBuf) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            Component::Normal(segment) => normalized.push(segment),
            Component::RootDir => normalized.push(component.as_os_str()),
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
        }
    }

    normalized
}

fn create_board_directory(path: &Path) -> ServiceResult<()> {
    let mut missing = Vec::new();
    let mut cursor = path;
    loop {
        match fs::metadata(cursor) {
            Ok(metadata) => {
                if !metadata.is_dir() {
                    return Err(ServiceError::InvalidRequest {
                        detail: format!("task board path is not a directory: {}", cursor.display()),
                    });
                }
                break;
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                missing.push(cursor.to_path_buf());
                cursor = cursor
                    .parent()
                    .ok_or_else(|| ServiceError::InvalidRequest {
                        detail: format!(
                            "task board path has no parent directory: {}",
                            path.display()
                        ),
                    })?;
            }
            Err(err) => {
                return Err(ServiceError::Persistence {
                    detail: format!(
                        "failed to inspect task board path {}: {err}",
                        cursor.display()
                    ),
                });
            }
        }
    }

    for dir in missing.iter().rev() {
        fs::create_dir(dir).map_err(|err| ServiceError::Persistence {
            detail: format!(
                "failed to create task board directory {}: {err}",
                dir.display()
            ),
        })?;
        set_owner_only_mode(dir)?;
    }

    Ok(())
}

#[cfg(unix)]
fn set_owner_only_mode(path: &Path) -> ServiceResult<()> {
    use std::os::unix::fs::PermissionsExt;

    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|err| {
        ServiceError::Persistence {
            detail: format!(
                "failed to set task board directory mode on {}: {err}",
                path.display()
            ),
        }
    })
}

#[cfg(not(unix))]
fn set_owner_only_mode(_path: &Path) -> ServiceResult<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::{fs, path::PathBuf};

    use super::{resolve_board_path, BoardOperation};

    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    fn path_segments(path: &PathBuf) -> Vec<String> {
        path.iter()
            .map(|segment| segment.to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn resolve_board_path_prefers_explicit_override_over_environment_and_search() {
        let temp = tempfile::tempdir().expect("temp dir");
        let current_dir = temp.path().join("workspace").join("project");
        let searched_board = temp.path().join("workspace").join("tasks");
        let env_board = temp.path().join("env-board");
        let explicit_board = temp.path().join("explicit-board");
        fs::create_dir_all(&current_dir).expect("create current dir");
        fs::create_dir_all(&searched_board).expect("create searched board");
        fs::create_dir_all(&env_board).expect("create env board");
        fs::create_dir_all(&explicit_board).expect("create explicit board");

        let resolved = resolve_board_path(
            &current_dir,
            Some(&explicit_board),
            Some(&env_board),
            BoardOperation::Read,
        )
        .expect("explicit board should resolve");

        assert_eq!(resolved, explicit_board);
    }

    #[test]
    fn resolve_board_path_uses_environment_when_no_explicit_override_is_set() {
        let temp = tempfile::tempdir().expect("temp dir");
        let current_dir = temp.path().join("workspace").join("project");
        let searched_board = temp.path().join("workspace").join("tasks");
        let env_board = temp.path().join("env-board");
        fs::create_dir_all(&current_dir).expect("create current dir");
        fs::create_dir_all(&searched_board).expect("create searched board");
        fs::create_dir_all(&env_board).expect("create env board");

        let resolved =
            resolve_board_path(&current_dir, None, Some(&env_board), BoardOperation::Read)
                .expect("env board should resolve");

        assert_eq!(resolved, env_board);
    }

    #[test]
    fn resolve_board_path_finds_nearest_ancestor_tasks_directory() {
        let temp = tempfile::tempdir().expect("temp dir");
        let workspace_board = temp.path().join("workspace").join("tasks");
        let project_board = temp.path().join("workspace").join("project").join("tasks");
        let current_dir = temp.path().join("workspace").join("project").join("src");
        fs::create_dir_all(&workspace_board).expect("create workspace board");
        fs::create_dir_all(&project_board).expect("create project board");
        fs::create_dir_all(&current_dir).expect("create current dir");

        let resolved = resolve_board_path(&current_dir, None, None, BoardOperation::Read)
            .expect("ancestor board should resolve");

        assert_eq!(resolved, project_board);
    }

    #[test]
    fn resolve_board_path_makes_relative_paths_absolute_before_returning() {
        let temp = tempfile::tempdir().expect("temp dir");
        let current_dir = temp.path().join("workspace").join("project");
        let relative_board = PathBuf::from("custom").join("tasks");
        let expected = current_dir.join(&relative_board);
        fs::create_dir_all(&current_dir).expect("create current dir");
        fs::create_dir_all(&expected).expect("create board");

        let resolved = resolve_board_path(
            &current_dir,
            Some(relative_board.as_path()),
            None,
            BoardOperation::Read,
        )
        .expect("relative board should resolve");

        assert_eq!(resolved, expected);
        assert!(
            resolved.is_absolute(),
            "resolver must return an absolute path"
        );
    }

    #[test]
    fn resolve_board_path_creates_missing_board_for_write_operations() {
        let temp = tempfile::tempdir().expect("temp dir");
        let current_dir = temp.path().join("workspace");
        fs::create_dir_all(&current_dir).expect("create current dir");

        let resolved = resolve_board_path(&current_dir, None, None, BoardOperation::Write)
            .expect("write should create board");

        assert_eq!(resolved, current_dir.join("tasks"));
        assert!(resolved.is_dir(), "write should create the board directory");

        #[cfg(unix)]
        {
            let mode = fs::metadata(&resolved)
                .expect("metadata")
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o700, "new board mode should be 0700");
        }
    }

    #[test]
    fn resolve_board_path_fails_for_missing_move_board_and_names_search_start() {
        let temp = tempfile::tempdir().expect("temp dir");
        let current_dir = temp.path().join("workspace").join("project");
        fs::create_dir_all(&current_dir).expect("create current dir");

        let error = resolve_board_path(&current_dir, None, None, BoardOperation::Move)
            .expect_err("move should fail when no board exists");

        let detail = match error {
            bob_core::error::ServiceError::InvalidRequest { detail } => detail,
            other => panic!("expected invalid request error, got {other:?}"),
        };
        assert!(
            detail.contains(&current_dir.display().to_string()),
            "error should name search start directory: {detail}"
        );
        assert!(
            detail.contains("tasks"),
            "error should mention the task board directory: {detail}"
        );
    }

    #[test]
    #[cfg(unix)]
    fn resolve_board_path_leaves_existing_board_permissions_unchanged() {
        let temp = tempfile::tempdir().expect("temp dir");
        let current_dir = temp.path().join("workspace");
        let existing_board = current_dir.join("tasks");
        fs::create_dir_all(&existing_board).expect("create existing board");
        fs::set_permissions(&existing_board, fs::Permissions::from_mode(0o755))
            .expect("set existing mode");

        let resolved = resolve_board_path(&current_dir, None, None, BoardOperation::Write)
            .expect("existing board should resolve");

        let mode = fs::metadata(&resolved)
            .expect("metadata")
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o755, "existing board mode should stay unchanged");
    }

    #[test]
    fn resolve_board_path_searches_for_tasks_directory_name() {
        let temp = tempfile::tempdir().expect("temp dir");
        let current_dir = temp.path().join("workspace").join("project");
        fs::create_dir_all(&current_dir).expect("create current dir");

        let resolved = resolve_board_path(&current_dir, None, None, BoardOperation::Write)
            .expect("write should resolve default board path");

        let segments = path_segments(&resolved);
        assert_eq!(segments.last().expect("board path segment"), "tasks");
    }
}
