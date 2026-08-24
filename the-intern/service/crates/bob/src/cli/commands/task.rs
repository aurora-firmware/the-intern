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

#[derive(Debug, Serialize, PartialEq, Eq)]
struct TaskSummary {
    id: String,
    title: String,
    status: String,
    path: String,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
struct ListedTasksOutput {
    tasks: Vec<TaskSummary>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
struct StatusChangedOutput {
    id: String,
    previous_status: String,
    status: String,
    path: String,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
struct NoteAddedOutput {
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

pub(super) fn run_list(
    json_output: bool,
    board_override: Option<&str>,
    statuses: &[String],
) -> ServiceResult<()> {
    let current_dir = env::current_dir()
        .map_err(|err| invalid_request_error(format!("current directory unavailable: {err}")))?;
    let env_override = env::var_os(TASKS_DIR_ENV_VAR).map(PathBuf::from);
    let mut out = io::stdout();
    run_list_with_context(
        json_output,
        board_override.map(Path::new),
        statuses,
        &current_dir,
        env_override.as_deref(),
        &mut out,
    )
}

pub(super) fn run_status(
    json_output: bool,
    board_override: Option<&str>,
    id: &str,
    status: &str,
    reason: Option<&str>,
) -> ServiceResult<()> {
    let current_dir = env::current_dir()
        .map_err(|err| invalid_request_error(format!("current directory unavailable: {err}")))?;
    let env_override = env::var_os(TASKS_DIR_ENV_VAR).map(PathBuf::from);
    let mut out = io::stdout();
    run_status_with_context(
        json_output,
        board_override.map(Path::new),
        id,
        status,
        reason,
        Local::now().date_naive(),
        &current_dir,
        env_override.as_deref(),
        &mut out,
    )
}

pub(super) fn run_note(
    json_output: bool,
    board_override: Option<&str>,
    id: &str,
    text: &str,
) -> ServiceResult<()> {
    let current_dir = env::current_dir()
        .map_err(|err| invalid_request_error(format!("current directory unavailable: {err}")))?;
    let env_override = env::var_os(TASKS_DIR_ENV_VAR).map(PathBuf::from);
    let mut out = io::stdout();
    run_note_with_context(
        json_output,
        board_override.map(Path::new),
        id,
        text,
        Local::now().date_naive(),
        &current_dir,
        env_override.as_deref(),
        &mut out,
    )
}

fn run_list_with_context(
    json_output: bool,
    board_override: Option<&Path>,
    statuses: &[String],
    current_dir: &Path,
    env_override: Option<&Path>,
    out: &mut impl Write,
) -> ServiceResult<()> {
    let filter = parse_status_filter(statuses)?;

    let board_path = resolve_board_path_for_operation(
        current_dir,
        board_override,
        env_override,
        BoardOperation::Read,
    )?;
    let store = TaskStore::new(&board_path);
    let tasks = store.list_tasks()?;

    let groups = group_tasks_by_status(&tasks, &filter);
    write_listed_tasks(out, json_output, &groups)
}

fn run_status_with_context(
    json_output: bool,
    board_override: Option<&Path>,
    id: &str,
    status: &str,
    reason: Option<&str>,
    today: NaiveDate,
    current_dir: &Path,
    env_override: Option<&Path>,
    out: &mut impl Write,
) -> ServiceResult<()> {
    if id.trim().is_empty() {
        return Err(invalid_request_error("task identifier must not be empty"));
    }
    let new_status = TaskStatus::parse(status)?;

    let board_path = resolve_board_path_for_operation(
        current_dir,
        board_override,
        env_override,
        BoardOperation::Move,
    )?;
    let store = TaskStore::new(&board_path);
    let resolved_id = store.resolve_partial_identifier(id)?;
    let path = board_path.join(format!("{resolved_id}.md"));

    let previous_status = store.read_task(&path)?.status;
    let entry = format_status_log_entry(previous_status, new_status, reason);
    let updated = store.apply_status_change(&path, new_status, today, &entry)?;

    write_status_changed(out, json_output, previous_status, &updated)
}

fn run_note_with_context(
    json_output: bool,
    board_override: Option<&Path>,
    id: &str,
    text: &str,
    today: NaiveDate,
    current_dir: &Path,
    env_override: Option<&Path>,
    out: &mut impl Write,
) -> ServiceResult<()> {
    if id.trim().is_empty() {
        return Err(invalid_request_error("task identifier must not be empty"));
    }
    if text.trim().is_empty() {
        return Err(invalid_request_error("note text must not be empty"));
    }

    let board_path = resolve_board_path_for_operation(
        current_dir,
        board_override,
        env_override,
        BoardOperation::Read,
    )?;
    let store = TaskStore::new(&board_path);
    let resolved_id = store.resolve_partial_identifier(id)?;
    let path = board_path.join(format!("{resolved_id}.md"));

    let updated = store.append_log_entry(&path, today, text)?;

    write_note_added(out, json_output, &updated)
}

fn parse_status_filter(statuses: &[String]) -> ServiceResult<Vec<TaskStatus>> {
    if statuses.is_empty() {
        return Ok(default_list_statuses());
    }

    statuses
        .iter()
        .map(|value| TaskStatus::parse(value))
        .collect()
}

fn default_list_statuses() -> Vec<TaskStatus> {
    vec![TaskStatus::Todo, TaskStatus::Doing, TaskStatus::Blocked]
}

fn canonical_status_order() -> Vec<TaskStatus> {
    vec![
        TaskStatus::Todo,
        TaskStatus::Doing,
        TaskStatus::Blocked,
        TaskStatus::Done,
    ]
}

fn group_tasks_by_status<'task>(
    tasks: &'task [TaskFile],
    filter: &[TaskStatus],
) -> Vec<(TaskStatus, Vec<&'task TaskFile>)> {
    canonical_status_order()
        .into_iter()
        .filter(|status| filter.contains(status))
        .map(|status| {
            let matching = tasks
                .iter()
                .filter(|task| task.status == status)
                .collect::<Vec<_>>();
            (status, matching)
        })
        .filter(|(_, matching)| !matching.is_empty())
        .collect()
}

fn format_status_log_entry(previous: TaskStatus, next: TaskStatus, reason: Option<&str>) -> String {
    match reason {
        Some(reason) if !reason.trim().is_empty() => {
            format!("Status changed from {previous} to {next}: {reason}")
        }
        _ => format!("Status changed from {previous} to {next}."),
    }
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
    if title.contains(['\n', '\r']) {
        return Err(invalid_request_error(
            "task title must not contain line breaks",
        ));
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

fn write_listed_tasks(
    out: &mut impl Write,
    json_output: bool,
    groups: &[(TaskStatus, Vec<&TaskFile>)],
) -> ServiceResult<()> {
    if json_output {
        let tasks = groups
            .iter()
            .flat_map(|(status, tasks)| {
                tasks.iter().map(move |task| TaskSummary {
                    id: task.identity.clone(),
                    title: task.title.clone(),
                    status: status.to_string(),
                    path: task.path.display().to_string(),
                })
            })
            .collect();
        return write_json_line(out, &json!(ListedTasksOutput { tasks }));
    }

    if groups.is_empty() {
        return write_output_line(out, "no tasks found");
    }

    for (status, tasks) in groups {
        write_output_line(out, format!("{status}:"))?;
        for task in tasks {
            write_output_line(out, format!("  {}  {}", task.identity, task.title))?;
        }
    }

    Ok(())
}

fn write_status_changed(
    out: &mut impl Write,
    json_output: bool,
    previous_status: TaskStatus,
    task: &TaskFile,
) -> ServiceResult<()> {
    let response = StatusChangedOutput {
        id: task.identity.clone(),
        previous_status: previous_status.to_string(),
        status: task.status.to_string(),
        path: task.path.display().to_string(),
    };

    if json_output {
        return write_json_line(out, &json!(response));
    }

    write_output_line(out, format!("task: {}", response.id))?;
    write_output_line(
        out,
        format!(
            "status: {} -> {}",
            response.previous_status, response.status
        ),
    )?;
    write_output_line(out, format!("path: {}", response.path))
}

fn write_note_added(out: &mut impl Write, json_output: bool, task: &TaskFile) -> ServiceResult<()> {
    let response = NoteAddedOutput {
        id: task.identity.clone(),
        path: task.path.display().to_string(),
    };

    if json_output {
        return write_json_line(out, &json!(response));
    }

    write_output_line(out, format!("note added to task: {}", response.id))?;
    write_output_line(out, format!("path: {}", response.path))
}

fn write_output_line(out: &mut impl Write, line: impl AsRef<str>) -> ServiceResult<()> {
    writeln!(out, "{}", line.as_ref())
        .map_err(|err| invalid_request_error(format!("failed to write task output: {err}")))
}

#[cfg(test)]
mod tests {
    use std::fs;

    use serde_json::Value;

    use super::{
        run_list_with_context, run_new_with_context, run_note_with_context, run_show_with_context,
        run_status_with_context, DATE_FORMAT,
    };
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
    fn task_new_rejects_multiline_title_before_creating_the_board() {
        let temp = tempfile::tempdir().expect("temp dir");
        let cwd = temp.path().join("workspace");
        fs::create_dir_all(&cwd).expect("cwd");
        let mut out = Vec::new();

        let error = run_new_with_context(
            false,
            None,
            "first\nsecond",
            "todo",
            None,
            None,
            &[] as &[String],
            created_date(),
            &cwd,
            None,
            &mut out,
        )
        .expect_err("multiline title must fail");

        assert!(
            matches!(error, bob_core::error::ServiceError::InvalidRequest { ref detail } if detail == "task title must not contain line breaks")
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

    #[test]
    fn task_list_hides_done_tasks_by_default_and_groups_by_status() {
        let temp = tempfile::tempdir().expect("temp dir");
        let board = temp.path().join("tasks");
        let cwd = temp.path().to_path_buf();
        fs::create_dir_all(&board).expect("board");
        seed_task(&board, "Todo item", "todo");
        seed_task(&board, "Doing item", "doing");
        seed_task(&board, "Blocked item", "blocked");
        seed_task(&board, "Done item", "done");
        let mut out = Vec::new();

        run_list_with_context(false, None, &[], &cwd, None, &mut out).expect("list succeeds");

        let text = String::from_utf8(out).expect("utf8");
        assert!(text.contains("todo:"), "missing todo group: {text}");
        assert!(text.contains("doing:"), "missing doing group: {text}");
        assert!(text.contains("blocked:"), "missing blocked group: {text}");
        assert!(!text.contains("done:"), "done group must be hidden: {text}");
        assert!(text.contains("Todo item"), "text: {text}");
        assert!(!text.contains("Done item"), "text: {text}");
    }

    #[test]
    fn task_list_with_status_filter_shows_requested_statuses_including_done() {
        let temp = tempfile::tempdir().expect("temp dir");
        let board = temp.path().join("tasks");
        let cwd = temp.path().to_path_buf();
        fs::create_dir_all(&board).expect("board");
        seed_task(&board, "Todo item", "todo");
        seed_task(&board, "Done item", "done");
        let mut out = Vec::new();

        run_list_with_context(false, None, &["done".to_owned()], &cwd, None, &mut out)
            .expect("list succeeds");

        let text = String::from_utf8(out).expect("utf8");
        assert!(text.contains("done:"), "missing done group: {text}");
        assert!(text.contains("Done item"), "text: {text}");
        assert!(
            !text.contains("todo:"),
            "todo group must be excluded: {text}"
        );
        assert!(!text.contains("Todo item"), "text: {text}");
    }

    #[test]
    fn task_list_supports_repeatable_status_filters() {
        let temp = tempfile::tempdir().expect("temp dir");
        let board = temp.path().join("tasks");
        let cwd = temp.path().to_path_buf();
        fs::create_dir_all(&board).expect("board");
        seed_task(&board, "Blocked item", "blocked");
        seed_task(&board, "Done item", "done");
        seed_task(&board, "Todo item", "todo");
        let mut out = Vec::new();

        run_list_with_context(
            false,
            None,
            &["blocked".to_owned(), "done".to_owned()],
            &cwd,
            None,
            &mut out,
        )
        .expect("list succeeds");

        let text = String::from_utf8(out).expect("utf8");
        assert!(text.contains("Blocked item"), "text: {text}");
        assert!(text.contains("Done item"), "text: {text}");
        assert!(!text.contains("Todo item"), "text: {text}");
    }

    #[test]
    fn task_list_json_output_reports_status_and_path_for_each_task() {
        let temp = tempfile::tempdir().expect("temp dir");
        let board = temp.path().join("tasks");
        let cwd = temp.path().to_path_buf();
        fs::create_dir_all(&board).expect("board");
        let task = seed_task(&board, "Todo item", "todo");
        let mut out = Vec::new();

        run_list_with_context(true, None, &[], &cwd, None, &mut out).expect("list succeeds");

        let output = serde_json::from_slice::<Value>(&out).expect("json");
        let tasks = output["tasks"].as_array().expect("tasks array");
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0]["id"], task.identity);
        assert_eq!(tasks[0]["title"], task.title);
        assert_eq!(tasks[0]["status"], "todo");
        assert_eq!(tasks[0]["path"], task.path.display().to_string());
    }

    #[test]
    fn task_list_rejects_unknown_status_filter() {
        let temp = tempfile::tempdir().expect("temp dir");
        let board = temp.path().join("tasks");
        let cwd = temp.path().to_path_buf();
        fs::create_dir_all(&board).expect("board");
        let mut out = Vec::new();

        let error =
            run_list_with_context(false, None, &["waiting".to_owned()], &cwd, None, &mut out)
                .expect_err("unknown status filter must fail");

        assert!(matches!(
            error,
            bob_core::error::ServiceError::InvalidRequest { ref detail }
                if detail.contains("invalid task status")
        ));
    }

    #[test]
    fn task_status_appends_default_breadcrumb_when_no_reason_given() {
        let temp = tempfile::tempdir().expect("temp dir");
        let board = temp.path().join("tasks");
        let cwd = temp.path().to_path_buf();
        fs::create_dir_all(&board).expect("board");
        let task = seed_task(&board, "Fix release notes", "todo");
        let mut out = Vec::new();

        run_status_with_context(
            false,
            None,
            &task.identity,
            "blocked",
            None,
            created_date(),
            &cwd,
            None,
            &mut out,
        )
        .expect("status change succeeds");

        let content = fs::read_to_string(&task.path).expect("task file");
        assert!(
            content.contains("status: blocked"),
            "status not updated: {content}"
        );
        assert!(
            content.contains("Status changed from todo to blocked."),
            "missing breadcrumb: {content}"
        );
    }

    #[test]
    fn task_status_carries_the_supplied_reason_in_the_log_entry() {
        let temp = tempfile::tempdir().expect("temp dir");
        let board = temp.path().join("tasks");
        let cwd = temp.path().to_path_buf();
        fs::create_dir_all(&board).expect("board");
        let task = seed_task(&board, "Fix release notes", "todo");
        let mut out = Vec::new();

        run_status_with_context(
            false,
            None,
            &task.identity,
            "blocked",
            Some("waiting on release manager"),
            created_date(),
            &cwd,
            None,
            &mut out,
        )
        .expect("status change succeeds");

        let content = fs::read_to_string(&task.path).expect("task file");
        assert!(
            content.contains("Status changed from todo to blocked: waiting on release manager"),
            "missing reason in breadcrumb: {content}"
        );
    }

    #[test]
    fn task_status_permits_move_to_blocked_with_no_reason() {
        let temp = tempfile::tempdir().expect("temp dir");
        let board = temp.path().join("tasks");
        let cwd = temp.path().to_path_buf();
        fs::create_dir_all(&board).expect("board");
        let task = seed_task(&board, "Fix release notes", "doing");
        let mut out = Vec::new();

        let result = run_status_with_context(
            false,
            None,
            &task.identity,
            "blocked",
            None,
            created_date(),
            &cwd,
            None,
            &mut out,
        );

        assert!(
            result.is_ok(),
            "move to blocked without reason must succeed"
        );
    }

    #[test]
    fn task_status_permits_move_to_done_with_unticked_definition_of_done_items() {
        let temp = tempfile::tempdir().expect("temp dir");
        let board = temp.path().join("tasks");
        let cwd = temp.path().to_path_buf();
        fs::create_dir_all(&board).expect("board");
        let task = seed_task(&board, "Fix release notes", "doing");
        let mut out = Vec::new();

        run_status_with_context(
            false,
            None,
            &task.identity,
            "done",
            None,
            created_date(),
            &cwd,
            None,
            &mut out,
        )
        .expect("move to done with unticked items must succeed");

        let content = fs::read_to_string(&task.path).expect("task file");
        assert!(content.contains("status: done"), "content: {content}");
        assert!(
            content.contains("- [ ] observable outcome"),
            "definition of done items must stay unticked: {content}"
        );
    }

    #[test]
    fn task_status_json_output_reports_previous_and_new_status() {
        let temp = tempfile::tempdir().expect("temp dir");
        let board = temp.path().join("tasks");
        let cwd = temp.path().to_path_buf();
        fs::create_dir_all(&board).expect("board");
        let task = seed_task(&board, "Fix release notes", "todo");
        let mut out = Vec::new();

        run_status_with_context(
            true,
            None,
            &task.identity,
            "doing",
            None,
            created_date(),
            &cwd,
            None,
            &mut out,
        )
        .expect("status change succeeds");

        let output = serde_json::from_slice::<Value>(&out).expect("json");
        assert_eq!(output["id"], task.identity);
        assert_eq!(output["previous_status"], "todo");
        assert_eq!(output["status"], "doing");
        assert_eq!(output["path"], task.path.display().to_string());
    }

    #[test]
    fn task_status_rejects_unknown_status_before_touching_the_task_file() {
        let temp = tempfile::tempdir().expect("temp dir");
        let board = temp.path().join("tasks");
        let cwd = temp.path().to_path_buf();
        fs::create_dir_all(&board).expect("board");
        let task = seed_task(&board, "Fix release notes", "todo");
        let before = fs::read_to_string(&task.path).expect("task file");
        let mut out = Vec::new();

        let error = run_status_with_context(
            false,
            None,
            &task.identity,
            "waiting",
            None,
            created_date(),
            &cwd,
            None,
            &mut out,
        )
        .expect_err("unknown status must fail");

        assert!(matches!(
            error,
            bob_core::error::ServiceError::InvalidRequest { ref detail }
                if detail.contains("invalid task status")
        ));
        let after = fs::read_to_string(&task.path).expect("task file");
        assert_eq!(
            before, after,
            "task file must be unchanged on validation failure"
        );
    }

    #[test]
    fn task_status_leaves_the_file_unchanged_when_the_log_section_is_missing() {
        let temp = tempfile::tempdir().expect("temp dir");
        let board = temp.path().join("tasks");
        let cwd = temp.path().to_path_buf();
        fs::create_dir_all(&board).expect("board");
        let path = board.join("2026-08-24-hand-authored-no-log.md");
        fs::write(
            &path,
            concat!(
                "---\n",
                "title: Hand-authored task\n",
                "status: todo\n",
                "---\n\n",
                "## Description\n",
                "This file has no log section.\n",
            ),
        )
        .expect("write hand-authored task");
        let before = fs::read_to_string(&path).expect("task file");
        let mut out = Vec::new();

        let error = run_status_with_context(
            false,
            None,
            "2026-08-24-hand-authored-no-log",
            "doing",
            None,
            created_date(),
            &cwd,
            None,
            &mut out,
        )
        .expect_err("missing log section must fail");

        assert!(matches!(
            error,
            bob_core::error::ServiceError::InvalidRequest { ref detail }
                if detail.contains("missing a log section")
        ));
        let after = fs::read_to_string(&path).expect("task file");
        assert_eq!(
            before, after,
            "status must not change when the log entry cannot be recorded"
        );
    }

    #[test]
    fn task_note_appends_dated_entry_without_changing_status() {
        let temp = tempfile::tempdir().expect("temp dir");
        let board = temp.path().join("tasks");
        let cwd = temp.path().to_path_buf();
        fs::create_dir_all(&board).expect("board");
        let task = seed_task(&board, "Fix release notes", "doing");
        let mut out = Vec::new();

        run_note_with_context(
            false,
            None,
            &task.identity,
            "Blocked on QA sign-off.",
            created_date(),
            &cwd,
            None,
            &mut out,
        )
        .expect("note succeeds");

        let content = fs::read_to_string(&task.path).expect("task file");
        assert!(content.contains("status: doing"), "content: {content}");
        assert!(
            content.contains("Blocked on QA sign-off."),
            "missing note text: {content}"
        );
    }

    #[test]
    fn task_note_json_output_reports_id_and_path() {
        let temp = tempfile::tempdir().expect("temp dir");
        let board = temp.path().join("tasks");
        let cwd = temp.path().to_path_buf();
        fs::create_dir_all(&board).expect("board");
        let task = seed_task(&board, "Fix release notes", "doing");
        let mut out = Vec::new();

        run_note_with_context(
            true,
            None,
            &task.identity,
            "Blocked on QA sign-off.",
            created_date(),
            &cwd,
            None,
            &mut out,
        )
        .expect("note succeeds");

        let output = serde_json::from_slice::<Value>(&out).expect("json");
        assert_eq!(output["id"], task.identity);
        assert_eq!(output["path"], task.path.display().to_string());
    }

    #[test]
    fn task_note_rejects_empty_text_before_touching_the_task_file() {
        let temp = tempfile::tempdir().expect("temp dir");
        let board = temp.path().join("tasks");
        let cwd = temp.path().to_path_buf();
        fs::create_dir_all(&board).expect("board");
        let task = seed_task(&board, "Fix release notes", "doing");
        let before = fs::read_to_string(&task.path).expect("task file");
        let mut out = Vec::new();

        let error = run_note_with_context(
            false,
            None,
            &task.identity,
            "   ",
            created_date(),
            &cwd,
            None,
            &mut out,
        )
        .expect_err("empty note text must fail");

        assert!(matches!(
            error,
            bob_core::error::ServiceError::InvalidRequest { ref detail }
                if detail == "note text must not be empty"
        ));
        let after = fs::read_to_string(&task.path).expect("task file");
        assert_eq!(
            before, after,
            "task file must be unchanged on validation failure"
        );
    }
}
