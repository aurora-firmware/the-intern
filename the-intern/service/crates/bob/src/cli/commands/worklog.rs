//! The `bob worklog` CLI surface.
//!
//! `bob worklog` is filesystem-only: like `bob init` and `bob task` it never
//! opens `admin.sock` or loads service configuration. It resolves the
//! worklog strictly to `<cwd>/worklog/<date>.md` (ADR-015) via the
//! caller-supplied working directory.

use std::{env, io, io::Write, path::Path};

use bob_core::error::ServiceResult;
use chrono::{Local, NaiveDate, NaiveDateTime};
use serde::Serialize;
use serde_json::json;

use crate::worklog::{
    reconcile::reconcile_today,
    store::{RecordedEntry, WorklogEntry, WorklogStore},
};

use super::{invalid_request_error, write_json_line};

/// Date format shared by worklog file names and the `--date` flag.
const FILE_DATE_FORMAT: &str = "%Y-%m-%d";

#[derive(Debug, Serialize)]
struct AppendedEntryOutput {
    item: String,
    path: String,
    carried_forward: Vec<String>,
    warnings: Vec<String>,
}

/// A single day's worklog, as `bob worklog list` renders it in text or JSON.
#[derive(Debug, Serialize)]
struct WorklogDayOutput {
    date: String,
    entries: Vec<WorklogEntryOutput>,
    /// Today's full carried-forward item-identifier set, always today's and
    /// independent of which invocation performed the carry-forward write.
    carried_forward: Vec<String>,
    warnings: Vec<String>,
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

    // Reconcile today's file (carry forward any still-open items from the
    // most recent prior worklog file) before this entry is written. The
    // returned set is today's full carried-forward item-identifier set.
    let reconcile = reconcile_today(working_dir, now)?;

    let entry = WorklogEntry {
        item: item.to_owned(),
        done: done.to_owned(),
        left: left.to_owned(),
        next: next.to_owned(),
    };
    let outcome = WorklogStore::new(working_dir).append(now, &entry)?;
    let mut warnings = reconcile.warnings;
    warnings.extend(outcome.warnings);
    warnings.sort();
    warnings.dedup();

    write_appended_entry(
        out,
        json_output,
        AppendedEntryOutput {
            item: item.to_owned(),
            path: outcome.path.display().to_string(),
            carried_forward: reconcile.carried_forward,
            warnings,
        },
    )
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

    // Reconciliation runs first, unconditionally, against TODAY'S file
    // (S-015 Design Principles: "every entry point that touches today's
    // file performs reconciliation first, unconditionally"), regardless of
    // `--date`. It never writes to a past-dated file, and when `worklog/`
    // is absent it is a no-op that creates nothing. The returned set is
    // today's full carried-forward item-identifier set.
    let reconcile = reconcile_today(working_dir, now)?;

    // `read_day` fails, naming `<cwd>/worklog/`, when that directory does
    // not exist, and never creates it (ADR-015). A past-dated file is read
    // exactly as it is on disk.
    let entries = WorklogStore::new(working_dir).read_day(target_date)?;

    write_worklog_day(
        out,
        json_output,
        WorklogDayOutput {
            date: target_date.format(FILE_DATE_FORMAT).to_string(),
            entries: entries.iter().map(WorklogEntryOutput::from).collect(),
            carried_forward: reconcile.carried_forward,
            warnings: reconcile.warnings,
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
    writeln!(out)?;
    writeln!(
        out,
        "carried forward: {}",
        format_carried_forward(&day.carried_forward)
    )?;
    write_warnings(out, &day.warnings)
}

fn write_appended_entry(
    out: &mut impl Write,
    json_output: bool,
    response: AppendedEntryOutput,
) -> ServiceResult<()> {
    if json_output {
        return write_json_line(out, &json!(response));
    }

    writeln!(out, "recorded worklog entry: {}", response.item)
        .and_then(|_| writeln!(out, "path: {}", response.path))
        .and_then(|_| {
            writeln!(
                out,
                "carried forward: {}",
                format_carried_forward(&response.carried_forward)
            )
        })
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

fn format_carried_forward(items: &[String]) -> String {
    if items.is_empty() {
        return "(none)".to_owned();
    }
    items.join(", ")
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

    /// Seed a prior day's worklog file holding one still-open item, so a
    /// later reconciliation pass has something to carry forward.
    fn seed_prior_open_item(working_dir: &std::path::Path) {
        WorklogStore::new(working_dir)
            .append(
                at((2026, 8, 29), (9, 0)),
                &WorklogEntry {
                    item: "vendor-invoice".to_owned(),
                    done: "Chased the vendor for the missing PDF.".to_owned(),
                    left: "awaiting the corrected invoice".to_owned(),
                    next: "closes when the corrected invoice arrives".to_owned(),
                },
            )
            .expect("seed prior day");
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
    fn worklog_append_runs_reconciliation_before_writing_its_own_entry() {
        let temp = tempfile::tempdir().expect("temp dir");
        seed_prior_open_item(temp.path());
        let mut out = Vec::new();

        run_append_with_context(
            false,
            "todays-item",
            "Did today's work.",
            "still going",
            "closes tomorrow",
            at((2026, 8, 30), (9, 0)),
            temp.path(),
            &mut out,
        )
        .expect("append should succeed");

        let day_path = temp.path().join("worklog").join("2026-08-30.md");
        let content = std::fs::read_to_string(&day_path).expect("today's file");

        let carried_at = content
            .find("Carried forward from 2026-08-29.md")
            .expect("reconciliation must carry the open prior item into today's file");
        let own_at = content
            .find("Did today's work.")
            .expect("the handler's own entry must be present");
        assert!(
            carried_at < own_at,
            "the carried-forward entry must be written before the handler's own entry:\n{content}"
        );
    }

    #[test]
    fn worklog_append_prints_a_human_readable_confirmation_with_the_carried_forward_set() {
        let temp = tempfile::tempdir().expect("temp dir");
        seed_prior_open_item(temp.path());
        let mut out = Vec::new();

        run_append_with_context(
            false,
            "todays-item",
            "Did today's work.",
            "still going",
            "closes tomorrow",
            at((2026, 8, 30), (9, 0)),
            temp.path(),
            &mut out,
        )
        .expect("append should succeed");

        let text = String::from_utf8(out).expect("utf8");
        assert!(
            text.contains("todays-item"),
            "confirmation names the recorded item: {text}"
        );
        assert!(
            text.contains("carried forward:") && text.contains("vendor-invoice"),
            "confirmation lists today's carried-forward set: {text}"
        );
    }

    #[test]
    fn worklog_append_json_output_includes_the_carried_forward_set() {
        let temp = tempfile::tempdir().expect("temp dir");
        seed_prior_open_item(temp.path());
        let mut out = Vec::new();

        run_append_with_context(
            true,
            "todays-item",
            "Did today's work.",
            "still going",
            "closes tomorrow",
            at((2026, 8, 30), (9, 0)),
            temp.path(),
            &mut out,
        )
        .expect("append should succeed");

        let value: Value = serde_json::from_slice(&out).expect("json object");
        assert_eq!(value["item"], "todays-item");
        let carried: Vec<&str> = value["carried_forward"]
            .as_array()
            .expect("carried_forward array")
            .iter()
            .map(|entry| entry.as_str().expect("string identifier"))
            .collect();
        assert_eq!(carried, vec!["vendor-invoice"]);
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
    fn worklog_append_reports_an_empty_carried_forward_set_when_no_prior_file_exists() {
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
        assert_eq!(
            value["carried_forward"]
                .as_array()
                .expect("carried_forward array")
                .len(),
            0
        );

        let text = String::from_utf8(text_out).expect("utf8");
        assert!(
            text.contains("carried forward: (none)"),
            "an empty set is still reported explicitly: {text}"
        );
    }

    #[test]
    fn worklog_list_reconciles_todays_file_first_and_reads_a_past_date_as_is() {
        let temp = tempfile::tempdir().expect("temp dir");
        // A prior day's file holding one still-open item.
        WorklogStore::new(temp.path())
            .append(
                at((2026, 8, 28), (9, 0)),
                &WorklogEntry {
                    item: "vendor-invoice".to_owned(),
                    done: "Chased the vendor for the missing PDF.".to_owned(),
                    left: "awaiting the corrected invoice".to_owned(),
                    next: "closes when the corrected invoice arrives".to_owned(),
                },
            )
            .expect("seed prior day");
        let past_path = temp.path().join("worklog").join("2026-08-28.md");
        let past_before = std::fs::read_to_string(&past_path).expect("past day file");
        let mut out = Vec::new();

        run_list_with_context(
            false,
            Some("2026-08-28"),
            at((2026, 8, 30), (8, 15)),
            temp.path(),
            &mut out,
        )
        .expect("list should succeed");

        // The past-dated file is rendered as-is and never written to.
        let past_after = std::fs::read_to_string(&past_path).expect("past day file");
        assert_eq!(
            past_before, past_after,
            "a past target date must be read as-is, never reconciled or rewritten"
        );
        let text = String::from_utf8(out).expect("utf8");
        assert!(
            text.contains("2026-08-28") && text.contains("vendor-invoice"),
            "the output must render the requested past day's entries: {text}"
        );

        // Reconciliation still ran against TODAY'S file (2026-08-30),
        // carrying the open prior item forward into it.
        let today = std::fs::read_to_string(temp.path().join("worklog").join("2026-08-30.md"))
            .expect("reconciliation must create and populate today's file");
        assert!(
            today.contains("Carried forward from 2026-08-28.md"),
            "reconciliation against today's file must run before output: {today}"
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

    /// Seed a prior day's file with one still-open `vendor-invoice` item.
    fn seed_prior_open_vendor_invoice(working_dir: &std::path::Path) {
        WorklogStore::new(working_dir)
            .append(
                at((2026, 8, 29), (9, 0)),
                &WorklogEntry {
                    item: "vendor-invoice".to_owned(),
                    done: "Chased the vendor for the missing PDF.".to_owned(),
                    left: "awaiting the corrected invoice".to_owned(),
                    next: "closes when the corrected invoice arrives".to_owned(),
                },
            )
            .expect("seed prior open item");
    }

    #[test]
    fn worklog_list_text_output_reports_todays_carried_forward_set() {
        let temp = tempfile::tempdir().expect("temp dir");
        seed_prior_open_vendor_invoice(temp.path());
        let mut out = Vec::new();

        run_list_with_context(
            false,
            None,
            at((2026, 8, 30), (9, 0)),
            temp.path(),
            &mut out,
        )
        .expect("list should succeed");

        let text = String::from_utf8(out).expect("utf8");
        assert!(
            text.contains("carried forward: vendor-invoice"),
            "text output must report today's carried-forward set: {text}"
        );
    }

    #[test]
    fn worklog_list_json_output_is_an_object_carrying_the_same_facts_as_the_text() {
        let temp = tempfile::tempdir().expect("temp dir");
        seed_prior_open_vendor_invoice(temp.path());
        let mut out = Vec::new();

        run_list_with_context(true, None, at((2026, 8, 30), (9, 0)), temp.path(), &mut out)
            .expect("list should succeed");

        let value: Value = serde_json::from_slice(&out).expect("json object");
        assert_eq!(value["date"], "2026-08-30");
        assert!(
            !value["entries"]
                .as_array()
                .expect("entries array")
                .is_empty(),
            "the carried-forward entry is part of today's rendered entries: {value}"
        );
        let carried: Vec<&str> = value["carried_forward"]
            .as_array()
            .expect("carried_forward array")
            .iter()
            .map(|item| item.as_str().expect("string identifier"))
            .collect();
        assert_eq!(carried, vec!["vendor-invoice"]);
    }

    #[test]
    #[cfg(unix)]
    fn worklog_list_surfaces_reconciliation_warnings_in_text_and_json() {
        use std::os::unix::fs::PermissionsExt;

        let seed_temp = || {
            let temp = tempfile::tempdir().expect("temp dir");
            let worklog_dir = temp.path().join("worklog");
            std::fs::create_dir(&worklog_dir).expect("pre-create worklog dir");
            std::fs::set_permissions(&worklog_dir, std::fs::Permissions::from_mode(0o755))
                .expect("relax perms");
            std::fs::write(
                worklog_dir.join("2026-08-29.md"),
                "## 09:00 — vendor-invoice\n\n- Done: Chased the vendor.\n- Left: awaiting the corrected invoice\n- Next: closes when the corrected invoice arrives\n\n",
            )
            .expect("seed prior day");
            temp
        };

        let text_temp = seed_temp();
        let json_temp = seed_temp();
        let mut text_out = Vec::new();
        let mut json_out = Vec::new();

        run_list_with_context(
            false,
            None,
            at((2026, 8, 30), (9, 0)),
            text_temp.path(),
            &mut text_out,
        )
        .expect("list should succeed");
        run_list_with_context(
            true,
            None,
            at((2026, 8, 30), (9, 5)),
            json_temp.path(),
            &mut json_out,
        )
        .expect("list should succeed");

        let text = String::from_utf8(text_out).expect("utf8");
        assert!(
            text.contains("warning: worklog directory") && text.contains("755"),
            "text output must surface reconciliation warnings: {text}"
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
    fn worklog_list_reports_an_empty_carried_forward_set_when_nothing_is_carried() {
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
            .expect("seed today's own entry, no prior file");
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
            text.contains("carried forward: (none)"),
            "an empty carried-forward set is still reported explicitly: {text}"
        );
        let value: Value = serde_json::from_slice(&json_out).expect("json object");
        assert_eq!(
            value["carried_forward"]
                .as_array()
                .expect("carried_forward array")
                .len(),
            0
        );
    }
}
