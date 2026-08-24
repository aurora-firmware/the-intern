use std::{
    env, io,
    io::Write,
    path::{Path, PathBuf},
};

use bob_core::error::ServiceResult;
use chrono::{Local, NaiveDate};
use serde::Serialize;
use serde_json::json;

use crate::task_board::{
    board::{resolve_board_path, BoardOperation},
    store::{CreateTask, TaskFile, TaskStatus, TaskStore},
};

use super::{invalid_request_error, write_json_line};

const TASKS_DIR_ENV_VAR: &str = "TASKS_DIR";
const DATE_FORMAT: &str = "%Y-%m-%d";

#[derive(Debug, Serialize, PartialEq, Eq)]
struct CreatedTaskOutput {
    id: String,
    status: String,
    path: String,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
struct ShownTaskOutput {
    id: String,
    path: String,
    title: String,
    status: String,
    content: String,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
struct TaskPathOutput {
    id: String,
    path: String,
}

pub(super) fn run_new(
    json_output: bool,
    board_override: Option<&str>,
    title: &str,
    status: &str,
    created_date: Option<&str>,
    description: Option<&str>,
    definition_of_done: &[String],
) -> ServiceResult<()> {
    let current_dir = env::current_dir()
        .map_err(|err| invalid_request_error(format!("current directory unavailable: {err}")))?;
    let env_override = env::var_os(TASKS_DIR_ENV_VAR).map(PathBuf::from);
    let mut out = io::stdout();
    run_new_with_context(
        json_output,
        board_override.map(Path::new),
        title,
        status,
        created_date,
        description,
        definition_of_done,
        Local::now().date_naive(),
        &current_dir,
        env_override.as_deref(),
        &mut out,
    )
}

pub(super) fn run_show(
    json_output: bool,
    board_override: Option<&str>,
    id: &str,
    path_only: bool,
) -> ServiceResult<()> {
    let current_dir = env::current_dir()
        .map_err(|err| invalid_request_error(format!("current directory unavailable: {err}")))?;
    let env_override = env::var_os(TASKS_DIR_ENV_VAR).map(PathBuf::from);
    let mut out = io::stdout();
    run_show_with_context(
        json_output,
        board_override.map(Path::new),
        id,
        path_only,
        &current_dir,
        env_override.as_deref(),
        &mut out,
    )
}

fn run_new_with_context(
    json_output: bool,
    board_override: Option<&Path>,
    title: &str,
    status: &str,
    created_date: Option<&str>,
    description: Option<&str>,
    definition_of_done: &[String],
    today: NaiveDate,
    current_dir: &Path,
    env_override: Option<&Path>,
    out: &mut impl Write,
) -> ServiceResult<()> {
    validate_title(title)?;
    let creation_date = parse_creation_date(created_date, today)?;
    TaskStatus::parse(status)?;

    let request = CreateTask {
        title: title.to_owned(),
        status: status.to_owned(),
        creation_date,
        description: description.unwrap_or_default().to_owned(),
        definition_of_done: definition_of_done.to_vec(),
    };

    let board_path = resolve_board_path_for_operation(
        current_dir,
        board_override,
        env_override,
        BoardOperation::Write,
    )?;
    let store = TaskStore::new(board_path);
    let created = store.create_task(&request)?;
    write_created_task(out, json_output, &created)
}

fn run_show_with_context(
    json_output: bool,
    board_override: Option<&Path>,
    id: &str,
    path_only: bool,
    current_dir: &Path,
    env_override: Option<&Path>,
    out: &mut impl Write,
) -> ServiceResult<()> {
    if id.trim().is_empty() {
        return Err(invalid_request_error("task identifier must not be empty"));
    }

    let board_path = resolve_board_path_for_operation(
        current_dir,
        board_override,
        env_override,
        BoardOperation::Read,
    )?;
    let store = TaskStore::new(&board_path);
    let resolved_id = store.resolve_partial_identifier(id)?;
    let task = store.read_task(&board_path.join(format!("{resolved_id}.md")))?;
    write_shown_task(out, json_output, path_only, &task)
}

fn resolve_board_path_for_operation(
    current_dir: &Path,
    board_override: Option<&Path>,
    env_override: Option<&Path>,
    operation: BoardOperation,
) -> ServiceResult<PathBuf> {
    resolve_board_path(current_dir, board_override, env_override, operation)
}

fn validate_title(title: &str) -> ServiceResult<()> {
    if title.trim().is_empty() {
        return Err(invalid_request_error("task title must not be empty"));
    }
    Ok(())
}

fn parse_creation_date(value: Option<&str>, today: NaiveDate) -> ServiceResult<NaiveDate> {
    match value {
        Some(value) => NaiveDate::parse_from_str(value, DATE_FORMAT).map_err(|err| {
            invalid_request_error(format!(
                "invalid creation date {value:?}; expected YYYY-MM-DD: {err}"
            ))
        }),
        None => Ok(today),
    }
}

fn write_created_task(
    out: &mut impl Write,
    json_output: bool,
    task: &TaskFile,
) -> ServiceResult<()> {
    let response = CreatedTaskOutput {
        id: task.identity.clone(),
        status: task.status.to_string(),
        path: task.path.display().to_string(),
    };

    if json_output {
        return write_json_line(out, &json!(response));
    }

    writeln!(out, "created task: {}", response.id)
        .and_then(|_| writeln!(out, "status: {}", response.status))
        .and_then(|_| writeln!(out, "path: {}", response.path))
        .map_err(|err| invalid_request_error(format!("failed to write task output: {err}")))
}

fn write_shown_task(
    out: &mut impl Write,
    json_output: bool,
    path_only: bool,
    task: &TaskFile,
) -> ServiceResult<()> {
    if path_only {
        let response = TaskPathOutput {
            id: task.identity.clone(),
            path: task.path.display().to_string(),
        };
        if json_output {
            return write_json_line(out, &json!(response));
        }
        return writeln!(out, "{}", response.path)
            .map_err(|err| invalid_request_error(format!("failed to write task output: {err}")));
    }

    if json_output {
        let response = ShownTaskOutput {
            id: task.identity.clone(),
            path: task.path.display().to_string(),
            title: task.title.clone(),
            status: task.status.to_string(),
            content: task.content.clone(),
        };
        return write_json_line(out, &json!(response));
    }

    out.write_all(task.content.as_bytes())
        .map_err(|err| invalid_request_error(format!("failed to write task output: {err}")))
}

#[cfg(test)]
mod tests {
    use std::fs;

    use serde_json::Value;

    use super::{run_new_with_context, run_show_with_context, DATE_FORMAT};
    use crate::task_board::store::{CreateTask, TaskStore};
    use chrono::NaiveDate;

    fn created_date() -> NaiveDate {
        NaiveDate::parse_from_str("2026-08-24", DATE_FORMAT).expect("valid date")
    }

    fn done_items(items: &[&str]) -> Vec<String> {
        items.iter().map(|item| (*item).to_owned()).collect()
    }

    fn seed_task(
        board: &std::path::Path,
        title: &str,
        status: &str,
    ) -> crate::task_board::store::TaskFile {
        TaskStore::new(board)
            .create_task(&CreateTask {
                title: title.to_owned(),
                status: status.to_owned(),
                creation_date: created_date(),
                description: "Describe the work.".to_owned(),
                definition_of_done: done_items(&["observable outcome"]),
            })
            .expect("seed task")
    }

    #[test]
    fn task_new_creates_file_and_reports_identity_status_and_path() {
        let temp = tempfile::tempdir().expect("temp dir");
        let cwd = temp.path().join("workspace").join("project");
        fs::create_dir_all(&cwd).expect("cwd");
        let mut out = Vec::new();

        run_new_with_context(
            false,
            None,
            "Fix release notes",
            "doing",
            Some("2026-08-24"),
            Some("Update the shipping section."),
            &done_items(&["Docs updated", "Review complete"]),
            created_date(),
            &cwd,
            None,
            &mut out,
        )
        .expect("task new succeeds");

        let text = String::from_utf8(out).expect("utf8");
        assert!(text.contains("created task: 2026-08-24-fix-release-notes"));
        assert!(text.contains("status: doing"));
        assert!(text.contains("path: "));

        let created_path = cwd.join("tasks").join("2026-08-24-fix-release-notes.md");
        let content = fs::read_to_string(&created_path).expect("task file");
        for expected in [
            "title: Fix release notes",
            "status: doing",
            "## Description",
            "Update the shipping section.",
            "- [ ] Docs updated",
            "- [ ] Review complete",
            "## Log",
        ] {
            assert!(
                content.contains(expected),
                "missing {expected:?} in:\n{content}"
            );
        }
    }

    #[test]
    fn task_new_json_output_contains_identity_status_and_path() {
        let temp = tempfile::tempdir().expect("temp dir");
        let cwd = temp.path().join("workspace");
        fs::create_dir_all(&cwd).expect("cwd");
        let mut out = Vec::new();

        run_new_with_context(
            true,
            None,
            "Inspect logs",
            "todo",
            None,
            None,
            &[] as &[String],
            created_date(),
            &cwd,
            None,
            &mut out,
        )
        .expect("task new succeeds");

        let output = serde_json::from_slice::<Value>(&out).expect("json");
        assert_eq!(output["id"], "2026-08-24-inspect-logs");
        assert_eq!(output["status"], "todo");
        assert_eq!(
            output["path"],
            cwd.join("tasks")
                .join("2026-08-24-inspect-logs.md")
                .display()
                .to_string()
        );
    }

    #[test]
    fn task_new_rejects_empty_title_before_creating_the_board() {
        let temp = tempfile::tempdir().expect("temp dir");
        let cwd = temp.path().join("workspace");
        fs::create_dir_all(&cwd).expect("cwd");
        let mut out = Vec::new();

        let error = run_new_with_context(
            false,
            None,
            "   ",
            "todo",
            None,
            None,
            &[] as &[String],
            created_date(),
            &cwd,
            None,
            &mut out,
        )
        .expect_err("empty title must fail");

        assert!(
            matches!(error, bob_core::error::ServiceError::InvalidRequest { ref detail } if detail == "task title must not be empty")
        );
        assert!(
            !cwd.join("tasks").exists(),
            "invalid input must fail before touching the filesystem"
        );
    }

    #[test]
    fn task_new_rejects_invalid_status_before_creating_the_board() {
        let temp = tempfile::tempdir().expect("temp dir");
        let cwd = temp.path().join("workspace");
        fs::create_dir_all(&cwd).expect("cwd");
        let mut out = Vec::new();

        let error = run_new_with_context(
            false,
            None,
            "Inspect logs",
            "waiting",
            None,
            None,
            &[] as &[String],
            created_date(),
            &cwd,
            None,
            &mut out,
        )
        .expect_err("invalid status must fail");

        assert!(matches!(
            error,
            bob_core::error::ServiceError::InvalidRequest { ref detail }
                if detail.contains("invalid task status")
        ));
        assert!(
            !cwd.join("tasks").exists(),
            "invalid input must fail before touching the filesystem"
        );
    }

    #[test]
    fn task_new_rejects_malformed_creation_date_before_creating_the_board() {
        let temp = tempfile::tempdir().expect("temp dir");
        let cwd = temp.path().join("workspace");
        fs::create_dir_all(&cwd).expect("cwd");
        let mut out = Vec::new();

        let error = run_new_with_context(
            false,
            None,
            "Inspect logs",
            "todo",
            Some("24-08-2026"),
            None,
            &[] as &[String],
            created_date(),
            &cwd,
            None,
            &mut out,
        )
        .expect_err("invalid date must fail");

        assert!(matches!(
            error,
            bob_core::error::ServiceError::InvalidRequest { ref detail }
                if detail.contains("expected YYYY-MM-DD")
        ));
        assert!(
            !cwd.join("tasks").exists(),
            "invalid input must fail before touching the filesystem"
        );
    }

    #[test]
    fn task_show_prints_task_file_contents_for_a_partial_identifier() {
        let temp = tempfile::tempdir().expect("temp dir");
        let board = temp.path().join("workspace").join("tasks");
        let cwd = temp.path().join("workspace").join("src");
        fs::create_dir_all(&board).expect("board");
        fs::create_dir_all(&cwd).expect("cwd");
        let task = seed_task(&board, "Fix release notes", "doing");
        let mut out = Vec::new();

        run_show_with_context(false, None, "2026-08-24-fix", false, &cwd, None, &mut out)
            .expect("task show succeeds");

        assert_eq!(String::from_utf8(out).expect("utf8"), task.content);
    }

    #[test]
    fn task_show_path_flag_outputs_only_the_resolved_path() {
        let temp = tempfile::tempdir().expect("temp dir");
        let board = temp.path().join("board");
        let cwd = temp.path().join("workspace");
        fs::create_dir_all(&board).expect("board");
        fs::create_dir_all(&cwd).expect("cwd");
        let task = seed_task(&board, "Fix release notes", "doing");
        let mut out = Vec::new();

        run_show_with_context(
            false,
            Some(board.as_path()),
            &task.identity,
            true,
            &cwd,
            None,
            &mut out,
        )
        .expect("task show succeeds");

        assert_eq!(
            String::from_utf8(out).expect("utf8"),
            format!("{}\n", task.path.display())
        );
    }

    #[test]
    fn task_show_json_output_contains_path_and_task_content() {
        let temp = tempfile::tempdir().expect("temp dir");
        let board = temp.path().join("workspace").join("tasks");
        let cwd = temp.path().join("workspace");
        fs::create_dir_all(&board).expect("board");
        fs::create_dir_all(&cwd).expect("cwd");
        let task = seed_task(&board, "Inspect logs", "todo");
        let mut out = Vec::new();

        run_show_with_context(true, None, &task.identity, false, &cwd, None, &mut out)
            .expect("task show succeeds");

        let output = serde_json::from_slice::<Value>(&out).expect("json");
        assert_eq!(output["id"], task.identity);
        assert_eq!(output["path"], task.path.display().to_string());
        assert_eq!(output["title"], task.title);
        assert_eq!(output["status"], "todo");
        assert_eq!(output["content"], task.content);
    }
}
