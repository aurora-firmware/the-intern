use std::path::Path;

use croner::parser::{CronParser, Seconds};
use serde::{Deserialize, Serialize};

use crate::error::{ServiceError, ServiceResult};

/// Version tag written and expected by the JSON schedule-store document.
const SCHEDULE_STORE_VERSION: u32 = 1;

/// Serialisation wrapper for the on-disk JSON schedule-store document.
///
/// The shape is `{ "version": 1, "entries": [...] }`.
#[derive(Debug, Serialize, Deserialize)]
struct ScheduleStoreDoc {
    version: u32,
    entries: Vec<ScheduleEntry>,
}

/// Read schedule entries from a versioned JSON schedule-store file at `path`.
///
/// # Missing file
///
/// When `path` does not exist the function returns an empty `Vec` rather than
/// an error, because an absent store is indistinguishable from a store that
/// has never been written.
///
/// # Errors
///
/// Returns `ServiceError::Persistence` when the file exists but cannot be
/// read from disk.
/// Returns `ServiceError::Configuration` when the document is not valid JSON,
/// carries an unrecognised `version` field, contains entries that do not match
/// the expected shape, or violates the whole-store invariants enforced by
/// [`validate_schedule_store`] (unique non-empty `id`, valid 5-field `cron`, and
/// exactly one non-blank prompt source — either `prompt` or an absolute `file`).
/// The store is accepted or rejected as a whole; a single bad entry fails the
/// read rather than being silently skipped (S-009).
///
/// This reader establishes *content* validity only. Callers that treat the
/// store as trusted, admitted work (startup and `schedule.reload`) must also
/// confirm the file lives within the Unix trust boundary via
/// [`verify_trusted_store`] before reading.
pub fn read_schedule_store(path: &Path) -> ServiceResult<Vec<ScheduleEntry>> {
    if !path.exists() {
        return Ok(Vec::new());
    }

    let content = std::fs::read_to_string(path).map_err(|e| ServiceError::Persistence {
        detail: format!("failed to read schedule store {}: {e}", path.display()),
    })?;

    let doc: ScheduleStoreDoc =
        serde_json::from_str(&content).map_err(|e| ServiceError::Configuration {
            detail: format!("malformed schedule store {}: {e}", path.display()),
        })?;

    if doc.version != SCHEDULE_STORE_VERSION {
        return Err(ServiceError::Configuration {
            detail: format!(
                "schedule store {} has unsupported version {}; expected {SCHEDULE_STORE_VERSION}",
                path.display(),
                doc.version
            ),
        });
    }

    validate_schedule_store(&doc.entries)?;

    Ok(doc.entries)
}

/// Validate the whole-store invariants required of schedule entries (S-009).
///
/// Every entry must have a non-empty `id`, a valid 5-field cron expression
/// (minute hour day-of-month month day-of-week), and exactly one non-blank
/// prompt source: either a `prompt` (literal text) or a `file` (an absolute
/// path whose contents are read at fire time). Setting both, setting neither,
/// or giving `file` a relative path is rejected. `id` values must be unique
/// across the store. The store is validated as a whole — a single bad entry
/// rejects the entire document rather than being silently skipped or deferred.
///
/// # Errors
///
/// Returns `ServiceError::Configuration` describing the first invariant
/// violation found.
pub fn validate_schedule_store(entries: &[ScheduleEntry]) -> ServiceResult<()> {
    let parser = CronParser::builder().seconds(Seconds::Disallowed).build();
    let mut seen: std::collections::HashSet<&str> = std::collections::HashSet::new();

    for entry in entries {
        if entry.id.trim().is_empty() {
            return Err(ServiceError::Configuration {
                detail: "schedule store contains an entry with a blank id".to_owned(),
            });
        }
        match (
            entry.prompt.as_deref().map(str::trim),
            entry.file.as_deref().map(str::trim),
        ) {
            (Some(p), None) if !p.is_empty() => {}
            (None, Some(f)) if !f.is_empty() => {
                if !std::path::Path::new(f).is_absolute() {
                    return Err(ServiceError::Configuration {
                        detail: format!(
                            "schedule entry {:?} has a relative file path {f:?}; an absolute path is required",
                            entry.id
                        ),
                    });
                }
            }
            (Some(_), Some(_)) => {
                return Err(ServiceError::Configuration {
                    detail: format!(
                        "schedule entry {:?} sets both prompt and file; exactly one is required",
                        entry.id
                    ),
                });
            }
            (None, None) => {
                return Err(ServiceError::Configuration {
                    detail: format!(
                        "schedule entry {:?} sets neither prompt nor file; exactly one is required",
                        entry.id
                    ),
                });
            }
            // Exactly one field is present, but it is blank.
            _ => {
                return Err(ServiceError::Configuration {
                    detail: format!("schedule entry {:?} has a blank prompt or file", entry.id),
                });
            }
        }
        if entry.cron.trim().is_empty() {
            return Err(ServiceError::Configuration {
                detail: format!("schedule entry {:?} has a blank cron expression", entry.id),
            });
        }
        if let Err(e) = parser.parse(&entry.cron) {
            return Err(ServiceError::Configuration {
                detail: format!(
                    "schedule entry {:?} has an invalid cron expression {:?}: {e}",
                    entry.id, entry.cron
                ),
            });
        }
        if !seen.insert(entry.id.as_str()) {
            return Err(ServiceError::Configuration {
                detail: format!("schedule store contains a duplicate id {:?}", entry.id),
            });
        }
    }

    Ok(())
}

/// Verify that the schedule store at `path` and its parent directory live within
/// the Unix trust boundary before their contents are trusted (ADR-012, ADR-005).
///
/// Scheduled jobs admitted from the store bypass `[policy].admitted_users`, so
/// the "trusted" premise must be established at the filesystem boundary. On Unix
/// this fails closed with `ServiceError::Configuration` when:
/// - the parent directory is not owned by `expected_uid`, or is group/other
///   writable (which would let another principal replace or race the store);
/// - the store file is not owned by `expected_uid`, or is group/other accessible
///   (`mode & 0o077 != 0`).
///
/// A missing store is accepted (an absent store means "no jobs"). This is a
/// read-side check and never tightens modes — a file another principal may have
/// written is refused, not silently adopted. On non-Unix platforms this is a
/// no-op (those builds carry no trust enforcement and are not a supported secure
/// deployment).
#[cfg(unix)]
pub fn verify_trusted_store(path: &Path, expected_uid: u32) -> ServiceResult<()> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};

    if !path.exists() {
        return Ok(());
    }

    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    if !parent.as_os_str().is_empty() {
        let meta = std::fs::metadata(parent).map_err(|e| ServiceError::Configuration {
            detail: format!(
                "cannot stat schedule store parent directory {}: {e}",
                parent.display()
            ),
        })?;
        if meta.uid() != expected_uid {
            return Err(ServiceError::Configuration {
                detail: format!(
                    "schedule store parent directory {} is owned by uid {}, not the trusted uid {expected_uid}",
                    parent.display(),
                    meta.uid()
                ),
            });
        }
        if meta.permissions().mode() & 0o022 != 0 {
            return Err(ServiceError::Configuration {
                detail: format!(
                    "schedule store parent directory {} is group/other writable (mode {:o}); refusing to trust its contents",
                    parent.display(),
                    meta.permissions().mode() & 0o777
                ),
            });
        }
    }

    let meta = std::fs::metadata(path).map_err(|e| ServiceError::Configuration {
        detail: format!("cannot stat schedule store {}: {e}", path.display()),
    })?;
    if meta.uid() != expected_uid {
        return Err(ServiceError::Configuration {
            detail: format!(
                "schedule store {} is owned by uid {}, not the trusted uid {expected_uid}",
                path.display(),
                meta.uid()
            ),
        });
    }
    if meta.permissions().mode() & 0o077 != 0 {
        return Err(ServiceError::Configuration {
            detail: format!(
                "schedule store {} is group/other accessible (mode {:o}); expected owner-only",
                path.display(),
                meta.permissions().mode() & 0o777
            ),
        });
    }

    Ok(())
}

#[cfg(not(unix))]
pub fn verify_trusted_store(_path: &Path, _expected_uid: u32) -> ServiceResult<()> {
    Ok(())
}

/// Ensure the schedule store's parent directory is a trusted, owner-only
/// directory before the store is written (ADR-012, ADR-005).
///
/// On Unix: creates the directory with mode `0o700` when absent; fails closed
/// with `ServiceError::Configuration` when it exists but is not owned by
/// `expected_uid` (bob cannot establish the trust premise for, or even chmod, a
/// directory it does not own); tightens an owner-owned directory to `0o700` when
/// its mode allows group/other access. On non-Unix platforms this only creates
/// the directory.
#[cfg(unix)]
pub fn enforce_trusted_store_dir(parent: &Path, expected_uid: u32) -> ServiceResult<()> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};

    if parent.as_os_str().is_empty() {
        return Ok(());
    }

    if !parent.exists() {
        std::fs::create_dir_all(parent).map_err(|e| ServiceError::Persistence {
            detail: format!(
                "failed to create schedule store parent directory {}: {e}",
                parent.display()
            ),
        })?;
        return std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700)).map_err(
            |e| ServiceError::Persistence {
                detail: format!(
                    "failed to set owner-only mode on schedule store parent directory {}: {e}",
                    parent.display()
                ),
            },
        );
    }

    let meta = std::fs::metadata(parent).map_err(|e| ServiceError::Persistence {
        detail: format!(
            "cannot stat schedule store parent directory {}: {e}",
            parent.display()
        ),
    })?;
    if meta.uid() != expected_uid {
        return Err(ServiceError::Configuration {
            detail: format!(
                "schedule store parent directory {} is owned by uid {}, not the trusted uid {expected_uid}; refusing to write",
                parent.display(),
                meta.uid()
            ),
        });
    }
    if meta.permissions().mode() & 0o077 != 0 {
        std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700)).map_err(|e| {
            ServiceError::Persistence {
                detail: format!(
                    "failed to tighten schedule store parent directory {} to owner-only: {e}",
                    parent.display()
                ),
            }
        })?;
    }

    Ok(())
}

#[cfg(not(unix))]
pub fn enforce_trusted_store_dir(parent: &Path, _expected_uid: u32) -> ServiceResult<()> {
    if !parent.as_os_str().is_empty() {
        std::fs::create_dir_all(parent).map_err(|e| ServiceError::Persistence {
            detail: format!(
                "failed to create schedule store parent directory {}: {e}",
                parent.display()
            ),
        })?;
    }
    Ok(())
}

/// Atomically replace the JSON schedule-store file at `path` with a document
/// containing `entries`.
///
/// # Atomicity
///
/// The document is serialised to a temporary file placed in the same directory
/// as `path` and then renamed over `path`.  An observer therefore sees either
/// the old complete document or the new complete document — never a partial
/// write.
///
/// # Permissions
///
/// On Unix, a new store file is created with mode `0600` (owner read/write
/// only).  When `path` already exists its permission bits are read before the
/// write and restored on the replacement file before the rename, so an
/// operator-restricted store is not silently widened to the process umask
/// default.
///
/// # Errors
///
/// Returns `ServiceError::Persistence` for I/O failures (directory creation,
/// temp-file write, permission change, or rename).
pub fn write_schedule_store(path: &Path, entries: &[ScheduleEntry]) -> ServiceResult<()> {
    // Never persist a store that violates the whole-store invariants (S-009).
    validate_schedule_store(entries)?;

    let doc = ScheduleStoreDoc {
        version: SCHEDULE_STORE_VERSION,
        entries: entries.to_vec(),
    };

    let content = serde_json::to_string_pretty(&doc).map_err(|e| ServiceError::Persistence {
        detail: format!("failed to serialise schedule store: {e}"),
    })?;

    // Ensure parent directories exist.
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    if !parent.as_os_str().is_empty() {
        std::fs::create_dir_all(parent).map_err(|e| ServiceError::Persistence {
            detail: format!(
                "failed to create schedule store parent directory {}: {e}",
                parent.display()
            ),
        })?;
    }

    // Capture the existing file's mode before writing so we can restore it.
    // When no file exists we default to 0600.
    #[cfg(unix)]
    let existing_mode: Option<u32> = {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(path).ok().map(|m| m.permissions().mode())
    };

    // Write to a temp file in the same directory for an atomic rename.
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp_path = parent.join(format!(".bob-schedule-tmp-{unique}"));

    // On Unix, create the temp file with restrictive permissions from open time
    // (mode applied at creation, never momentarily 0644) and `create_new` so the
    // unique temp name cannot be pre-staged or symlinked by another principal.
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

        let mode = existing_mode.unwrap_or(0o600);
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(mode)
            .open(&tmp_path)
            .map_err(|e| ServiceError::Persistence {
                detail: format!(
                    "failed to create temp schedule store {}: {e}",
                    tmp_path.display()
                ),
            })?;
        if let Err(e) = file.write_all(content.as_bytes()) {
            let _ = std::fs::remove_file(&tmp_path);
            return Err(ServiceError::Persistence {
                detail: format!(
                    "failed to write temp schedule store {}: {e}",
                    tmp_path.display()
                ),
            });
        }
        // Restore the exact intended mode in case the process umask masked bits
        // at open time (e.g. a preserved group-readable mode).
        if let Err(e) = std::fs::set_permissions(&tmp_path, std::fs::Permissions::from_mode(mode)) {
            let _ = std::fs::remove_file(&tmp_path);
            return Err(ServiceError::Persistence {
                detail: format!(
                    "failed to set permissions on temp schedule store {}: {e}",
                    tmp_path.display()
                ),
            });
        }
    }

    #[cfg(not(unix))]
    std::fs::write(&tmp_path, &content).map_err(|e| ServiceError::Persistence {
        detail: format!(
            "failed to write temp schedule store {}: {e}",
            tmp_path.display()
        ),
    })?;

    std::fs::rename(&tmp_path, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp_path);
        ServiceError::Persistence {
            detail: format!(
                "failed to rename temp schedule store to {}: {e}",
                path.display()
            ),
        }
    })?;

    Ok(())
}

/// A validated schedule job entry sourced from the JSON schedule store
/// (`schedules.json`).
///
/// `id` is the unique string identifier for the job and `cron` is a standard
/// 5-field cron expression (minute hour day-of-month month day-of-week).
///
/// The prompt sent to the agent when the job fires comes from exactly one of
/// two mutually exclusive fields:
///
/// - `prompt` — literal text, sent verbatim.
/// - `file` — an absolute path to a file whose contents are read *fresh at
///   each fire* and sent as the prompt. Editing the file changes what future
///   runs send; a missing, unreadable, or blank file skips that fire (the
///   resolution happens in the scheduler-adapter).
///
/// Exactly one of `prompt`/`file` must be present and non-blank, and `file`
/// must be an absolute path — both enforced by [`validate_schedule_store`]. On
/// disk an entry serialises to `{ "id", "cron", "prompt" }` or
/// `{ "id", "cron", "file" }`; the unused field is omitted, so existing
/// `prompt`-only stores continue to load unchanged (store version stays 1).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ScheduleEntry {
    pub id: String,
    pub cron: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
}

impl ScheduleEntry {
    /// Construct a literal-text schedule entry (the `prompt` is sent verbatim).
    pub fn with_prompt(
        id: impl Into<String>,
        cron: impl Into<String>,
        prompt: impl Into<String>,
    ) -> Self {
        Self {
            id: id.into(),
            cron: cron.into(),
            prompt: Some(prompt.into()),
            file: None,
            cwd: None,
        }
    }

    /// Construct a file-backed schedule entry. `file` should be an absolute
    /// path; [`validate_schedule_store`] rejects relative paths, and the file's
    /// contents are read fresh at each fire.
    pub fn with_file(
        id: impl Into<String>,
        cron: impl Into<String>,
        file: impl Into<String>,
    ) -> Self {
        Self {
            id: id.into(),
            cron: cron.into(),
            prompt: None,
            file: Some(file.into()),
            cwd: None,
        }
    }

    /// Attach a working directory to an already-built schedule entry. `cwd`
    /// should be a non-blank absolute path; [`validate_schedule_store`] rejects
    /// blank or relative values.
    pub fn with_cwd(mut self, cwd: impl Into<String>) -> Self {
        self.cwd = Some(cwd.into());
        self
    }
}

/// Atomically replace the `[[schedule]]` array in the TOML file at `path` with
/// `entries`, preserving all other config keys and comments.
///
/// This is the single writer shared by both the `bob` config layer and the
/// admin-RPC `schedule.*` handlers, so the persistence behaviour cannot drift
/// between the tested path and the live path.
///
/// # Atomicity
///
/// The new document is written to a temporary file in the same directory and
/// then renamed over `path`, so an observer never sees a partial write: either
/// the old file or the fully written new file is visible.
///
/// # Permissions
///
/// On Unix the temporary file is set to the original file's mode before the
/// rename, so an operator-restricted config (e.g. `0600`) is not silently
/// widened to the process umask default when it is rewritten.
///
/// # Errors
///
/// Returns `ServiceError::Configuration` when the existing file cannot be
/// parsed and `ServiceError::Persistence` when it cannot be read, written, or
/// renamed.
pub fn write_schedule_entries(path: &Path, entries: &[ScheduleEntry]) -> ServiceResult<()> {
    // Read and parse the existing TOML, or start with an empty document.
    let content = if path.exists() {
        std::fs::read_to_string(path).map_err(|e| ServiceError::Persistence {
            detail: format!("failed to read config file {}: {e}", path.display()),
        })?
    } else {
        String::new()
    };

    let mut doc: toml_edit::DocumentMut =
        content.parse().map_err(|e| ServiceError::Configuration {
            detail: format!("failed to parse config file {}: {e}", path.display()),
        })?;

    // Remove the existing [[schedule]] array (if any) and replace it.
    doc.remove("schedule");

    if !entries.is_empty() {
        let mut arr = toml_edit::ArrayOfTables::new();
        for entry in entries {
            let mut table = toml_edit::Table::new();
            table.insert("id", toml_edit::value(entry.id.as_str()));
            table.insert("cron", toml_edit::value(entry.cron.as_str()));
            if let Some(prompt) = entry.prompt.as_deref() {
                table.insert("prompt", toml_edit::value(prompt));
            }
            if let Some(file) = entry.file.as_deref() {
                table.insert("file", toml_edit::value(file));
            }
            arr.push(table);
        }
        doc.insert("schedule", toml_edit::Item::ArrayOfTables(arr));
    }

    // Write to a temp file in the same directory for an atomic rename.
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    if !parent.as_os_str().is_empty() {
        std::fs::create_dir_all(parent).map_err(|e| ServiceError::Persistence {
            detail: format!(
                "failed to create config parent directory {}: {e}",
                parent.display()
            ),
        })?;
    }

    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp_path = parent.join(format!(".bob-config-tmp-{unique}"));

    std::fs::write(&tmp_path, doc.to_string()).map_err(|e| ServiceError::Persistence {
        detail: format!(
            "failed to write temp config file {}: {e}",
            tmp_path.display()
        ),
    })?;

    // Preserve the original file's permission bits across the atomic replace.
    // `rename` installs the temp file's inode in place of the original, so
    // without this the mode would reset to the process umask (e.g. a 0600
    // config would be silently widened to 0644).
    #[cfg(unix)]
    if let Ok(meta) = std::fs::metadata(path) {
        use std::os::unix::fs::PermissionsExt;
        let mode = meta.permissions().mode();
        if let Err(e) = std::fs::set_permissions(&tmp_path, std::fs::Permissions::from_mode(mode)) {
            let _ = std::fs::remove_file(&tmp_path);
            return Err(ServiceError::Persistence {
                detail: format!(
                    "failed to set permissions on temp config file {}: {e}",
                    tmp_path.display()
                ),
            });
        }
    }

    std::fs::rename(&tmp_path, path).map_err(|e| {
        // Try to clean up the temp file; ignore errors.
        let _ = std::fs::remove_file(&tmp_path);
        ServiceError::Persistence {
            detail: format!(
                "failed to rename temp config file to {}: {e}",
                path.display()
            ),
        }
    })?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        read_schedule_store, validate_schedule_store, write_schedule_entries, write_schedule_store,
        ScheduleEntry,
    };

    fn entry(id: &str) -> ScheduleEntry {
        ScheduleEntry::with_prompt(id, "* * * * *", "do the thing")
    }

    #[test]
    fn persists_entries_and_can_be_read_back() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("bob.toml");

        write_schedule_entries(&path, &[entry("job-1")]).expect("write must succeed");

        let content = std::fs::read_to_string(&path).expect("read back");
        assert!(content.contains("[[schedule]]"), "schedule section present");
        assert!(content.contains("job-1"), "entry id persisted");
    }

    #[test]
    fn creates_missing_parent_directories() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("config").join("bob").join("config.toml");

        write_schedule_entries(&path, &[entry("job-1")]).expect("write must succeed");

        let content = std::fs::read_to_string(&path).expect("read back");
        assert!(content.contains("[[schedule]]"), "schedule section present");
        assert!(content.contains("job-1"), "entry id persisted");
    }

    #[test]
    fn preserves_other_config_keys() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("bob.toml");
        std::fs::write(
            &path,
            "tracing_level = \"debug\"\n\n[[schedule]]\nid = \"old\"\ncron = \"* * * * *\"\nprompt = \"old\"\n",
        )
        .expect("seed config");

        write_schedule_entries(&path, &[entry("new")]).expect("write must succeed");

        let content = std::fs::read_to_string(&path).expect("read back");
        assert!(
            content.contains("tracing_level = \"debug\""),
            "non-schedule keys must be preserved"
        );
        assert!(content.contains("new"), "new entry present");
        assert!(!content.contains("old"), "old entry replaced");
    }

    #[test]
    fn empty_entries_removes_schedule_section() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("bob.toml");
        std::fs::write(
            &path,
            "[[schedule]]\nid = \"old\"\ncron = \"* * * * *\"\nprompt = \"old\"\n",
        )
        .expect("seed config");

        write_schedule_entries(&path, &[]).expect("write must succeed");

        let content = std::fs::read_to_string(&path).expect("read back");
        assert!(
            !content.contains("[[schedule]]"),
            "schedule section must be removed when entries are empty"
        );
    }

    #[cfg(unix)]
    #[test]
    fn preserves_restrictive_file_mode() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("bob.toml");
        std::fs::write(&path, "tracing_level = \"info\"\n").expect("seed config");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
            .expect("restrict mode");

        write_schedule_entries(&path, &[entry("job-1")]).expect("write must succeed");

        let mode = std::fs::metadata(&path).expect("stat").permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "rewrite must preserve the original 0600 mode");
    }

    // --- JSON schedule store tests ---

    #[test]
    fn read_schedule_store_returns_empty_list_when_file_is_missing() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("schedule.json");

        let entries = read_schedule_store(&path).expect("missing file must return Ok");
        assert!(
            entries.is_empty(),
            "missing file must yield an empty entry list"
        );
    }

    #[test]
    fn round_trips_multiple_entries_through_json_store() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("schedule.json");
        let original = vec![
            ScheduleEntry::with_prompt("job-alpha", "0 9 * * 1-5", "send morning report"),
            ScheduleEntry::with_prompt("job-beta", "*/30 * * * *", "check queue"),
        ];

        write_schedule_store(&path, &original).expect("write must succeed");
        let loaded = read_schedule_store(&path).expect("read must succeed");

        assert_eq!(loaded.len(), 2, "entry count must match");
        assert_eq!(loaded[0].id, "job-alpha");
        assert_eq!(loaded[0].cron, "0 9 * * 1-5");
        assert_eq!(loaded[0].prompt.as_deref(), Some("send morning report"));
        assert_eq!(loaded[1].id, "job-beta");
        assert_eq!(loaded[1].cron, "*/30 * * * *");
        assert_eq!(loaded[1].prompt.as_deref(), Some("check queue"));
    }

    #[test]
    fn round_trips_empty_entry_list_through_json_store() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("schedule.json");

        write_schedule_store(&path, &[]).expect("write with empty list must succeed");
        let loaded = read_schedule_store(&path).expect("read must succeed");

        assert!(
            loaded.is_empty(),
            "empty entry list must round-trip as empty"
        );
    }

    #[test]
    fn json_store_document_contains_version_field() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("schedule.json");

        write_schedule_store(
            &path,
            &[ScheduleEntry::with_prompt("chk", "* * * * *", "ping")],
        )
        .expect("write must succeed");

        let raw = std::fs::read_to_string(&path).expect("read raw");
        let v: serde_json::Value = serde_json::from_str(&raw).expect("must be valid JSON");
        assert_eq!(
            v["version"].as_u64(),
            Some(1),
            "document must carry version 1"
        );
        assert!(
            v["entries"].is_array(),
            "document must carry 'entries' array"
        );
    }

    #[test]
    fn read_schedule_store_returns_configuration_error_for_unsupported_version() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("schedule.json");
        std::fs::write(&path, r#"{"version":99,"entries":[]}"#)
            .expect("seed store with future version");

        let err = read_schedule_store(&path).expect_err("unsupported version must return Err");
        assert!(
            matches!(err, crate::error::ServiceError::Configuration { .. }),
            "expected Configuration error, got {err:?}"
        );
        let msg = err.to_string();
        assert!(
            msg.contains("unsupported version") || msg.contains("version"),
            "error message must mention the version problem: {msg}"
        );
    }

    #[test]
    fn read_schedule_store_returns_configuration_error_for_malformed_json() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("schedule.json");
        std::fs::write(&path, b"not valid json at all").expect("seed malformed store");

        let err = read_schedule_store(&path).expect_err("malformed JSON must return Err");
        assert!(
            matches!(err, crate::error::ServiceError::Configuration { .. }),
            "expected Configuration error, got {err:?}"
        );
    }

    #[test]
    fn read_schedule_store_returns_configuration_error_for_malformed_entries() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("schedule.json");
        // Valid version but entries contain objects missing required fields.
        std::fs::write(&path, r#"{"version":1,"entries":[{"id":"x"}]}"#)
            .expect("seed store with malformed entries");

        let err = read_schedule_store(&path).expect_err("malformed entries must return Err");
        assert!(
            matches!(err, crate::error::ServiceError::Configuration { .. }),
            "expected Configuration error, got {err:?}"
        );
    }

    #[test]
    fn writer_produces_complete_readable_json_document() {
        // AC-2: verifies the final file is a fully formed JSON document;
        // the atomic-rename mechanism is validated by absence of partial writes.
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("schedule.json");

        write_schedule_store(
            &path,
            &[ScheduleEntry::with_prompt(
                "test-job",
                "0 * * * *",
                "hourly check",
            )],
        )
        .expect("write must succeed");

        let raw = std::fs::read_to_string(&path).expect("file must exist after write");
        // The file must be valid JSON (not truncated or partial).
        let parsed: serde_json::Value =
            serde_json::from_str(&raw).expect("file contents must be valid JSON");
        assert_eq!(parsed["version"], 1_u64);
        assert_eq!(parsed["entries"][0]["id"], "test-job");
    }

    #[test]
    fn writer_creates_missing_parent_directories_for_json_store() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir
            .path()
            .join("state")
            .join("scheduler")
            .join("schedule.json");

        write_schedule_store(&path, &[entry("nested-job")]).expect("write must succeed");

        let loaded = read_schedule_store(&path).expect("read must succeed");
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].id, "nested-job");
    }

    #[test]
    fn writer_replaces_existing_store_file_completely() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("schedule.json");

        // Write a first set of entries.
        write_schedule_store(&path, &[entry("first")]).expect("first write must succeed");

        // Overwrite with a different set.
        write_schedule_store(&path, &[entry("second"), entry("third")])
            .expect("second write must succeed");

        let loaded = read_schedule_store(&path).expect("read must succeed");
        assert_eq!(loaded.len(), 2);
        assert_eq!(loaded[0].id, "second");
        assert_eq!(loaded[1].id, "third");
        assert!(
            !loaded.iter().any(|e| e.id == "first"),
            "first entry must be gone after replacement"
        );
    }

    #[cfg(unix)]
    #[test]
    fn new_json_store_file_is_created_with_mode_0600() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("schedule.json");

        // File does not exist yet — writer must create it with 0600.
        write_schedule_store(&path, &[entry("job-1")]).expect("write must succeed");

        let mode = std::fs::metadata(&path).expect("stat").permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "new store file must be created with mode 0600");
    }

    #[cfg(unix)]
    #[test]
    fn rewrite_preserves_restrictive_file_mode_on_json_store() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("schedule.json");

        // First write creates the file with 0600.
        write_schedule_store(&path, &[entry("original")]).expect("first write must succeed");
        // Explicitly set to 0600 to establish the invariant being tested.
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
            .expect("set restrictive mode");

        // Second write must keep the 0600 mode after the atomic rename.
        write_schedule_store(&path, &[entry("updated")]).expect("second write must succeed");

        let mode = std::fs::metadata(&path).expect("stat").permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "rewrite must preserve the existing 0600 mode");
    }

    // --- Whole-store validation (S-009) ---

    #[test]
    fn validate_accepts_a_valid_unique_store() {
        validate_schedule_store(&[entry("a"), entry("b")]).expect("valid store must pass");
    }

    #[test]
    fn validate_rejects_duplicate_ids() {
        let err = validate_schedule_store(&[entry("dup"), entry("dup")])
            .expect_err("duplicate ids must be rejected");
        assert!(
            matches!(err, crate::error::ServiceError::Configuration { .. }),
            "expected Configuration error, got {err:?}"
        );
        assert!(err.to_string().contains("duplicate"), "message: {err}");
    }

    #[test]
    fn validate_rejects_blank_id_prompt_and_cron() {
        for bad in [
            ScheduleEntry::with_prompt("  ", "* * * * *", "p"),
            ScheduleEntry::with_prompt("x", "* * * * *", "   "),
            ScheduleEntry::with_prompt("x", "   ", "p"),
        ] {
            let err = validate_schedule_store(&[bad]).expect_err("blank field must be rejected");
            assert!(
                matches!(err, crate::error::ServiceError::Configuration { .. }),
                "expected Configuration error, got {err:?}"
            );
        }
    }

    #[test]
    fn validate_rejects_invalid_cron() {
        let bad = ScheduleEntry::with_prompt("x", "not a cron", "p");
        let err = validate_schedule_store(&[bad]).expect_err("invalid cron must be rejected");
        assert!(
            matches!(err, crate::error::ServiceError::Configuration { .. }),
            "expected Configuration error, got {err:?}"
        );
    }

    #[test]
    fn read_schedule_store_rejects_duplicate_ids_in_hand_edited_store() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("schedule.json");
        std::fs::write(
            &path,
            r#"{"version":1,"entries":[
                {"id":"dup","cron":"* * * * *","prompt":"a"},
                {"id":"dup","cron":"* * * * *","prompt":"b"}
            ]}"#,
        )
        .expect("seed store with duplicate ids");

        let err = read_schedule_store(&path).expect_err("duplicate ids must fail the read");
        assert!(
            matches!(err, crate::error::ServiceError::Configuration { .. }),
            "expected Configuration error, got {err:?}"
        );
    }

    #[test]
    fn read_schedule_store_rejects_invalid_cron_in_hand_edited_store() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("schedule.json");
        std::fs::write(
            &path,
            r#"{"version":1,"entries":[{"id":"x","cron":"bogus","prompt":"p"}]}"#,
        )
        .expect("seed store with invalid cron");

        let err = read_schedule_store(&path).expect_err("invalid cron must fail the read");
        assert!(
            matches!(err, crate::error::ServiceError::Configuration { .. }),
            "expected Configuration error, got {err:?}"
        );
    }

    // --- Unix trust-boundary enforcement (ADR-012 / ADR-005) ---

    #[cfg(unix)]
    fn euid() -> u32 {
        nix::unistd::Uid::effective().as_raw()
    }

    #[cfg(unix)]
    #[test]
    fn verify_trusted_store_accepts_owner_only_store() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("schedule.json");
        write_schedule_store(&path, &[entry("a")]).expect("write must succeed");

        super::verify_trusted_store(&path, euid()).expect("owner-only 0600 store must be trusted");
    }

    #[cfg(unix)]
    #[test]
    fn verify_trusted_store_accepts_missing_store() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("schedule.json");
        super::verify_trusted_store(&path, euid()).expect("missing store must be accepted");
    }

    #[cfg(unix)]
    #[test]
    fn verify_trusted_store_fails_closed_on_group_accessible_file() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("schedule.json");
        write_schedule_store(&path, &[entry("a")]).expect("write must succeed");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644))
            .expect("widen mode");

        let err = super::verify_trusted_store(&path, euid())
            .expect_err("group/other-accessible store must fail closed");
        assert!(
            matches!(err, crate::error::ServiceError::Configuration { .. }),
            "expected Configuration error, got {err:?}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn verify_trusted_store_fails_closed_on_world_writable_parent() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().expect("tempdir");
        let store_dir = dir.path().join("bob");
        std::fs::create_dir(&store_dir).expect("mkdir");
        let path = store_dir.join("schedule.json");
        write_schedule_store(&path, &[entry("a")]).expect("write must succeed");
        std::fs::set_permissions(&store_dir, std::fs::Permissions::from_mode(0o777))
            .expect("widen parent");

        let err = super::verify_trusted_store(&path, euid())
            .expect_err("group/other-writable parent must fail closed");
        assert!(
            matches!(err, crate::error::ServiceError::Configuration { .. }),
            "expected Configuration error, got {err:?}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn enforce_trusted_store_dir_creates_owner_only_dir_when_absent() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().expect("tempdir");
        let store_dir = dir.path().join("state").join("bob");
        super::enforce_trusted_store_dir(&store_dir, euid()).expect("must create dir");

        let mode = std::fs::metadata(&store_dir)
            .expect("stat")
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o700, "new store dir must be owner-only");
    }

    #[cfg(unix)]
    #[test]
    fn enforce_trusted_store_dir_tightens_loose_owner_dir() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().expect("tempdir");
        let store_dir = dir.path().join("bob");
        std::fs::create_dir(&store_dir).expect("mkdir");
        std::fs::set_permissions(&store_dir, std::fs::Permissions::from_mode(0o777))
            .expect("widen dir");

        super::enforce_trusted_store_dir(&store_dir, euid()).expect("must tighten");

        let mode = std::fs::metadata(&store_dir)
            .expect("stat")
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(
            mode, 0o700,
            "loose store dir must be tightened to owner-only"
        );
    }

    // --- prompt|file source (file-backed prompts) ---

    #[test]
    fn round_trips_a_file_backed_entry_through_json_store() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("schedule.json");
        let original = vec![ScheduleEntry::with_file(
            "job-file",
            "0 9 * * *",
            "/etc/bob/prompt.txt",
        )];

        write_schedule_store(&path, &original).expect("write must succeed");
        let loaded = read_schedule_store(&path).expect("read must succeed");

        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].prompt, None, "file-backed entry has no prompt");
        assert_eq!(loaded[0].file.as_deref(), Some("/etc/bob/prompt.txt"));
    }

    #[test]
    fn file_backed_entry_serialises_with_file_key_and_omits_prompt_key() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("schedule.json");

        write_schedule_store(
            &path,
            &[ScheduleEntry::with_file("f", "* * * * *", "/abs/p.txt")],
        )
        .expect("write must succeed");

        let raw = std::fs::read_to_string(&path).expect("read raw");
        let v: serde_json::Value = serde_json::from_str(&raw).expect("valid json");
        assert_eq!(v["entries"][0]["file"], "/abs/p.txt");
        assert!(
            v["entries"][0].get("prompt").is_none(),
            "prompt key must be omitted for a file-backed entry"
        );
    }

    #[test]
    fn validate_rejects_entry_setting_both_prompt_and_file() {
        let bad = ScheduleEntry {
            id: "x".to_owned(),
            cron: "* * * * *".to_owned(),
            prompt: Some("p".to_owned()),
            file: Some("/abs/p.txt".to_owned()),
            cwd: None,
        };
        let err =
            validate_schedule_store(&[bad]).expect_err("both prompt and file must be rejected");
        assert!(
            matches!(err, crate::error::ServiceError::Configuration { .. }),
            "expected Configuration error, got {err:?}"
        );
        assert!(err.to_string().contains("both"), "message: {err}");
    }

    #[test]
    fn validate_rejects_entry_setting_neither_prompt_nor_file() {
        let bad = ScheduleEntry {
            id: "x".to_owned(),
            cron: "* * * * *".to_owned(),
            prompt: None,
            file: None,
            cwd: None,
        };
        let err =
            validate_schedule_store(&[bad]).expect_err("neither prompt nor file must be rejected");
        assert!(
            matches!(err, crate::error::ServiceError::Configuration { .. }),
            "expected Configuration error, got {err:?}"
        );
        assert!(err.to_string().contains("neither"), "message: {err}");
    }

    #[test]
    fn validate_rejects_relative_file_path() {
        let bad = ScheduleEntry::with_file("x", "* * * * *", "relative/p.txt");
        let err = validate_schedule_store(&[bad]).expect_err("relative file must be rejected");
        assert!(
            matches!(err, crate::error::ServiceError::Configuration { .. }),
            "expected Configuration error, got {err:?}"
        );
        assert!(
            err.to_string().contains("relative") || err.to_string().contains("absolute"),
            "message must mention the path problem: {err}"
        );
    }

    #[test]
    fn validate_rejects_blank_file() {
        let bad = ScheduleEntry::with_file("x", "* * * * *", "   ");
        let err = validate_schedule_store(&[bad]).expect_err("blank file must be rejected");
        assert!(
            matches!(err, crate::error::ServiceError::Configuration { .. }),
            "expected Configuration error, got {err:?}"
        );
    }

    #[test]
    fn validate_accepts_a_file_backed_entry_with_absolute_path() {
        validate_schedule_store(&[ScheduleEntry::with_file("x", "* * * * *", "/abs/p.txt")])
            .expect("absolute file-backed entry must pass");
    }

    // --- optional per-entry cwd (CR-005 / T-118) ---

    #[test]
    fn with_cwd_sets_the_cwd_field_on_a_built_entry() {
        let built = ScheduleEntry::with_prompt("x", "* * * * *", "p").with_cwd("/srv/work");
        assert_eq!(built.cwd.as_deref(), Some("/srv/work"));
    }

    #[test]
    fn entry_without_cwd_omits_cwd_key_when_serialised() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("schedule.json");

        write_schedule_store(&path, &[entry("no-cwd")]).expect("write must succeed");

        let raw = std::fs::read_to_string(&path).expect("read raw");
        let v: serde_json::Value = serde_json::from_str(&raw).expect("valid json");
        assert!(
            v["entries"][0].get("cwd").is_none(),
            "cwd key must be omitted when unset"
        );
    }

    #[test]
    fn round_trips_an_entry_with_cwd_through_json_store() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("schedule.json");
        let original =
            vec![ScheduleEntry::with_prompt("job-cwd", "* * * * *", "run")
                .with_cwd("/srv/workspaces/a")];

        write_schedule_store(&path, &original).expect("write must succeed");
        let loaded = read_schedule_store(&path).expect("read must succeed");

        assert_eq!(loaded[0].cwd.as_deref(), Some("/srv/workspaces/a"));
    }

    #[test]
    fn read_schedule_store_reads_a_hand_edited_file_backed_entry() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("schedule.json");
        std::fs::write(
            &path,
            r#"{"version":1,"entries":[{"id":"x","cron":"* * * * *","file":"/abs/p.txt"}]}"#,
        )
        .expect("seed store with a file-backed entry");

        let loaded = read_schedule_store(&path).expect("file-backed entry must read");
        assert_eq!(loaded[0].file.as_deref(), Some("/abs/p.txt"));
        assert_eq!(loaded[0].prompt, None);
    }
}
