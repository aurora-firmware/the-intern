use std::path::Path;

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
/// carries an unrecognised `version` field, or contains entries that do not
/// match the expected shape.
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

    Ok(doc.entries)
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

    std::fs::write(&tmp_path, &content).map_err(|e| ServiceError::Persistence {
        detail: format!(
            "failed to write temp schedule store {}: {e}",
            tmp_path.display()
        ),
    })?;

    // Apply file permissions to the temp file before the rename.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = existing_mode.unwrap_or(0o600);
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

/// A validated schedule job entry sourced from the `[[schedule]]` TOML section.
///
/// `id` is the unique string identifier for the job, `cron` is a standard
/// 5-field cron expression (minute hour day-of-month month day-of-week), and
/// `prompt` is the non-empty text sent to the agent when the job fires.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ScheduleEntry {
    pub id: String,
    pub cron: String,
    pub prompt: String,
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
            table.insert("prompt", toml_edit::value(entry.prompt.as_str()));
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
    use super::{read_schedule_store, write_schedule_entries, write_schedule_store, ScheduleEntry};

    fn entry(id: &str) -> ScheduleEntry {
        ScheduleEntry {
            id: id.to_owned(),
            cron: "* * * * *".to_owned(),
            prompt: "do the thing".to_owned(),
        }
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
            ScheduleEntry {
                id: "job-alpha".to_owned(),
                cron: "0 9 * * 1-5".to_owned(),
                prompt: "send morning report".to_owned(),
            },
            ScheduleEntry {
                id: "job-beta".to_owned(),
                cron: "*/30 * * * *".to_owned(),
                prompt: "check queue".to_owned(),
            },
        ];

        write_schedule_store(&path, &original).expect("write must succeed");
        let loaded = read_schedule_store(&path).expect("read must succeed");

        assert_eq!(loaded.len(), 2, "entry count must match");
        assert_eq!(loaded[0].id, "job-alpha");
        assert_eq!(loaded[0].cron, "0 9 * * 1-5");
        assert_eq!(loaded[0].prompt, "send morning report");
        assert_eq!(loaded[1].id, "job-beta");
        assert_eq!(loaded[1].cron, "*/30 * * * *");
        assert_eq!(loaded[1].prompt, "check queue");
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
            &[ScheduleEntry {
                id: "chk".to_owned(),
                cron: "* * * * *".to_owned(),
                prompt: "ping".to_owned(),
            }],
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
            &[ScheduleEntry {
                id: "test-job".to_owned(),
                cron: "0 * * * *".to_owned(),
                prompt: "hourly check".to_owned(),
            }],
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
}
