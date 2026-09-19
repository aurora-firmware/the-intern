//! The `bob worklog` CLI surface.
//!
//! `bob worklog` is filesystem-only: like `bob init` and `bob task` it never
//! opens `admin.sock` or loads service configuration. It resolves the
//! worklog strictly to `<cwd>/worklog/<date>.md` (ADR-015) via the
//! caller-supplied working directory.

use std::{
    env, io,
    io::Write,
    path::{Path, PathBuf},
};

use bob_core::error::ServiceResult;
use chrono::{Local, NaiveDate, NaiveDateTime};
use serde::Serialize;
use serde_json::json;

use crate::worklog::{
    reconcile::is_same_day_duplicate,
    store::{RecordedEntry, WorklogEntry, WorklogStore},
};

use super::{invalid_request_error, write_json_line};

/// Date format shared by worklog file names and the `--date` flag.
const FILE_DATE_FORMAT: &str = "%Y-%m-%d";

/// The fixed worklog subdirectory name (ADR-015: `<cwd>/worklog/<date>.md`,
/// as this module's own header doc states). Used to report a suppressed
/// `append` call's day-file path without writing to it.
const WORKLOG_SUBDIR: &str = "worklog";

#[derive(Debug, Serialize)]
struct AppendedEntryOutput {
    item: String,
    path: String,
    /// Whether this call wrote a new entry (`true`) or suppressed an
    /// exact-match same-day repeat (`false`) — Contract, S-015 as amended
    /// by `CR-013`.
    written: bool,
    warnings: Vec<String>,
}

/// A single day's worklog, as `bob worklog list` renders it in text or JSON.
/// Carries only what is physically present in the requested day's file — no
/// cross-day-derived field of any kind (S-015 as amended by `CR-013`).
#[derive(Debug, Serialize)]
struct WorklogDayOutput {
    date: String,
    entries: Vec<WorklogEntryOutput>,
}

#[derive(Debug, Serialize)]
struct WorklogEntryOutput {
    time: String,
    item: String,
    done: String,
    left: String,
    next: String,
}

impl From<&RecordedEntry> for WorklogEntryOutput {
    fn from(entry: &RecordedEntry) -> Self {
        Self {
            time: entry.recorded_time.clone(),
            item: entry.item.clone(),
            done: entry.done.clone(),
            left: entry.left.clone(),
            next: entry.next.clone(),
        }
    }
}

pub(super) fn run_append(
    json_output: bool,
    item: &str,
    done: &str,
    left: &str,
    next: &str,
) -> ServiceResult<()> {
    let current_dir = env::current_dir()
        .map_err(|err| invalid_request_error(format!("current directory unavailable: {err}")))?;
    let mut out = io::stdout();
    run_append_with_context(
        json_output,
        item,
        done,
        left,
        next,
        Local::now().naive_local(),
        &current_dir,
        &mut out,
    )
}

fn run_append_with_context(
    json_output: bool,
    item: &str,
    done: &str,
    left: &str,
    next: &str,
    now: NaiveDateTime,
    working_dir: &Path,
    out: &mut impl Write,
) -> ServiceResult<()> {
    reject_entry_field("item", item)?;
    reject_entry_field("done", done)?;
    reject_entry_field("left", left)?;
    reject_entry_field("next", next)?;

    let entry = WorklogEntry {
        item: item.to_owned(),
        done: done.to_owned(),
        left: left.to_owned(),
        next: next.to_owned(),
    };

    let store = WorklogStore::new(working_dir);
    let today = now.date();
    // The worklog directory may not exist yet for the very first `append`
    // in a fresh working directory — `WorklogStore::append` below creates
    // it. Any read failure here, including a missing directory, is treated
    // as "no entries recorded yet today"; a genuine filesystem problem
    // still surfaces from the `append` call, which touches the same path.
    let todays_entries = store.read_day(today).unwrap_or_default();

    if is_same_day_duplicate(&todays_entries, &entry) {
        return write_appended_entry(
            out,
            json_output,
            AppendedEntryOutput {
                item: item.to_owned(),
                path: day_file_path(working_dir, today).display().to_string(),
                written: false,
                warnings: Vec::new(),
            },
        );
    }

    let outcome = store.append(now, &entry)?;

    write_appended_entry(
        out,
        json_output,
        AppendedEntryOutput {
            item: item.to_owned(),
            path: outcome.path.display().to_string(),
            written: true,
            warnings: outcome.warnings,
        },
    )
}

/// Where `date`'s worklog file lives, independent of whether it has been
/// written to yet by this call. Used to report a suppressed `append`
/// call's path without writing to it (the file must already exist in that
/// case, since suppression only triggers when the item already has an
/// entry there today).
fn day_file_path(working_dir: &Path, date: NaiveDate) -> PathBuf {
    working_dir
        .join(WORKLOG_SUBDIR)
        .join(format!("{}.md", date.format(FILE_DATE_FORMAT)))
}

pub(super) fn run_list(json_output: bool, date: Option<&str>) -> ServiceResult<()> {
    let current_dir = env::current_dir()
        .map_err(|err| invalid_request_error(format!("current directory unavailable: {err}")))?;
    let mut out = io::stdout();
    run_list_with_context(
        json_output,
        date,
        Local::now().naive_local(),
        &current_dir,
        &mut out,
    )
}

fn run_list_with_context(
    json_output: bool,
    date: Option<&str>,
    now: NaiveDateTime,
    working_dir: &Path,
    out: &mut impl Write,
) -> ServiceResult<()> {
    let target_date = match date {
        Some(raw) => parse_target_date(raw)?,
        None => now.date(),
    };

    // `read_day` fails, naming `<cwd>/worklog/`, when that directory does
    // not exist, and never creates it (ADR-015). The requested day's file
    // is read exactly as it physically stands, with no write of any kind
    // and no other day's file ever opened (S-015 as amended by `CR-013`).
    let entries = WorklogStore::new(working_dir).read_day(target_date)?;

    write_worklog_day(
        out,
        json_output,
        WorklogDayOutput {
            date: target_date.format(FILE_DATE_FORMAT).to_string(),
            entries: entries.iter().map(WorklogEntryOutput::from).collect(),
        },
    )
}

/// Parse a `--date` value, which must be an ISO `YYYY-MM-DD` calendar date.
fn parse_target_date(raw: &str) -> ServiceResult<NaiveDate> {
    NaiveDate::parse_from_str(raw, FILE_DATE_FORMAT).map_err(|err| {
        invalid_request_error(format!(
            "worklog list --date must be a YYYY-MM-DD date: {err}"
        ))
    })
}

fn write_worklog_day(
    out: &mut impl Write,
    json_output: bool,
    day: WorklogDayOutput,
) -> ServiceResult<()> {
    if json_output {
        return write_json_line(out, &json!(day));
    }

    write_worklog_day_text(out, &day)
        .map_err(|err| invalid_request_error(format!("failed to write worklog output: {err}")))
}

fn write_worklog_day_text(out: &mut impl Write, day: &WorklogDayOutput) -> io::Result<()> {
    writeln!(out, "worklog for {}", day.date)?;
    if day.entries.is_empty() {
        writeln!(out, "(no entries)")?;
    }
    for entry in &day.entries {
        writeln!(out)?;
        writeln!(out, "## {} — {}", entry.time, entry.item)?;
        writeln!(out, "- Done: {}", entry.done)?;
        writeln!(out, "- Left: {}", entry.left)?;
        writeln!(out, "- Next: {}", entry.next)?;
    }
    Ok(())
}

fn write_appended_entry(
    out: &mut impl Write,
    json_output: bool,
    response: AppendedEntryOutput,
) -> ServiceResult<()> {
    if json_output {
        return write_json_line(out, &json!(response));
    }

    let summary = if response.written {
        format!("recorded worklog entry: {}", response.item)
    } else {
        format!("suppressed duplicate worklog entry: {}", response.item)
    };

    writeln!(out, "{summary}")
        .and_then(|_| writeln!(out, "path: {}", response.path))
        .and_then(|_| write_warnings(out, &response.warnings))
        .map_err(|err| invalid_request_error(format!("failed to write worklog output: {err}")))
}

fn write_warnings(out: &mut impl Write, warnings: &[String]) -> io::Result<()> {
    for warning in warnings {
        writeln!(out, "warning: {warning}")?;
    }
    Ok(())
}

/// Reject an absent-in-spirit or multiline worklog entry field before any
/// filesystem work happens. `clap` already rejects a wholly missing flag;
/// this guards the `--field ""`, all-whitespace, and line-break cases.
fn reject_entry_field(name: &str, value: &str) -> ServiceResult<()> {
    if value.trim().is_empty() {
        return Err(invalid_request_error(format!(
            "worklog entry field --{name} must not be empty"
        )));
    }
    if value.contains(['\n', '\r']) {
        return Err(invalid_request_error(format!(
            "worklog entry field --{name} must not contain line breaks"
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use chrono::{NaiveDate, NaiveDateTime, NaiveTime};
    use serde_json::Value;

    use super::{run_append_with_context, run_list_with_context};
    use crate::worklog::store::{WorklogEntry, WorklogStore};

    fn at(date: (i32, u32, u32), time: (u32, u32)) -> NaiveDateTime {
        NaiveDate::from_ymd_opt(date.0, date.1, date.2)
            .expect("valid date")
            .and_time(NaiveTime::from_hms_opt(time.0, time.1, 0).expect("valid time"))
    }

    fn on(date: (i32, u32, u32)) -> NaiveDate {
        NaiveDate::from_ymd_opt(date.0, date.1, date.2).expect("valid date")
    }

    fn expect_invalid_request(result: bob_core::error::ServiceResult<()>) -> String {
        match result.expect_err("expected an invalid-request error") {
            bob_core::error::ServiceError::InvalidRequest { detail } => detail,
            other => panic!("expected InvalidRequest, got {other:?}"),
        }
    }

    fn expect_persistence_error(result: bob_core::error::ServiceResult<()>) -> String {
        match result.expect_err("expected a persistence error") {
            bob_core::error::ServiceError::Persistence { detail } => detail,
            other => panic!("expected Persistence, got {other:?}"),
        }
    }

    #[test]
    fn worklog_append_rejects_an_empty_item_field_before_touching_the_filesystem() {
        let temp = tempfile::tempdir().expect("temp dir");
        let mut out = Vec::new();

        let detail = expect_invalid_request(run_append_with_context(
            false,
            "   ",
            "did the thing",
            "still open",
            "the trigger",
            at((2026, 8, 30), (9, 5)),
            temp.path(),
            &mut out,
        ));

        assert!(
            detail.contains("item"),
            "error must name the field: {detail}"
        );
        assert!(
            !temp.path().join("worklog").exists(),
            "invalid input must fail before touching the filesystem"
        );
        assert!(out.is_empty(), "no output on validation failure");
    }

    #[test]
    fn worklog_append_rejects_an_empty_done_field_before_touching_the_filesystem() {
        let temp = tempfile::tempdir().expect("temp dir");
        let mut out = Vec::new();

        let detail = expect_invalid_request(run_append_with_context(
            false,
            "vendor-invoice",
            "",
            "still open",
            "the trigger",
            at((2026, 8, 30), (9, 5)),
            temp.path(),
            &mut out,
        ));

        assert!(
            detail.contains("done"),
            "error must name the field: {detail}"
        );
        assert!(!temp.path().join("worklog").exists());
    }

    #[test]
    fn worklog_append_rejects_an_empty_left_field_before_touching_the_filesystem() {
        let temp = tempfile::tempdir().expect("temp dir");
        let mut out = Vec::new();

        let detail = expect_invalid_request(run_append_with_context(
            false,
            "vendor-invoice",
            "did the thing",
            "   ",
            "the trigger",
            at((2026, 8, 30), (9, 5)),
            temp.path(),
            &mut out,
        ));

        assert!(
            detail.contains("left"),
            "error must name the field: {detail}"
        );
        assert!(!temp.path().join("worklog").exists());
    }

    #[test]
    fn worklog_append_rejects_an_empty_next_field_before_touching_the_filesystem() {
        let temp = tempfile::tempdir().expect("temp dir");
        let mut out = Vec::new();

        let detail = expect_invalid_request(run_append_with_context(
            false,
            "vendor-invoice",
            "did the thing",
            "still open",
            "",
            at((2026, 8, 30), (9, 5)),
            temp.path(),
            &mut out,
        ));

        assert!(
            detail.contains("next"),
            "error must name the field: {detail}"
        );
        assert!(!temp.path().join("worklog").exists());
    }

    #[test]
    fn worklog_append_rejects_multiline_fields_before_touching_the_filesystem() {
        let temp = tempfile::tempdir().expect("temp dir");
        let mut out = Vec::new();

        let detail = expect_invalid_request(run_append_with_context(
            false,
            "vendor-invoice",
            "line one\nline two",
            "still open",
            "the trigger",
            at((2026, 8, 30), (9, 5)),
            temp.path(),
            &mut out,
        ));

        assert!(
            detail.contains("done") && detail.contains("line breaks"),
            "error must name the multiline field and why: {detail}"
        );
        assert!(
            !temp.path().join("worklog").exists(),
            "multiline input must fail before touching the filesystem"
        );
        assert!(out.is_empty(), "no output on validation failure");
    }

    #[test]
    fn worklog_append_leaves_an_existing_day_file_untouched_when_a_field_is_empty() {
        let temp = tempfile::tempdir().expect("temp dir");
        WorklogStore::new(temp.path())
            .append(
                at((2026, 8, 30), (8, 0)),
                &WorklogEntry {
                    item: "existing".to_owned(),
                    done: "earlier work".to_owned(),
                    left: "still open".to_owned(),
                    next: "the trigger".to_owned(),
                },
            )
            .expect("seed today's file");
        let day_path = temp.path().join("worklog").join("2026-08-30.md");
        let before = std::fs::read_to_string(&day_path).expect("day file");
        let mut out = Vec::new();

        let detail = expect_invalid_request(run_append_with_context(
            false,
            "new-item",
            "did the thing",
            "   ",
            "the trigger",
            at((2026, 8, 30), (9, 5)),
            temp.path(),
            &mut out,
        ));

        assert!(detail.contains("left"));
        let after = std::fs::read_to_string(&day_path).expect("day file");
        assert_eq!(
            before, after,
            "the day file must be unchanged on validation failure"
        );
    }

    #[test]
    fn worklog_append_writes_the_entry_to_todays_file() {
        let temp = tempfile::tempdir().expect("temp dir");
        let mut out = Vec::new();

        run_append_with_context(
            false,
            "vendor-invoice",
            "Chased the vendor for the missing PDF.",
            "awaiting the corrected invoice",
            "closes when the corrected invoice arrives",
            at((2026, 8, 30), (9, 5)),
            temp.path(),
            &mut out,
        )
        .expect("append should succeed");

        let entries = WorklogStore::new(temp.path())
            .read_day(on((2026, 8, 30)))
            .expect("read today");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].item, "vendor-invoice");
        assert_eq!(entries[0].done, "Chased the vendor for the missing PDF.");
        assert_eq!(entries[0].left, "awaiting the corrected invoice");
        assert_eq!(entries[0].next, "closes when the corrected invoice arrives");
    }

    #[test]
    #[cfg(unix)]
    fn worklog_append_surfaces_permissive_directory_warnings_in_text_and_json() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().expect("temp dir");
        let worklog_dir = temp.path().join("worklog");
        std::fs::create_dir(&worklog_dir).expect("pre-create worklog dir");
        std::fs::set_permissions(&worklog_dir, std::fs::Permissions::from_mode(0o755))
            .expect("relax perms");
        let mut text_out = Vec::new();
        let mut json_out = Vec::new();

        run_append_with_context(
            false,
            "text-item",
            "Did today's work.",
            "nothing",
            "nothing further",
            at((2026, 8, 30), (9, 0)),
            temp.path(),
            &mut text_out,
        )
        .expect("append should succeed");
        run_append_with_context(
            true,
            "json-item",
            "Did today's work.",
            "nothing",
            "nothing further",
            at((2026, 8, 30), (9, 5)),
            temp.path(),
            &mut json_out,
        )
        .expect("append should succeed");

        let text = String::from_utf8(text_out).expect("utf8");
        assert!(
            text.contains("warning: worklog directory") && text.contains("755"),
            "text output must surface the warning: {text}"
        );

        let value: Value = serde_json::from_slice(&json_out).expect("json object");
        let warnings: Vec<&str> = value["warnings"]
            .as_array()
            .expect("warnings array")
            .iter()
            .map(|entry| entry.as_str().expect("warning string"))
            .collect();
        assert_eq!(warnings.len(), 1);
        assert!(
            warnings[0].contains("755"),
            "json warning must include the mode"
        );
    }

    #[test]
    fn worklog_append_reports_written_true_in_text_and_json_when_a_new_entry_is_written() {
        let temp = tempfile::tempdir().expect("temp dir");
        let mut json_out = Vec::new();
        let mut text_out = Vec::new();

        run_append_with_context(
            true,
            "todays-item",
            "Handled entirely today.",
            "nothing",
            "nothing further",
            at((2026, 8, 30), (9, 0)),
            temp.path(),
            &mut json_out,
        )
        .expect("append should succeed");
        run_append_with_context(
            false,
            "another-item",
            "Also handled today.",
            "nothing",
            "nothing further",
            at((2026, 8, 30), (10, 0)),
            temp.path(),
            &mut text_out,
        )
        .expect("append should succeed");

        let value: Value = serde_json::from_slice(&json_out).expect("json object");
        assert_eq!(value["written"], serde_json::json!(true));

        let text = String::from_utf8(text_out).expect("utf8");
        assert!(
            text.contains("recorded worklog entry: another-item"),
            "a written entry must be reported as recorded, not suppressed: {text}"
        );
    }

    #[test]
    fn worklog_append_reports_suppressed_in_text_and_json_and_writes_nothing_for_an_exact_duplicate_repeat(
    ) {
        let temp = tempfile::tempdir().expect("temp dir");
        let store = WorklogStore::new(temp.path());
        store
            .append(
                at((2026, 8, 30), (9, 0)),
                &WorklogEntry {
                    item: "vendor-invoice".to_owned(),
                    done: "Chased the vendor.".to_owned(),
                    left: "awaiting the corrected invoice".to_owned(),
                    next: "closes when the corrected invoice arrives".to_owned(),
                },
            )
            .expect("seed today's entry");
        let mut json_out = Vec::new();
        let mut text_out = Vec::new();

        run_append_with_context(
            true,
            "vendor-invoice",
            "Chased the vendor.",
            "awaiting the corrected invoice",
            "closes when the corrected invoice arrives",
            at((2026, 8, 30), (11, 0)),
            temp.path(),
            &mut json_out,
        )
        .expect("a suppressed duplicate must still be a successful call");
        run_append_with_context(
            false,
            "vendor-invoice",
            "Chased the vendor.",
            "awaiting the corrected invoice",
            "closes when the corrected invoice arrives",
            at((2026, 8, 30), (12, 0)),
            temp.path(),
            &mut text_out,
        )
        .expect("a suppressed duplicate must still be a successful call");

        let value: Value = serde_json::from_slice(&json_out).expect("json object");
        assert_eq!(value["written"], serde_json::json!(false));

        let text = String::from_utf8(text_out).expect("utf8");
        assert!(
            !text.contains("recorded worklog entry:"),
            "a suppressed call must not read as a successful write: {text}"
        );

        let entries = store.read_day(on((2026, 8, 30))).expect("read today");
        assert_eq!(
            entries.len(),
            1,
            "a suppressed duplicate must not add a second entry: {entries:?}"
        );
    }

    #[test]
    fn worklog_list_renders_entries_ordered_by_time_not_write_order() {
        let temp = tempfile::tempdir().expect("temp dir");
        let store = WorklogStore::new(temp.path());
        for (time, item) in [
            ((14, 0), "afternoon-item"),
            ((8, 30), "early-item"),
            ((11, 15), "midday-item"),
        ] {
            store
                .append(
                    at((2026, 8, 30), time),
                    &WorklogEntry {
                        item: item.to_owned(),
                        done: "did some work".to_owned(),
                        left: "nothing".to_owned(),
                        next: "nothing further".to_owned(),
                    },
                )
                .expect("seed today's entry");
        }
        let mut out = Vec::new();

        run_list_with_context(
            false,
            None,
            at((2026, 8, 30), (15, 0)),
            temp.path(),
            &mut out,
        )
        .expect("list should succeed");

        let text = String::from_utf8(out).expect("utf8");
        let early = text.find("early-item").expect("early-item rendered");
        let midday = text.find("midday-item").expect("midday-item rendered");
        let afternoon = text
            .find("afternoon-item")
            .expect("afternoon-item rendered");
        assert!(
            early < midday && midday < afternoon,
            "entries must be ordered by HH:MM, not by write order: {text}"
        );
    }

    #[test]
    fn worklog_list_errors_naming_the_worklog_directory_when_it_is_absent() {
        let temp = tempfile::tempdir().expect("temp dir");
        let mut out = Vec::new();

        let detail = expect_persistence_error(run_list_with_context(
            false,
            None,
            at((2026, 8, 30), (9, 0)),
            temp.path(),
            &mut out,
        ));

        let expected_dir = temp.path().join("worklog");
        assert!(
            detail.contains(&expected_dir.display().to_string()),
            "the error must name the worklog directory it looked for: {detail}"
        );
        assert!(
            !expected_dir.exists(),
            "list must not create the worklog directory"
        );
        assert!(
            out.is_empty(),
            "no output is written when the worklog directory is absent"
        );
    }

    #[test]
    fn worklog_list_rejects_a_malformed_date_flag_before_touching_the_filesystem() {
        let temp = tempfile::tempdir().expect("temp dir");
        let mut out = Vec::new();

        let detail = expect_invalid_request(run_list_with_context(
            false,
            Some("30 August 2026"),
            at((2026, 8, 30), (9, 0)),
            temp.path(),
            &mut out,
        ));

        assert!(
            detail.contains("YYYY-MM-DD"),
            "the error must name the expected date shape: {detail}"
        );
        assert!(
            !temp.path().join("worklog").exists(),
            "a malformed --date must fail before any filesystem work"
        );
        assert!(out.is_empty(), "no output on a malformed --date");
    }

    #[test]
    fn worklog_append_output_never_includes_a_carried_forward_field_in_text_or_json() {
        let temp = tempfile::tempdir().expect("temp dir");
        let mut text_out = Vec::new();
        let mut json_out = Vec::new();

        run_append_with_context(
            false,
            "todays-item",
            "Handled entirely today.",
            "nothing",
            "nothing further",
            at((2026, 8, 30), (9, 0)),
            temp.path(),
            &mut text_out,
        )
        .expect("append should succeed");
        run_append_with_context(
            true,
            "another-item",
            "Also handled today.",
            "nothing",
            "nothing further",
            at((2026, 8, 30), (10, 0)),
            temp.path(),
            &mut json_out,
        )
        .expect("append should succeed");

        let text = String::from_utf8(text_out).expect("utf8");
        assert!(
            !text.to_lowercase().contains("carried forward"),
            "append output must not mention carried forward at all: {text}"
        );
        let value: Value = serde_json::from_slice(&json_out).expect("json object");
        assert!(
            value.get("carried_forward").is_none(),
            "append JSON output must not include a carried_forward field: {value}"
        );
    }

    #[test]
    fn worklog_list_output_never_includes_a_carried_forward_field_in_text_or_json() {
        let temp = tempfile::tempdir().expect("temp dir");
        WorklogStore::new(temp.path())
            .append(
                at((2026, 8, 30), (9, 0)),
                &WorklogEntry {
                    item: "todays-item".to_owned(),
                    done: "Handled entirely today.".to_owned(),
                    left: "nothing".to_owned(),
                    next: "nothing further".to_owned(),
                },
            )
            .expect("seed today's own entry");
        let mut text_out = Vec::new();
        let mut json_out = Vec::new();

        run_list_with_context(
            false,
            None,
            at((2026, 8, 30), (10, 0)),
            temp.path(),
            &mut text_out,
        )
        .expect("list should succeed");
        run_list_with_context(
            true,
            None,
            at((2026, 8, 30), (10, 0)),
            temp.path(),
            &mut json_out,
        )
        .expect("list should succeed");

        let text = String::from_utf8(text_out).expect("utf8");
        assert!(
            !text.to_lowercase().contains("carried forward"),
            "list output must not mention carried forward at all: {text}"
        );
        let value: Value = serde_json::from_slice(&json_out).expect("json object");
        assert!(
            value.get("carried_forward").is_none(),
            "list JSON output must not include a carried_forward field: {value}"
        );
    }

    #[test]
    fn worklog_list_performs_no_write_of_any_kind_to_the_requested_days_file() {
        let temp = tempfile::tempdir().expect("temp dir");
        let store = WorklogStore::new(temp.path());
        store
            .append(
                at((2026, 8, 30), (9, 0)),
                &WorklogEntry {
                    item: "todays-item".to_owned(),
                    done: "Handled entirely today.".to_owned(),
                    left: "nothing".to_owned(),
                    next: "nothing further".to_owned(),
                },
            )
            .expect("seed today's entry");
        let day_path = temp.path().join("worklog").join("2026-08-30.md");
        let before = std::fs::read_to_string(&day_path).expect("day file");
        let mut out = Vec::new();

        run_list_with_context(
            false,
            None,
            at((2026, 8, 30), (10, 0)),
            temp.path(),
            &mut out,
        )
        .expect("list should succeed");

        let after = std::fs::read_to_string(&day_path).expect("day file");
        assert_eq!(
            before, after,
            "list must never write to the requested day's file as a side effect"
        );
    }
}
