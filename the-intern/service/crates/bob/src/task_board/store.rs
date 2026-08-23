use std::{
    fmt, fs,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrontmatterField {
    Title,
    Status,
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

    pub fn rewrite_frontmatter_field(
        &self,
        path: &Path,
        field: FrontmatterField,
        value: &str,
    ) -> ServiceResult<TaskFile> {
        let content = fs::read_to_string(path).map_err(|err| ServiceError::Persistence {
            detail: format!("failed to read task file {}: {err}", path.display()),
        })?;
        let updated = rewrite_frontmatter_content(&content, field, value, path)?;
        fs::write(path, updated.as_bytes()).map_err(|err| ServiceError::Persistence {
            detail: format!("failed to rewrite task file {}: {err}", path.display()),
        })?;
        self.read_task(path)
    }

    pub fn append_log_entry(
        &self,
        path: &Path,
        date: NaiveDate,
        entry: &str,
    ) -> ServiceResult<TaskFile> {
        let content = fs::read_to_string(path).map_err(|err| ServiceError::Persistence {
            detail: format!("failed to read task file {}: {err}", path.display()),
        })?;
        let updated = append_log_entry_content(&content, date, entry, path)?;
        fs::write(path, updated.as_bytes()).map_err(|err| ServiceError::Persistence {
            detail: format!("failed to append log entry to {}: {err}", path.display()),
        })?;
        self.read_task(path)
    }

    pub fn list_tasks(&self) -> ServiceResult<Vec<TaskFile>> {
        let mut tasks = Vec::new();
        let entries = fs::read_dir(&self.board_path).map_err(|err| ServiceError::Persistence {
            detail: format!(
                "failed to read task board directory {}: {err}",
                self.board_path.display()
            ),
        })?;

        for entry in entries {
            let entry = entry.map_err(|err| ServiceError::Persistence {
                detail: format!(
                    "failed to read an entry from task board directory {}: {err}",
                    self.board_path.display()
                ),
            })?;
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) != Some("md") {
                continue;
            }
            tasks.push(self.read_task(&path)?);
        }

        tasks.sort_by(|left, right| left.identity.cmp(&right.identity));
        Ok(tasks)
    }

    pub fn resolve_partial_identifier(&self, partial: &str) -> ServiceResult<String> {
        let tasks = self.list_tasks()?;
        if let Some(exact) = tasks.iter().find(|task| task.identity == partial) {
            return Ok(exact.identity.clone());
        }

        let candidates = tasks
            .into_iter()
            .filter(|task| task.identity.starts_with(partial))
            .map(|task| task.identity)
            .collect::<Vec<_>>();

        match candidates.as_slice() {
            [single] => Ok(single.clone()),
            [] => Err(ServiceError::InvalidRequest {
                detail: format!(
                    "no task matches partial identifier {partial:?}; candidates found: none"
                ),
            }),
            _ => Err(ServiceError::InvalidRequest {
                detail: format!(
                    "partial identifier {partial:?} is ambiguous; candidates found: {}",
                    candidates.join(", ")
                ),
            }),
        }
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

fn rewrite_frontmatter_content(
    content: &str,
    field: FrontmatterField,
    value: &str,
    path: &Path,
) -> ServiceResult<String> {
    let key = match field {
        FrontmatterField::Title => "title",
        FrontmatterField::Status => "status",
    };
    let replacement_value = match field {
        FrontmatterField::Title => {
            if value.trim().is_empty() {
                return Err(ServiceError::InvalidRequest {
                    detail: "task title must not be empty".to_owned(),
                });
            }
            if value.contains('\n') {
                return Err(ServiceError::InvalidRequest {
                    detail: "task title must be a single line".to_owned(),
                });
            }
            format_frontmatter_title(value)
        }
        FrontmatterField::Status => TaskStatus::parse(value)?.to_string(),
    };

    if !content.starts_with("---\n") {
        return Err(ServiceError::InvalidRequest {
            detail: format!("task file {} is missing frontmatter", path.display()),
        });
    }

    let mut offset = 0usize;
    let mut in_frontmatter = false;

    for segment in content.split_inclusive('\n') {
        let line = segment.strip_suffix('\n').unwrap_or(segment);

        if offset == 0 {
            in_frontmatter = line == "---";
            offset += segment.len();
            continue;
        }

        if in_frontmatter && line == "---" {
            break;
        }

        if in_frontmatter && line.strip_prefix(key).is_some() && line[key.len()..].starts_with(':')
        {
            let newline = if segment.ends_with('\n') { "\n" } else { "" };
            let mut updated = String::with_capacity(content.len() + replacement_value.len());
            updated.push_str(&content[..offset]);
            updated.push_str(key);
            updated.push_str(": ");
            updated.push_str(&replacement_value);
            updated.push_str(newline);
            updated.push_str(&content[offset + segment.len()..]);
            return Ok(updated);
        }

        offset += segment.len();
    }

    Err(ServiceError::InvalidRequest {
        detail: format!(
            "task file {} is missing frontmatter field {key}",
            path.display()
        ),
    })
}

fn append_log_entry_content(
    content: &str,
    date: NaiveDate,
    entry: &str,
    path: &Path,
) -> ServiceResult<String> {
    if !content.contains("\n## Log\n") && !content.starts_with("## Log\n") {
        return Err(ServiceError::InvalidRequest {
            detail: format!("task file {} is missing a log section", path.display()),
        });
    }

    let mut updated = content.to_owned();
    if !updated.ends_with('\n') {
        updated.push('\n');
    }
    if !updated.ends_with("\n\n") {
        updated.push('\n');
    }
    updated.push_str("### ");
    updated.push_str(&date.format("%Y-%m-%d").to_string());
    updated.push('\n');
    updated.push_str(entry);
    if !entry.ends_with('\n') {
        updated.push('\n');
    }

    Ok(updated)
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

    use super::{CreateTask, FrontmatterField, TaskStatus, TaskStore};
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
        assert!(
            content.contains("\n## Log\n"),
            "log section missing: {content}"
        );

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
            fs::read_dir(&board)
                .expect("board entries")
                .next()
                .is_none(),
            "board should stay empty on validation failure"
        );
    }

    #[test]
    fn rewrite_frontmatter_field_preserves_all_non_target_content() {
        let temp = tempfile::tempdir().expect("temp dir");
        let path = temp.path().join("2026-08-23-manual-task.md");
        let before = concat!(
            "---\n",
            "title: Manual task\n",
            "status: todo\n",
            "---\n\n",
            "## Description\n",
            "Keep this text exactly.\n\n",
            "## Definition of Done\n",
            "- [ ] unchanged item\n\n",
            "## Log\n",
            "### 2026-08-22\n",
            "Existing note.\n",
        );
        fs::write(&path, before).expect("write task file");
        let store = TaskStore::new(temp.path());

        let updated = store
            .rewrite_frontmatter_field(&path, FrontmatterField::Status, "blocked")
            .expect("rewrite should succeed");

        assert_eq!(updated.status, TaskStatus::Blocked);
        let after = fs::read_to_string(&path).expect("updated task file");
        let expected = before.replacen("status: todo", "status: blocked", 1);
        assert_eq!(
            after, expected,
            "rewrite should only change the target line"
        );
    }

    #[test]
    fn read_task_accepts_hand_authored_quoted_title_frontmatter() {
        let temp = tempfile::tempdir().expect("temp dir");
        let path = temp.path().join("2026-08-23-fix-colons.md");
        fs::write(
            &path,
            concat!(
                "---\n",
                "title: \"Fix parser: handle colon-bearing title\"\n",
                "status: doing\n",
                "---\n\n",
                "## Description\n",
                "Handle manually authored files.\n\n",
                "## Definition of Done\n",
                "- [ ] parser accepts the title\n\n",
                "## Log\n",
            ),
        )
        .expect("write hand-authored task");
        let store = TaskStore::new(temp.path());

        let task = store.read_task(&path).expect("task should parse");

        assert_eq!(task.identity, "2026-08-23-fix-colons");
        assert_eq!(task.title, "Fix parser: handle colon-bearing title");
        assert_eq!(task.status, TaskStatus::Doing);
    }

    #[test]
    fn append_log_entry_adds_a_dated_entry_to_the_log_section() {
        let temp = tempfile::tempdir().expect("temp dir");
        let board = temp.path().join("tasks");
        fs::create_dir_all(&board).expect("create board");
        let store = TaskStore::new(&board);
        let created = store
            .create_task(&task_request("Add breadcrumbs", "todo"))
            .expect("task should be created");

        let updated = store
            .append_log_entry(
                &created.path,
                NaiveDate::from_ymd_opt(2026, 8, 23).expect("valid date"),
                "Recorded a follow-up note.",
            )
            .expect("append should succeed");

        assert_eq!(updated.identity, created.identity);
        let content = fs::read_to_string(&created.path).expect("task file");
        assert!(
            content.ends_with("## Log\n\n### 2026-08-23\nRecorded a follow-up note.\n"),
            "log entry should be appended at the end: {content}"
        );
    }

    #[test]
    fn list_tasks_reads_hand_authored_and_created_markdown_files() {
        let temp = tempfile::tempdir().expect("temp dir");
        let board = temp.path().join("tasks");
        fs::create_dir_all(&board).expect("create board");
        let store = TaskStore::new(&board);

        store
            .create_task(&task_request("Prepare release notes", "todo"))
            .expect("created task");
        fs::write(
            board.join("2026-08-22-review-logs.md"),
            concat!(
                "---\n",
                "title: \"Review logs: capture edge cases\"\n",
                "status: blocked\n",
                "---\n\n",
                "## Description\n",
                "Hand-authored.\n\n",
                "## Definition of Done\n",
                "- [ ] listed successfully\n\n",
                "## Log\n",
            ),
        )
        .expect("write hand-authored task");

        let tasks = store.list_tasks().expect("list should succeed");

        assert_eq!(
            tasks
                .iter()
                .map(|task| task.identity.as_str())
                .collect::<Vec<_>>(),
            vec!["2026-08-22-review-logs", "2026-08-23-prepare-release-notes",]
        );
        assert_eq!(tasks[0].title, "Review logs: capture edge cases");
        assert_eq!(tasks[0].status, TaskStatus::Blocked);
        assert_eq!(tasks[1].status, TaskStatus::Todo);
    }

    #[test]
    fn resolve_partial_identifier_fails_for_none_and_ambiguous_matches() {
        let temp = tempfile::tempdir().expect("temp dir");
        let board = temp.path().join("tasks");
        fs::create_dir_all(&board).expect("create board");
        let store = TaskStore::new(&board);

        store
            .create_task(&task_request("Prepare release notes", "todo"))
            .expect("created task");
        store
            .create_task(&task_request("Prepare release checklist", "doing"))
            .expect("created task");

        let ambiguous = store
            .resolve_partial_identifier("2026-08-23-prepare-release")
            .expect_err("ambiguous partial should fail");
        let ambiguous_detail = match ambiguous {
            bob_core::error::ServiceError::InvalidRequest { detail } => detail,
            other => panic!("expected invalid request, got {other:?}"),
        };
        assert!(
            ambiguous_detail.contains("2026-08-23-prepare-release-notes"),
            "ambiguity error should name candidates: {ambiguous_detail}"
        );
        assert!(
            ambiguous_detail.contains("2026-08-23-prepare-release-checklist"),
            "ambiguity error should name candidates: {ambiguous_detail}"
        );

        let none = store
            .resolve_partial_identifier("does-not-exist")
            .expect_err("missing partial should fail");
        let none_detail = match none {
            bob_core::error::ServiceError::InvalidRequest { detail } => detail,
            other => panic!("expected invalid request, got {other:?}"),
        };
        assert!(
            none_detail.contains("candidates found: none"),
            "missing-partial error should say no candidates were found: {none_detail}"
        );
    }
}
