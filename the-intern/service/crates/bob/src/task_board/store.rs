use std::{
    fmt,
    fs,
    path::{Path, PathBuf},
};

use bob_core::error::{ServiceError, ServiceResult};
use chrono::NaiveDate;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskStatus {
    Todo,
    Doing,
    Blocked,
    Done,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreateTask {
    pub title: String,
    pub status: String,
    pub creation_date: NaiveDate,
    pub description: String,
    pub definition_of_done: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskFile {
    pub identity: String,
    pub path: PathBuf,
    pub title: String,
    pub status: TaskStatus,
    pub content: String,
}

#[derive(Debug, Clone)]
pub struct TaskStore {
    board_path: PathBuf,
}

impl TaskStore {
    pub fn new(board_path: impl Into<PathBuf>) -> Self {
        Self {
            board_path: board_path.into(),
        }
    }

    pub fn create_task(&self, request: &CreateTask) -> ServiceResult<TaskFile> {
        let status = TaskStatus::parse(&request.status)?;
        let identity = format!(
            "{}-{}",
            request.creation_date.format("%Y-%m-%d"),
            slugify_title(&request.title)
        );
        let path = self.board_path.join(format!("{identity}.md"));
        let content = render_task_file(request, status);

        write_owner_only_file(&path, &content)?;

        self.read_task(&path)
    }

    pub fn read_task(&self, path: &Path) -> ServiceResult<TaskFile> {
        let content = fs::read_to_string(path).map_err(|err| ServiceError::Persistence {
            detail: format!("failed to read task file {}: {err}", path.display()),
        })?;
        let (title, status) = parse_frontmatter_fields(&content, path)?;
        let identity = task_identity_from_path(path)?;

        Ok(TaskFile {
            identity,
            path: path.to_path_buf(),
            title,
            status,
            content,
        })
    }
}

impl TaskStatus {
    pub fn parse(value: &str) -> ServiceResult<Self> {
        match value {
            "todo" => Ok(Self::Todo),
            "doing" => Ok(Self::Doing),
            "blocked" => Ok(Self::Blocked),
            "done" => Ok(Self::Done),
            other => Err(ServiceError::InvalidRequest {
                detail: format!(
                    "invalid task status {other:?}; allowed statuses are todo, doing, blocked, done"
                ),
            }),
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Todo => "todo",
            Self::Doing => "doing",
            Self::Blocked => "blocked",
            Self::Done => "done",
        }
    }
}

impl fmt::Display for TaskStatus {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

fn render_task_file(request: &CreateTask, status: TaskStatus) -> String {
    let mut content = String::new();
    content.push_str("---\n");
    content.push_str("title: ");
    content.push_str(&format_frontmatter_title(&request.title));
    content.push('\n');
    content.push_str("status: ");
    content.push_str(status.as_str());
    content.push_str("\n---\n\n");
    content.push_str("## Description\n");
    if request.description.is_empty() {
        content.push('\n');
    } else {
        content.push_str(&request.description);
        content.push('\n');
    }
    content.push_str("\n## Definition of Done\n");
    if request.definition_of_done.is_empty() {
        content.push('\n');
    } else {
        for item in &request.definition_of_done {
            content.push_str("- [ ] ");
            content.push_str(item);
            content.push('\n');
        }
    }
    content.push_str("\n## Log\n");
    content
}

fn format_frontmatter_title(title: &str) -> String {
    if requires_frontmatter_quotes(title) {
        format!("{title:?}")
    } else {
        title.to_owned()
    }
}

fn requires_frontmatter_quotes(title: &str) -> bool {
    title.is_empty()
        || title.starts_with(char::is_whitespace)
        || title.ends_with(char::is_whitespace)
        || title.contains(':')
        || title.contains('#')
        || title.contains('"')
}

fn slugify_title(title: &str) -> String {
    let mut slug = String::new();
    let mut last_was_separator = false;

    for ch in title.chars() {
        if ch.is_alphanumeric() {
            for lower in ch.to_lowercase() {
                slug.push(lower);
            }
            last_was_separator = false;
        } else if !slug.is_empty() && !last_was_separator {
            slug.push('-');
            last_was_separator = true;
        }
    }

    while slug.ends_with('-') {
        slug.pop();
    }

    if slug.is_empty() {
        "task".to_owned()
    } else {
        slug
    }
}

fn parse_frontmatter_fields(content: &str, path: &Path) -> ServiceResult<(String, TaskStatus)> {
    let mut lines = content.lines();
    if lines.next() != Some("---") {
        return Err(ServiceError::InvalidRequest {
            detail: format!("task file {} is missing frontmatter", path.display()),
        });
    }

    let mut title = None;
    let mut status = None;

    for line in lines.by_ref() {
        if line == "---" {
            break;
        }

        if let Some(rest) = line.strip_prefix("title:") {
            title = Some(parse_title_value(rest.trim(), path)?);
        } else if let Some(rest) = line.strip_prefix("status:") {
            status = Some(TaskStatus::parse(rest.trim())?);
        }
    }

    let title = title.ok_or_else(|| ServiceError::InvalidRequest {
        detail: format!("task file {} is missing a title field", path.display()),
    })?;
    let status = status.ok_or_else(|| ServiceError::InvalidRequest {
        detail: format!("task file {} is missing a status field", path.display()),
    })?;

    Ok((title, status))
}

fn parse_title_value(value: &str, path: &Path) -> ServiceResult<String> {
    if value.starts_with('"') {
        return serde_json::from_str::<String>(value).map_err(|err| ServiceError::InvalidRequest {
            detail: format!(
                "task file {} has an invalid quoted title field: {err}",
                path.display()
            ),
        });
    }

    if value.starts_with('\'') && value.ends_with('\'') && value.len() >= 2 {
        return Ok(value[1..value.len() - 1].replace("''", "'"));
    }

    Ok(value.to_owned())
}

fn task_identity_from_path(path: &Path) -> ServiceResult<String> {
    path.file_stem()
        .and_then(|value| value.to_str())
        .map(str::to_owned)
        .ok_or_else(|| ServiceError::InvalidRequest {
            detail: format!("task file path {} has no valid identity", path.display()),
        })
}

fn write_owner_only_file(path: &Path, content: &str) -> ServiceResult<()> {
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;

        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(path)
            .map_err(|err| ServiceError::Persistence {
                detail: format!("failed to create task file {}: {err}", path.display()),
            })?;
        file.write_all(content.as_bytes())
            .map_err(|err| ServiceError::Persistence {
                detail: format!("failed to write task file {}: {err}", path.display()),
            })?;
        return Ok(());
    }

    #[cfg(not(unix))]
    {
        fs::write(path, content).map_err(|err| ServiceError::Persistence {
            detail: format!("failed to write task file {}: {err}", path.display()),
        })
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::{CreateTask, TaskStatus, TaskStore};
    use chrono::NaiveDate;

    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    fn task_request(title: &str, status: &str) -> CreateTask {
        CreateTask {
            title: title.to_owned(),
            status: status.to_owned(),
            creation_date: NaiveDate::from_ymd_opt(2026, 8, 23).expect("valid date"),
            description: "Describe the change.".to_owned(),
            definition_of_done: vec![
                "observable outcome one".to_owned(),
                "observable outcome two".to_owned(),
            ],
        }
    }

    #[test]
    fn create_task_writes_owner_only_markdown_file_with_filename_identity() {
        let temp = tempfile::tempdir().expect("temp dir");
        let board = temp.path().join("tasks");
        fs::create_dir_all(&board).expect("create board");
        let store = TaskStore::new(&board);

        let created = store
            .create_task(&task_request("Finish the launch checklist", "todo"))
            .expect("task should be created");

        assert_eq!(created.identity, "2026-08-23-finish-the-launch-checklist");
        assert_eq!(
            created.path.file_name().and_then(|value| value.to_str()),
            Some("2026-08-23-finish-the-launch-checklist.md")
        );
        assert_eq!(created.title, "Finish the launch checklist");
        assert_eq!(created.status, TaskStatus::Todo);

        let content = fs::read_to_string(&created.path).expect("task file");
        assert!(
            content.starts_with("---\ntitle: Finish the launch checklist\nstatus: todo\n---\n"),
            "unexpected frontmatter: {content}"
        );
        assert!(
            content.contains("\n## Description\nDescribe the change.\n"),
            "description section missing: {content}"
        );
        assert!(
            content.contains("\n## Definition of Done\n- [ ] observable outcome one\n- [ ] observable outcome two\n"),
            "definition of done checklist missing: {content}"
        );
        assert!(content.contains("\n## Log\n"), "log section missing: {content}");

        #[cfg(unix)]
        {
            let mode = fs::metadata(&created.path)
                .expect("metadata")
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o600, "new task files must be mode 0600");
        }
    }

    #[test]
    fn create_task_rejects_invalid_status_before_touching_filesystem() {
        let temp = tempfile::tempdir().expect("temp dir");
        let board = temp.path().join("tasks");
        fs::create_dir_all(&board).expect("create board");
        let store = TaskStore::new(&board);

        let error = store
            .create_task(&task_request("Write postmortem", "waiting"))
            .expect_err("invalid status should fail");

        let detail = match error {
            bob_core::error::ServiceError::InvalidRequest { detail } => detail,
            other => panic!("expected invalid request, got {other:?}"),
        };
        assert!(
            detail.contains("allowed statuses"),
            "error should describe allowed statuses: {detail}"
        );
        assert!(
            fs::read_dir(&board).expect("board entries").next().is_none(),
            "board should stay empty on validation failure"
        );
    }
}
