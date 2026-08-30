//! The `bob worklog` CLI surface.
//!
//! `bob worklog` is filesystem-only: like `bob init` and `bob task` it never
//! opens `admin.sock` or loads service configuration. It resolves the
//! worklog strictly to `<cwd>/worklog/<date>.md` (ADR-015) via the
//! caller-supplied working directory.

use std::{env, io, io::Write, path::Path};

use bob_core::error::ServiceResult;
use chrono::{Local, NaiveDateTime};
use serde::Serialize;
use serde_json::json;

use crate::worklog::{
    reconcile::reconcile_today,
    store::{WorklogEntry, WorklogStore},
};

use super::{invalid_request_error, write_json_line};

#[derive(Debug, Serialize)]
struct AppendedEntryOutput {
    item: String,
    path: String,
    carried_forward: Vec<String>,
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
    reject_empty_field("item", item)?;
    reject_empty_field("done", done)?;
    reject_empty_field("left", left)?;
    reject_empty_field("next", next)?;

    // Reconcile today's file (carry forward any still-open items from the
    // most recent prior worklog file) before this entry is written. The
    // returned set is today's full carried-forward item-identifier set.
    let carried_forward = reconcile_today(working_dir, now)?;

    let entry = WorklogEntry {
        item: item.to_owned(),
        done: done.to_owned(),
        left: left.to_owned(),
        next: next.to_owned(),
    };
    let outcome = WorklogStore::new(working_dir).append(now, &entry)?;

    write_appended_entry(
        out,
        json_output,
        AppendedEntryOutput {
            item: item.to_owned(),
            path: outcome.path.display().to_string(),
            carried_forward,
        },
    )
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
        .map_err(|err| invalid_request_error(format!("failed to write worklog output: {err}")))
}

/// Reject an absent-in-spirit worklog entry field before any filesystem
/// work happens. `clap` already rejects a wholly missing flag; this guards
/// the `--field ""` and all-whitespace cases.
fn reject_empty_field(name: &str, value: &str) -> ServiceResult<()> {
    if value.trim().is_empty() {
        return Err(invalid_request_error(format!(
            "worklog entry field --{name} must not be empty"
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

    use super::run_append_with_context;
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
}
