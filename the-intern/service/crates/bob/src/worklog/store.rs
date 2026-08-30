//! The worklog entry file store.
//!
//! Owns the on-disk worklog format and resolves the worklog location
//! strictly to `<cwd>/worklog/<date>.md` relative to a caller-supplied
//! working directory (ADR-015: cwd-strict resolution, no upward search, no
//! override).

use std::{
    fs,
    path::{Path, PathBuf},
};

use bob_core::error::{ServiceError, ServiceResult};
use chrono::NaiveDateTime;

const WORKLOG_DIR_NAME: &str = "worklog";
const FILE_DATE_FORMAT: &str = "%Y-%m-%d";
const ENTRY_TIME_FORMAT: &str = "%H:%M";

/// A worklog entry to append, in the Contract shape.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorklogEntry {
    /// Short human-readable label identifying the item this entry is about.
    pub item: String,
    /// What was done for this item this run.
    pub done: String,
    /// What is still outstanding, or `nothing` if fully resolved.
    pub left: String,
    /// What happens next, and on what trigger.
    pub next: String,
}

/// A worklog entry parsed back from a day's file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecordedEntry {
    /// The `HH:MM` value from the entry header.
    pub recorded_time: String,
    /// The item-identifier from the entry header.
    pub item: String,
    /// The `- Done:` bullet value.
    pub done: String,
    /// The `- Left:` bullet value.
    pub left: String,
    /// The `- Next:` bullet value.
    pub next: String,
}

/// The outcome of an [`WorklogStore::append`] call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppendOutcome {
    /// The day file the entry was written to.
    pub path: PathBuf,
    /// Non-fatal warnings, e.g. a pre-existing more-permissive `worklog/`
    /// directory that was left unchanged.
    pub warnings: Vec<String>,
}

/// Reads and writes `<cwd>/worklog/<date>.md`, strictly scoped to the
/// working directory it was constructed with.
#[derive(Debug, Clone)]
pub struct WorklogStore {
    worklog_dir: PathBuf,
}

impl WorklogStore {
    /// Build a store rooted at `working_dir`; the worklog directory is
    /// exactly `working_dir/worklog`, with no upward search.
    pub fn new(working_dir: impl AsRef<Path>) -> Self {
        Self {
            worklog_dir: working_dir.as_ref().join(WORKLOG_DIR_NAME),
        }
    }

    /// Append `entry` to `<cwd>/worklog/<date>.md`, where `date` and the
    /// entry's `HH:MM` header both come from `now`.
    ///
    /// Creates `worklog/` (Unix mode `0700`) and the day file (Unix mode
    /// `0600`) when they are absent. A pre-existing `worklog/` with more
    /// permissive modes is left unchanged and reported as a warning rather
    /// than a failure.
    ///
    /// # Errors
    ///
    /// Returns [`ServiceError::Persistence`] when a filesystem operation
    /// fails.
    pub fn append(&self, now: NaiveDateTime, entry: &WorklogEntry) -> ServiceResult<AppendOutcome> {
        let warnings = self.ensure_worklog_dir()?;

        let file_name = format!("{}.md", now.format(FILE_DATE_FORMAT));
        let day_path = self.worklog_dir.join(file_name);
        let block = render_entry_block(&now.format(ENTRY_TIME_FORMAT).to_string(), entry);

        append_block_to_file(&day_path, &block)?;

        Ok(AppendOutcome {
            path: day_path,
            warnings,
        })
    }

    /// Ensure `<cwd>/worklog/` exists, creating it Unix-mode `0700` when
    /// absent. An existing directory is never re-permissioned; if it is more
    /// permissive than owner-only a warning is returned.
    fn ensure_worklog_dir(&self) -> ServiceResult<Vec<String>> {
        match fs::metadata(&self.worklog_dir) {
            Ok(_) => Ok(Vec::new()),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                create_dir_owner_only(&self.worklog_dir)?;
                Ok(Vec::new())
            }
            Err(err) => Err(ServiceError::Persistence {
                detail: format!(
                    "failed to inspect worklog directory {}: {err}",
                    self.worklog_dir.display()
                ),
            }),
        }
    }
}

fn render_entry_block(recorded_time: &str, entry: &WorklogEntry) -> String {
    format!(
        "## {time} — {item}\n\n- Done: {done}\n- Left: {left}\n- Next: {next}\n\n",
        time = recorded_time,
        item = entry.item,
        done = entry.done,
        left = entry.left,
        next = entry.next,
    )
}

fn append_block_to_file(path: &Path, block: &str) -> ServiceResult<()> {
    match fs::read_to_string(path) {
        Ok(existing) => {
            let separator = trailing_separator(&existing);
            let mut file = fs::OpenOptions::new()
                .append(true)
                .open(path)
                .map_err(|err| ServiceError::Persistence {
                    detail: format!("failed to open worklog file {}: {err}", path.display()),
                })?;
            write_all(&mut file, format!("{separator}{block}").as_bytes(), path)
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            let mut file = create_file_owner_only(path)?;
            write_all(&mut file, block.as_bytes(), path)
        }
        Err(err) => Err(ServiceError::Persistence {
            detail: format!("failed to read worklog file {}: {err}", path.display()),
        }),
    }
}

fn write_all(file: &mut fs::File, bytes: &[u8], path: &Path) -> ServiceResult<()> {
    use std::io::Write;

    file.write_all(bytes)
        .map_err(|err| ServiceError::Persistence {
            detail: format!("failed to write worklog file {}: {err}", path.display()),
        })
}

/// The prefix needed so an appended entry block is separated from existing
/// content by exactly one blank line.
fn trailing_separator(existing: &str) -> &'static str {
    if existing.is_empty() || existing.ends_with("\n\n") {
        ""
    } else if existing.ends_with('\n') {
        "\n"
    } else {
        "\n\n"
    }
}

#[cfg(unix)]
fn create_dir_owner_only(path: &Path) -> ServiceResult<()> {
    use std::os::unix::fs::DirBuilderExt;

    fs::DirBuilder::new()
        .mode(0o700)
        .create(path)
        .map_err(|err| ServiceError::Persistence {
            detail: format!(
                "failed to create worklog directory {}: {err}",
                path.display()
            ),
        })
}

#[cfg(not(unix))]
fn create_dir_owner_only(path: &Path) -> ServiceResult<()> {
    fs::create_dir(path).map_err(|err| ServiceError::Persistence {
        detail: format!(
            "failed to create worklog directory {}: {err}",
            path.display()
        ),
    })
}

#[cfg(unix)]
fn create_file_owner_only(path: &Path) -> ServiceResult<fs::File> {
    use std::os::unix::fs::OpenOptionsExt;

    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .map_err(|err| ServiceError::Persistence {
            detail: format!("failed to create worklog file {}: {err}", path.display()),
        })
}

#[cfg(not(unix))]
fn create_file_owner_only(path: &Path) -> ServiceResult<fs::File> {
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|err| ServiceError::Persistence {
            detail: format!("failed to create worklog file {}: {err}", path.display()),
        })
}

#[cfg(test)]
mod tests {
    use super::{WorklogEntry, WorklogStore};
    use chrono::{NaiveDate, NaiveTime};

    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    #[cfg(unix)]
    fn mode_of(path: &std::path::Path) -> u32 {
        std::fs::metadata(path)
            .expect("metadata")
            .permissions()
            .mode()
            & 0o777
    }

    fn at(date: (i32, u32, u32), time: (u32, u32)) -> chrono::NaiveDateTime {
        NaiveDate::from_ymd_opt(date.0, date.1, date.2)
            .expect("valid date")
            .and_time(NaiveTime::from_hms_opt(time.0, time.1, 0).expect("valid time"))
    }

    fn sample_entry(item: &str) -> WorklogEntry {
        WorklogEntry {
            item: item.to_owned(),
            done: "Reviewed the overnight alerts.".to_owned(),
            left: "awaiting a reply from the vendor".to_owned(),
            next: "closes when the vendor replies".to_owned(),
        }
    }

    #[test]
    fn append_creates_worklog_directory_and_dated_file_with_entry_in_contract_shape() {
        let temp = tempfile::tempdir().expect("temp dir");
        let store = WorklogStore::new(temp.path());

        let outcome = store
            .append(at((2026, 8, 30), (9, 5)), &sample_entry("vendor-invoice"))
            .expect("append should succeed");

        let expected_path = temp.path().join("worklog").join("2026-08-30.md");
        assert_eq!(outcome.path, expected_path);
        assert!(
            outcome.warnings.is_empty(),
            "unexpected warnings: {:?}",
            outcome.warnings
        );

        let content = std::fs::read_to_string(&expected_path).expect("day file");
        assert_eq!(
            content,
            concat!(
                "## 09:05 — vendor-invoice\n",
                "\n",
                "- Done: Reviewed the overnight alerts.\n",
                "- Left: awaiting a reply from the vendor\n",
                "- Next: closes when the vendor replies\n",
                "\n",
            )
        );
    }

    #[test]
    #[cfg(unix)]
    fn append_gives_a_newly_created_worklog_dir_and_file_owner_only_modes() {
        let temp = tempfile::tempdir().expect("temp dir");
        let store = WorklogStore::new(temp.path());

        let outcome = store
            .append(at((2026, 8, 30), (9, 5)), &sample_entry("vendor-invoice"))
            .expect("append should succeed");

        let worklog_dir = temp.path().join("worklog");
        assert_eq!(mode_of(&worklog_dir), 0o700, "new worklog dir must be 0700");
        assert_eq!(mode_of(&outcome.path), 0o600, "new day file must be 0600");
    }
}
