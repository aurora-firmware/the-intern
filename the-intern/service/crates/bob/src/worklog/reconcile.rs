//! Component 1 of `S-015`, as amended by `CR-013`: same-day duplicate
//! suppression for the worklog. Cross-day reconciliation (carrying a still-
//! open item forward from the nearest prior worklog file) was removed by
//! `CR-013` — a day's file must contain only what was appended to it that
//! day, and nothing about whether a domain item is still "open" is a
//! `bob worklog` concern any longer.
//!
//! Exposes [`is_same_day_duplicate`], the pure comparison `T-203` will wire
//! into `bob worklog append` so a call that exactly repeats an
//! item-identifier's most recent entry already in today's file writes
//! nothing further.
//!
//! [`reconcile_today`] is retained, now a no-op, only for source
//! compatibility with its existing call sites in
//! `cli/commands/worklog.rs`; `T-203` replaces those call sites with
//! [`is_same_day_duplicate`] and removes this function.

use bob_core::error::ServiceResult;
use chrono::NaiveDateTime;

use std::path::Path;

use super::store::{RecordedEntry, WorklogEntry};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReconcileOutcome {
    pub carried_forward: Vec<String>,
    pub warnings: Vec<String>,
}

/// A no-op retained for source compatibility with `cli/commands/worklog.rs`
/// (`T-203` removes the call sites). Cross-day reconciliation was removed
/// by `CR-013`: this function now reads and writes nothing, so it always
/// returns an empty [`ReconcileOutcome`] (AC-1).
///
/// # Errors
///
/// Never returns an error; the `Result` is kept only to match the existing
/// call sites' signature.
pub fn reconcile_today(
    _working_dir: &Path,
    _now: NaiveDateTime,
) -> ServiceResult<ReconcileOutcome> {
    Ok(ReconcileOutcome {
        carried_forward: Vec::new(),
        warnings: Vec::new(),
    })
}

/// Whether `candidate` exactly repeats the item-identifier's most recent
/// entry already present in `today_entries` — same-day duplicate
/// suppression (`S-015` Component 1, as amended by `CR-013`). Only
/// `today_entries` is consulted; no other day's file is ever part of this
/// comparison (AC-1).
///
/// `Done` is compared after trimming surrounding whitespace, matching the
/// store's existing parse-time trim rule, with no case-folding (AC-2). A
/// `Done` value that differs counts as not a duplicate (AC-3), as does an
/// item-identifier with no entry yet in `today_entries` (AC-3). When
/// `today_entries` holds more than one entry for the item-identifier, only
/// the chronologically last one is consulted — an earlier entry for the
/// same item is never compared against (AC-4).
pub fn is_same_day_duplicate(today_entries: &[RecordedEntry], candidate: &WorklogEntry) -> bool {
    let Some(latest) = today_entries
        .iter()
        .rev()
        .find(|entry| entry.item == candidate.item)
    else {
        return false;
    };

    latest.done.trim() == candidate.done.trim()
}

#[cfg(test)]
mod tests {
    use super::{is_same_day_duplicate, reconcile_today};
    use crate::worklog::store::{RecordedEntry, WorklogEntry, WorklogStore};
    use chrono::{NaiveDate, NaiveDateTime, NaiveTime};

    fn at(date: (i32, u32, u32), time: (u32, u32)) -> NaiveDateTime {
        NaiveDate::from_ymd_opt(date.0, date.1, date.2)
            .expect("valid date")
            .and_time(NaiveTime::from_hms_opt(time.0, time.1, 0).expect("valid time"))
    }

    fn entry(item: &str, done: &str) -> WorklogEntry {
        WorklogEntry {
            item: item.to_owned(),
            done: done.to_owned(),
        }
    }

    fn seed(store: &WorklogStore, when: NaiveDateTime, entry: &WorklogEntry) {
        store
            .append(when, entry)
            .expect("seed append should succeed");
    }

    #[test]
    fn reconcile_today_is_a_no_op_that_reads_and_writes_nothing() {
        let temp = tempfile::tempdir().expect("temp dir");
        let store = WorklogStore::new(temp.path());
        seed(
            &store,
            at((2026, 8, 29), (9, 0)),
            &entry("vendor-invoice", "Chased the vendor for the missing PDF."),
        );
        let prior_day_path = temp.path().join("worklog").join("2026-08-29.md");
        let prior_day_before = std::fs::read_to_string(&prior_day_path).expect("prior day file");

        let outcome = reconcile_today(temp.path(), at((2026, 8, 30), (8, 15)))
            .expect("reconcile_today must not fail");

        assert!(
            outcome.carried_forward.is_empty(),
            "cross-day carry-forward was removed by CR-013: {:?}",
            outcome.carried_forward
        );
        assert!(outcome.warnings.is_empty());
        assert!(
            !temp.path().join("worklog").join("2026-08-30.md").exists(),
            "reconcile_today must not write today's file"
        );
        let prior_day_after = std::fs::read_to_string(&prior_day_path).expect("prior day file");
        assert_eq!(
            prior_day_before, prior_day_after,
            "reconcile_today must not touch a prior day's file"
        );
    }

    fn recorded(item: &str, done: &str) -> RecordedEntry {
        RecordedEntry {
            recorded_time: "09:00".to_owned(),
            item: item.to_owned(),
            done: done.to_owned(),
        }
    }

    #[test]
    fn is_same_day_duplicate_is_true_when_done_matches_the_items_latest_entry() {
        let today_entries = [recorded("vendor-invoice", "Chased the vendor.")];
        let candidate = entry("vendor-invoice", "Chased the vendor.");

        assert!(is_same_day_duplicate(&today_entries, &candidate));
    }

    #[test]
    fn is_same_day_duplicate_is_false_when_the_item_has_no_entry_yet_today() {
        let today_entries = [recorded("vendor-invoice", "Chased the vendor.")];
        let candidate = entry("shipping-label", "Requested the label.");

        assert!(!is_same_day_duplicate(&today_entries, &candidate));
    }

    #[test]
    fn is_same_day_duplicate_is_false_when_done_differs() {
        let today_entries = [recorded("vendor-invoice", "Chased the vendor.")];
        let candidate = entry("vendor-invoice", "Chased the vendor again.");

        assert!(!is_same_day_duplicate(&today_entries, &candidate));
    }

    #[test]
    fn is_same_day_duplicate_compares_only_against_the_chronologically_last_entry_for_the_item() {
        let today_entries = [
            recorded("vendor-invoice", "Chased the vendor."),
            recorded("vendor-invoice", "Corrected invoice arrived; filed."),
        ];
        let matches_the_earlier_entry_only = entry("vendor-invoice", "Chased the vendor.");
        let matches_the_latest_entry = entry("vendor-invoice", "Corrected invoice arrived; filed.");

        assert!(
            !is_same_day_duplicate(&today_entries, &matches_the_earlier_entry_only),
            "an earlier entry for the item must never be consulted"
        );
        assert!(is_same_day_duplicate(
            &today_entries,
            &matches_the_latest_entry
        ));
    }

    #[test]
    fn is_same_day_duplicate_ignores_surrounding_whitespace_but_not_case() {
        let today_entries = [recorded("vendor-invoice", "Chased the vendor.")];
        let padded_but_equal = entry("vendor-invoice", "  Chased the vendor.  ");
        let different_case_only = entry("vendor-invoice", "chased the vendor.");

        assert!(
            is_same_day_duplicate(&today_entries, &padded_but_equal),
            "surrounding whitespace must not defeat the match"
        );
        assert!(
            !is_same_day_duplicate(&today_entries, &different_case_only),
            "case differences must not be folded away"
        );
    }
}
