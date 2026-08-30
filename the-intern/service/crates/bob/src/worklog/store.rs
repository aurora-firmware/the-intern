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
use chrono::{NaiveDate, NaiveDateTime};

const WORKLOG_DIR_NAME: &str = "worklog";
const FILE_DATE_FORMAT: &str = "%Y-%m-%d";
const ENTRY_TIME_FORMAT: &str = "%H:%M";

/// The `Left` value that marks an item closed once normalized.
const CLOSED_SENTINEL: &str = "nothing";

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

/// The outcome of a [`WorklogStore::append`] call.
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

    /// Read back the entries recorded for `date`, ordered by each entry's
    /// `HH:MM` value with ties broken by physical file order.
    ///
    /// Returns an empty list when `<cwd>/worklog/` exists but has no file
    /// for `date`.
    ///
    /// # Errors
    ///
    /// Returns [`ServiceError::Persistence`] when `<cwd>/worklog/` does not
    /// exist — the directory is named in the error and is never created by a
    /// read — or when a filesystem operation fails.
    pub fn read_day(&self, date: NaiveDate) -> ServiceResult<Vec<RecordedEntry>> {
        self.require_worklog_dir()?;

        let day_path = self
            .worklog_dir
            .join(format!("{}.md", date.format(FILE_DATE_FORMAT)));
        let content = match fs::read_to_string(&day_path) {
            Ok(content) => content,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(err) => {
                return Err(ServiceError::Persistence {
                    detail: format!("failed to read worklog file {}: {err}", day_path.display()),
                })
            }
        };

        Ok(order_entries(parse_entries(&content)))
    }

    /// Fail, naming `<cwd>/worklog/`, when it does not exist. A read must
    /// never invent the directory (ADR-015).
    fn require_worklog_dir(&self) -> ServiceResult<()> {
        match fs::metadata(&self.worklog_dir) {
            Ok(_) => Ok(()),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                Err(ServiceError::Persistence {
                    detail: format!(
                        "worklog directory {} does not exist",
                        self.worklog_dir.display()
                    ),
                })
            }
            Err(err) => Err(ServiceError::Persistence {
                detail: format!(
                    "failed to inspect worklog directory {}: {err}",
                    self.worklog_dir.display()
                ),
            }),
        }
    }

    /// Ensure `<cwd>/worklog/` exists, creating it Unix-mode `0700` when
    /// absent. An existing directory is never re-permissioned; if it is more
    /// permissive than owner-only a warning is returned.
    fn ensure_worklog_dir(&self) -> ServiceResult<Vec<String>> {
        match fs::metadata(&self.worklog_dir) {
            Ok(metadata) => {
                let mut warnings = Vec::new();
                if let Some(warning) = permissive_dir_warning(&self.worklog_dir, &metadata) {
                    warnings.push(warning);
                }
                Ok(warnings)
            }
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

/// A warning when an existing `worklog/` directory grants access beyond its
/// owner. The directory is deliberately left unchanged (matching `bob
/// task`'s board precedent); the caller surfaces the warning.
#[cfg(unix)]
fn permissive_dir_warning(path: &Path, metadata: &fs::Metadata) -> Option<String> {
    use std::os::unix::fs::PermissionsExt;

    let mode = metadata.permissions().mode() & 0o777;
    let grants_group_or_other_access = mode & 0o077 != 0;
    if grants_group_or_other_access {
        Some(format!(
            "worklog directory {} has mode {:03o}, more permissive than owner-only (0700); \
             leaving it unchanged",
            path.display(),
            mode
        ))
    } else {
        None
    }
}

#[cfg(not(unix))]
fn permissive_dir_warning(_path: &Path, _metadata: &fs::Metadata) -> Option<String> {
    None
}

/// Whether `item` is still open in `entries` — a single day's parsed,
/// time-ordered entries (e.g. the output of [`WorklogStore::read_day`], or
/// a prior day's file read the same way).
///
/// The item is open unless its most recent entry's `Left` field, after
/// case-folding, trimming surrounding whitespace, and removing at most one
/// trailing period, equals `nothing`. Returns `None` when `entries` has no
/// entry for `item`.
pub fn item_open_state(entries: &[RecordedEntry], item: &str) -> Option<bool> {
    let latest = entries.iter().rev().find(|entry| entry.item == item)?;
    Some(!left_field_marks_closed(&latest.left))
}

/// Apply the closed-sentinel normalization to a raw `Left` field value:
/// case-fold, trim surrounding whitespace, and drop at most one trailing
/// period, then compare to `nothing`.
fn left_field_marks_closed(left: &str) -> bool {
    let trimmed = left.trim();
    let without_one_trailing_period = trimmed.strip_suffix('.').unwrap_or(trimmed);
    without_one_trailing_period.eq_ignore_ascii_case(CLOSED_SENTINEL)
}

/// Parse every `## HH:MM — item` entry from a day's file, in physical file
/// order. Lines that are not part of an entry are ignored, so an
/// operator's hand-authored notes between entries do not break reading.
fn parse_entries(content: &str) -> Vec<RecordedEntry> {
    let mut entries = Vec::new();
    let mut current: Option<RecordedEntry> = None;

    for line in content.lines() {
        if let Some(header) = line.strip_prefix("## ") {
            if let Some(entry) = current.take() {
                entries.push(entry);
            }
            if let Some((time, item)) = header.split_once('—') {
                current = Some(RecordedEntry {
                    recorded_time: time.trim().to_owned(),
                    item: item.trim().to_owned(),
                    done: String::new(),
                    left: String::new(),
                    next: String::new(),
                });
            }
            continue;
        }

        let Some(entry) = current.as_mut() else {
            continue;
        };

        if let Some(value) = line.strip_prefix("- Done:") {
            entry.done = value.trim().to_owned();
        } else if let Some(value) = line.strip_prefix("- Left:") {
            entry.left = value.trim().to_owned();
        } else if let Some(value) = line.strip_prefix("- Next:") {
            entry.next = value.trim().to_owned();
        }
    }

    if let Some(entry) = current.take() {
        entries.push(entry);
    }

    entries
}

/// Sort entries by `recorded_time`, keeping physical file order for entries
/// that share a time. `HH:MM` is zero-padded, so a lexicographic compare is
/// also a chronological one; the sort is stable, so ties keep file order.
fn order_entries(mut entries: Vec<RecordedEntry>) -> Vec<RecordedEntry> {
    entries.sort_by(|left, right| left.recorded_time.cmp(&right.recorded_time));
    entries
}

fn render_entry_block(recorded_time: &str, entry: &WorklogEntry) -> String {
    let WorklogEntry {
        item,
        done,
        left,
        next,
    } = entry;
    format!("## {recorded_time} — {item}\n\n- Done: {done}\n- Left: {left}\n- Next: {next}\n\n")
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
    use super::{item_open_state, RecordedEntry, WorklogEntry, WorklogStore};
    use chrono::{NaiveDate, NaiveTime};

    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    fn date(year: i32, month: u32, day: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(year, month, day).expect("valid date")
    }

    fn recorded(item: &str, left: &str) -> RecordedEntry {
        RecordedEntry {
            recorded_time: "09:00".to_owned(),
            item: item.to_owned(),
            done: "did the thing".to_owned(),
            left: left.to_owned(),
            next: "the trigger".to_owned(),
        }
    }

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

    #[test]
    #[cfg(unix)]
    fn append_leaves_a_more_permissive_worklog_dir_unchanged_and_warns_without_failing() {
        let temp = tempfile::tempdir().expect("temp dir");
        let worklog_dir = temp.path().join("worklog");
        std::fs::create_dir(&worklog_dir).expect("pre-create worklog dir");
        std::fs::set_permissions(&worklog_dir, std::fs::Permissions::from_mode(0o755))
            .expect("relax perms");
        let store = WorklogStore::new(temp.path());

        let outcome = store
            .append(at((2026, 8, 30), (9, 5)), &sample_entry("vendor-invoice"))
            .expect("append must not fail on a pre-existing permissive dir");

        assert_eq!(
            mode_of(&worklog_dir),
            0o755,
            "existing worklog dir permissions must be left unchanged"
        );
        assert!(
            outcome
                .warnings
                .iter()
                .any(|warning| warning.contains(&worklog_dir.display().to_string())),
            "a warning naming the worklog directory is expected: {:?}",
            outcome.warnings
        );
        assert!(
            temp.path().join("worklog").join("2026-08-30.md").is_file(),
            "the entry must still be written"
        );
    }

    #[test]
    fn read_day_round_trips_every_field_of_an_appended_entry() {
        let temp = tempfile::tempdir().expect("temp dir");
        let store = WorklogStore::new(temp.path());
        store
            .append(
                at((2026, 8, 30), (14, 30)),
                &WorklogEntry {
                    item: "vendor-invoice".to_owned(),
                    done: "Chased the vendor for the missing PDF.".to_owned(),
                    left: "awaiting the corrected invoice".to_owned(),
                    next: "closes when the corrected invoice arrives".to_owned(),
                },
            )
            .expect("append should succeed");

        let entries = store
            .read_day(date(2026, 8, 30))
            .expect("read_day should succeed");

        assert_eq!(
            entries,
            vec![RecordedEntry {
                recorded_time: "14:30".to_owned(),
                item: "vendor-invoice".to_owned(),
                done: "Chased the vendor for the missing PDF.".to_owned(),
                left: "awaiting the corrected invoice".to_owned(),
                next: "closes when the corrected invoice arrives".to_owned(),
            }]
        );
    }

    #[test]
    fn read_day_returns_no_entries_when_the_dated_file_is_absent() {
        let temp = tempfile::tempdir().expect("temp dir");
        let store = WorklogStore::new(temp.path());
        store
            .append(at((2026, 8, 30), (9, 0)), &sample_entry("vendor-invoice"))
            .expect("seed a different day");

        let entries = store
            .read_day(date(2026, 8, 29))
            .expect("an existing worklog dir with no file for the day is not an error");

        assert!(entries.is_empty());
    }

    #[test]
    fn read_day_errors_naming_the_worklog_path_when_the_directory_is_absent() {
        let temp = tempfile::tempdir().expect("temp dir");
        let store = WorklogStore::new(temp.path());

        let error = store
            .read_day(date(2026, 8, 30))
            .expect_err("a missing worklog directory must be an error, not an empty day");

        let detail = match error {
            bob_core::error::ServiceError::Persistence { detail } => detail,
            other => panic!("expected a persistence error, got {other:?}"),
        };
        let expected_dir = temp.path().join("worklog");
        assert!(
            detail.contains(&expected_dir.display().to_string()),
            "the error must name the worklog directory it looked for: {detail}"
        );
    }

    #[test]
    fn read_day_does_not_create_the_worklog_directory() {
        let temp = tempfile::tempdir().expect("temp dir");
        let store = WorklogStore::new(temp.path());

        let _ = store.read_day(date(2026, 8, 30));

        assert!(
            !temp.path().join("worklog").exists(),
            "a read must never invent the worklog directory"
        );
    }

    #[test]
    fn read_day_orders_entries_by_recorded_time_not_physical_file_position() {
        let temp = tempfile::tempdir().expect("temp dir");
        let store = WorklogStore::new(temp.path());
        store
            .append(at((2026, 8, 30), (14, 0)), &sample_entry("afternoon-item"))
            .expect("append later time first");
        store
            .append(at((2026, 8, 30), (9, 0)), &sample_entry("morning-item"))
            .expect("append earlier time second");

        let items: Vec<String> = store
            .read_day(date(2026, 8, 30))
            .expect("read_day should succeed")
            .into_iter()
            .map(|entry| entry.item)
            .collect();

        assert_eq!(items, vec!["morning-item", "afternoon-item"]);
    }

    #[test]
    fn read_day_breaks_recorded_time_ties_by_physical_file_order() {
        let temp = tempfile::tempdir().expect("temp dir");
        let store = WorklogStore::new(temp.path());
        store
            .append(at((2026, 8, 30), (10, 15)), &sample_entry("written-first"))
            .expect("append first");
        store
            .append(at((2026, 8, 30), (10, 15)), &sample_entry("written-second"))
            .expect("append second");

        let items: Vec<String> = store
            .read_day(date(2026, 8, 30))
            .expect("read_day should succeed")
            .into_iter()
            .map(|entry| entry.item)
            .collect();

        assert_eq!(items, vec!["written-first", "written-second"]);
    }

    #[test]
    fn item_open_state_classifies_nothing_sentinel_variants_as_closed() {
        for left in [
            "nothing",
            "Nothing",
            "NOTHING",
            "nothing.",
            "Nothing.",
            "  nothing  ",
        ] {
            let entries = [recorded("invoice", left)];
            assert_eq!(
                item_open_state(&entries, "invoice"),
                Some(false),
                "Left {left:?} should classify the item as closed"
            );
        }
    }

    #[test]
    fn item_open_state_classifies_a_substantive_left_value_as_open() {
        let entries = [recorded("invoice", "awaiting the corrected invoice")];
        assert_eq!(item_open_state(&entries, "invoice"), Some(true));
    }

    #[test]
    fn item_open_state_uses_the_items_most_recent_entry() {
        let closed_then_reopened = [
            recorded("invoice", "nothing"),
            recorded("invoice", "vendor came back with a new query"),
        ];
        assert_eq!(
            item_open_state(&closed_then_reopened, "invoice"),
            Some(true)
        );

        let open_then_closed = [
            recorded("invoice", "blocked on the vendor"),
            recorded("invoice", "Nothing."),
        ];
        assert_eq!(item_open_state(&open_then_closed, "invoice"), Some(false));
    }

    #[test]
    fn item_open_state_is_none_when_the_item_has_no_entry() {
        let entries = [recorded("invoice", "nothing")];
        assert_eq!(item_open_state(&entries, "shipping-label"), None);
    }

    #[test]
    fn item_open_state_only_strips_one_trailing_period_from_left() {
        let entries = [recorded("invoice", "Nothing..")];
        assert_eq!(
            item_open_state(&entries, "invoice"),
            Some(true),
            "only one trailing period is removed, so 'Nothing.' stays open"
        );
    }
}
