//! Component 1 of S-015: the worklog reconciliation step.
//!
//! Exposes one operation — [`reconcile_today`] — that ensures today's
//! worklog file has carried forward every still-open item from the nearest
//! prior worklog file that exists, then reports today's full
//! carried-forward set. It is invoked internally by `bob worklog append`
//! and `bob worklog list` (T-192/T-193); it is not a standalone
//! subcommand.

use bob_core::error::{ServiceError, ServiceResult};
use chrono::{NaiveDate, NaiveDateTime};

use std::{fs, path::Path};

use super::store::{item_open_state, RecordedEntry, WorklogEntry, WorklogStore};

/// The working-directory-relative subdirectory that holds the dated worklog
/// files. Mirrors the private `store::WORKLOG_DIR_NAME`; both are fixed by
/// the cwd-strict resolution rule of ADR-015 (`<cwd>/worklog/<date>.md`,
/// with no upward search and no override).
const WORKLOG_DIR_NAME: &str = "worklog";

/// The extension every dated worklog file carries.
const WORKLOG_FILE_EXTENSION: &str = "md";

/// The date format used for worklog file names and for the source-file
/// reference in a carried-forward entry's `Done` field.
const FILE_DATE_FORMAT: &str = "%Y-%m-%d";

/// The prefix every carried-forward entry's `Done` field starts with. The
/// reporting pass recognizes a carried-forward entry by this prefix alone,
/// with no separate "reconciled today" marker (S-015 Contract).
const CARRIED_FORWARD_DONE_PREFIX: &str = "Carried forward from ";

/// Ensure today's worklog file has carried forward every still-open item
/// from the nearest prior worklog file that exists, then return today's
/// full carried-forward set.
///
/// `now` supplies both today's date — which worklog file counts as
/// "today's" — and the `HH:MM` stamp on any entry this pass writes. The
/// returned list holds every item-identifier whose most recent entry in
/// today's file is a carried-forward entry that is still open, whether this
/// call wrote it or found it already present. It is sorted and free of
/// duplicates.
///
/// # Errors
///
/// Returns [`bob_core::error::ServiceError::Persistence`] when scanning the
/// worklog directory or reading/writing a day file fails.
pub fn reconcile_today(working_dir: &Path, now: NaiveDateTime) -> ServiceResult<Vec<String>> {
    let worklog_dir = working_dir.join(WORKLOG_DIR_NAME);
    let store = WorklogStore::new(working_dir);
    let today = now.date();

    if let Some(source_date) = nearest_prior_existing_date(&worklog_dir, today)? {
        carry_forward_open_items(&store, source_date, now)?;
    }

    report_carried_forward(&store, today)
}

/// The latest date strictly before `today` that has a `<date>.md` file in
/// `worklog_dir`. Existence is the only filter: a file that closed every
/// item it mentions still counts, so an older file is never consulted past
/// it (S-015 Design Principles). Returns `None` when no such file exists,
/// including when `worklog_dir` itself is absent.
fn nearest_prior_existing_date(
    worklog_dir: &Path,
    today: NaiveDate,
) -> ServiceResult<Option<NaiveDate>> {
    let read_dir = match fs::read_dir(worklog_dir) {
        Ok(read_dir) => read_dir,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => {
            return Err(ServiceError::Persistence {
                detail: format!(
                    "failed to list worklog directory {}: {err}",
                    worklog_dir.display()
                ),
            })
        }
    };

    let mut prior_dates: Vec<NaiveDate> = Vec::new();
    for entry in read_dir {
        let entry = entry.map_err(|err| ServiceError::Persistence {
            detail: format!(
                "failed to read an entry of worklog directory {}: {err}",
                worklog_dir.display()
            ),
        })?;
        if let Some(file_date) = worklog_file_date(&entry.path()) {
            if file_date < today {
                prior_dates.push(file_date);
            }
        }
    }

    Ok(prior_dates.into_iter().max())
}

/// The calendar date a worklog file path encodes, or `None` when the path
/// is not a `<YYYY-MM-DD>.md` day file.
fn worklog_file_date(path: &Path) -> Option<NaiveDate> {
    if path.extension().and_then(|ext| ext.to_str()) != Some(WORKLOG_FILE_EXTENSION) {
        return None;
    }
    let stem = path.file_stem().and_then(|stem| stem.to_str())?;
    NaiveDate::parse_from_str(stem, FILE_DATE_FORMAT).ok()
}

/// Append, to today's file, one carried-forward entry per item-identifier
/// whose own last entry in the `source_date` file is open and that today's
/// file has no entry for yet. Presence-tested, so a repeat pass writes
/// nothing.
fn carry_forward_open_items(
    store: &WorklogStore,
    source_date: NaiveDate,
    now: NaiveDateTime,
) -> ServiceResult<()> {
    let source_entries = store.read_day(source_date)?;
    let today_entries = store.read_day(now.date())?;

    for item in distinct_items_in_order(&source_entries) {
        if item_open_state(&source_entries, &item) != Some(true) {
            continue;
        }
        if item_open_state(&today_entries, &item).is_some() {
            continue;
        }
        let source_entry = last_entry_for(&source_entries, &item)
            .expect("item came from the source file's own entries");
        let carried = WorklogEntry {
            item: item.clone(),
            done: carried_forward_done(source_date),
            left: source_entry.left.clone(),
            next: source_entry.next.clone(),
        };
        store.append(now, &carried)?;
    }

    Ok(())
}

/// Every item-identifier whose most recent entry in today's file is a
/// carried-forward entry that is still open per the open test. Sorted and
/// deduplicated; independent of whether this process wrote those entries.
fn report_carried_forward(store: &WorklogStore, today: NaiveDate) -> ServiceResult<Vec<String>> {
    let today_entries = store.read_day(today)?;

    let mut carried_open: Vec<String> = Vec::new();
    for item in distinct_items_in_order(&today_entries) {
        let latest =
            last_entry_for(&today_entries, &item).expect("item came from today's own entries");
        let is_carried_forward = latest.done.starts_with(CARRIED_FORWARD_DONE_PREFIX);
        let is_open = item_open_state(&today_entries, &item) == Some(true);
        if is_carried_forward && is_open {
            carried_open.push(item);
        }
    }

    carried_open.sort();
    Ok(carried_open)
}

fn distinct_items_in_order(entries: &[RecordedEntry]) -> Vec<String> {
    let mut ordered: Vec<String> = Vec::new();
    for entry in entries {
        if !ordered.iter().any(|seen| seen == &entry.item) {
            ordered.push(entry.item.clone());
        }
    }
    ordered
}

fn last_entry_for<'a>(entries: &'a [RecordedEntry], item: &str) -> Option<&'a RecordedEntry> {
    entries.iter().rev().find(|entry| entry.item == item)
}

fn carried_forward_done(source_date: NaiveDate) -> String {
    format!(
        "{CARRIED_FORWARD_DONE_PREFIX}{}.md; it was still open in that file.",
        source_date.format(FILE_DATE_FORMAT)
    )
}

#[cfg(test)]
mod tests {
    use super::{reconcile_today, CARRIED_FORWARD_DONE_PREFIX};
    use crate::worklog::store::{WorklogEntry, WorklogStore};
    use chrono::{NaiveDate, NaiveDateTime, NaiveTime};

    fn at(date: (i32, u32, u32), time: (u32, u32)) -> NaiveDateTime {
        NaiveDate::from_ymd_opt(date.0, date.1, date.2)
            .expect("valid date")
            .and_time(NaiveTime::from_hms_opt(time.0, time.1, 0).expect("valid time"))
    }

    fn on(date: (i32, u32, u32)) -> NaiveDate {
        NaiveDate::from_ymd_opt(date.0, date.1, date.2).expect("valid date")
    }

    fn entry(item: &str, done: &str, left: &str, next: &str) -> WorklogEntry {
        WorklogEntry {
            item: item.to_owned(),
            done: done.to_owned(),
            left: left.to_owned(),
            next: next.to_owned(),
        }
    }

    fn seed(store: &WorklogStore, when: NaiveDateTime, entry: &WorklogEntry) {
        store
            .append(when, entry)
            .expect("seed append should succeed");
    }

    #[test]
    fn carries_forward_an_open_item_from_the_nearest_prior_file_verbatim() {
        let temp = tempfile::tempdir().expect("temp dir");
        let store = WorklogStore::new(temp.path());
        seed(
            &store,
            at((2026, 8, 29), (9, 0)),
            &entry(
                "vendor-invoice",
                "Chased the vendor for the missing PDF.",
                "awaiting the corrected invoice",
                "closes when the corrected invoice arrives",
            ),
        );

        let carried = reconcile_today(temp.path(), at((2026, 8, 30), (8, 15)))
            .expect("reconcile should succeed");

        assert_eq!(carried, vec!["vendor-invoice".to_owned()]);

        let today = store.read_day(on((2026, 8, 30))).expect("read today");
        assert_eq!(
            today.len(),
            1,
            "exactly one carried entry expected: {today:?}"
        );
        let carried_entry = &today[0];
        assert_eq!(carried_entry.item, "vendor-invoice");
        assert_eq!(carried_entry.left, "awaiting the corrected invoice");
        assert_eq!(
            carried_entry.next,
            "closes when the corrected invoice arrives"
        );
        assert!(
            carried_entry.done.starts_with(CARRIED_FORWARD_DONE_PREFIX),
            "Done must mark the entry carried forward: {:?}",
            carried_entry.done
        );
        assert!(
            carried_entry.done.contains("2026-08-29.md"),
            "Done must name the source file: {:?}",
            carried_entry.done
        );
    }

    #[test]
    fn carries_from_the_nearest_prior_file_not_an_earlier_one() {
        let temp = tempfile::tempdir().expect("temp dir");
        let store = WorklogStore::new(temp.path());
        seed(
            &store,
            at((2026, 8, 10), (9, 0)),
            &entry(
                "ancient-item",
                "Opened it long ago.",
                "still blocked on the ancient thing",
                "closes some day",
            ),
        );
        seed(
            &store,
            at((2026, 8, 28), (9, 0)),
            &entry(
                "recent-item",
                "Opened it recently.",
                "still blocked on the recent thing",
                "closes soon",
            ),
        );

        let carried = reconcile_today(temp.path(), at((2026, 8, 30), (9, 0)))
            .expect("reconcile should succeed");

        assert_eq!(
            carried,
            vec!["recent-item".to_owned()],
            "only the nearest prior file is consulted as the source"
        );
    }

    #[test]
    fn does_not_walk_past_a_fully_closed_nearest_file_to_an_older_one() {
        let temp = tempfile::tempdir().expect("temp dir");
        let store = WorklogStore::new(temp.path());
        seed(
            &store,
            at((2026, 8, 20), (9, 0)),
            &entry(
                "older-open-item",
                "Started it.",
                "still blocked on legal",
                "closes when legal signs off",
            ),
        );
        seed(
            &store,
            at((2026, 8, 27), (9, 0)),
            &entry(
                "recent-closed-item",
                "Wrapped it up.",
                "nothing",
                "nothing further",
            ),
        );

        let carried = reconcile_today(temp.path(), at((2026, 8, 30), (9, 0)))
            .expect("reconcile should succeed");

        assert!(
            carried.is_empty(),
            "a fully closed nearest file carries nothing and stops the walk: {carried:?}"
        );
        let today = store.read_day(on((2026, 8, 30))).expect("read today");
        assert!(
            today.is_empty(),
            "the older open item must not be resurrected: {today:?}"
        );
    }

    #[test]
    fn ignores_files_dated_today_or_later_when_choosing_the_source() {
        let temp = tempfile::tempdir().expect("temp dir");
        let store = WorklogStore::new(temp.path());
        seed(
            &store,
            at((2026, 8, 28), (9, 0)),
            &entry(
                "real-prior-item",
                "Opened it.",
                "still open",
                "closes later",
            ),
        );
        seed(
            &store,
            at((2026, 9, 5), (9, 0)),
            &entry(
                "future-item",
                "From a file dated after today.",
                "still open in the future",
                "closes later",
            ),
        );

        let carried = reconcile_today(temp.path(), at((2026, 8, 30), (9, 0)))
            .expect("reconcile should succeed");

        assert_eq!(carried, vec!["real-prior-item".to_owned()]);
    }

    #[test]
    fn a_second_run_the_same_day_leaves_todays_file_unchanged() {
        let temp = tempfile::tempdir().expect("temp dir");
        let store = WorklogStore::new(temp.path());
        seed(
            &store,
            at((2026, 8, 29), (9, 0)),
            &entry(
                "vendor-invoice",
                "Chased the vendor.",
                "awaiting the corrected invoice",
                "closes when the corrected invoice arrives",
            ),
        );
        let today_path = temp.path().join("worklog").join("2026-08-30.md");

        reconcile_today(temp.path(), at((2026, 8, 30), (8, 15))).expect("first run");
        let after_first = std::fs::read_to_string(&today_path).expect("today file after first run");

        let carried =
            reconcile_today(temp.path(), at((2026, 8, 30), (11, 45))).expect("second run");
        let after_second =
            std::fs::read_to_string(&today_path).expect("today file after second run");

        assert_eq!(
            after_first, after_second,
            "a repeat run must not append a second carried-forward entry"
        );
        assert_eq!(
            carried,
            vec!["vendor-invoice".to_owned()],
            "the second run still reports the carried-forward item"
        );
    }

    #[test]
    fn treats_a_source_item_reopened_then_closed_the_same_day_as_closed() {
        let temp = tempfile::tempdir().expect("temp dir");
        let store = WorklogStore::new(temp.path());
        seed(
            &store,
            at((2026, 8, 29), (9, 0)),
            &entry(
                "shipping-label",
                "Requested the label.",
                "blocked on the carrier portal",
                "closes when the portal is back",
            ),
        );
        seed(
            &store,
            at((2026, 8, 29), (16, 30)),
            &entry(
                "shipping-label",
                "Portal recovered; label printed.",
                "nothing",
                "nothing further",
            ),
        );

        let carried = reconcile_today(temp.path(), at((2026, 8, 30), (8, 15)))
            .expect("reconcile should succeed");

        assert!(
            carried.is_empty(),
            "the item's later closing entry is its true state: {carried:?}"
        );
        let today = store.read_day(on((2026, 8, 30))).expect("read today");
        assert!(
            today.is_empty(),
            "a within-day-closed item must not be carried forward: {today:?}"
        );
    }

    #[test]
    fn reports_a_carried_forward_entry_that_an_earlier_run_wrote() {
        let temp = tempfile::tempdir().expect("temp dir");
        let store = WorklogStore::new(temp.path());
        // Today's file already holds a carried-forward entry, as if an
        // earlier invocation that same day performed the carry-forward
        // write. There is no prior file for this run's own pass to act on.
        seed(
            &store,
            at((2026, 8, 30), (7, 0)),
            &entry(
                "vendor-invoice",
                &format!("{CARRIED_FORWARD_DONE_PREFIX}2026-08-29.md; carried by an earlier run."),
                "awaiting the corrected invoice",
                "closes when the corrected invoice arrives",
            ),
        );

        let carried = reconcile_today(temp.path(), at((2026, 8, 30), (9, 30)))
            .expect("reconcile should succeed");

        assert_eq!(
            carried,
            vec!["vendor-invoice".to_owned()],
            "the set is reported even when this call wrote nothing"
        );
    }

    #[test]
    fn an_item_closed_later_the_same_day_drops_out_of_the_report() {
        let temp = tempfile::tempdir().expect("temp dir");
        let store = WorklogStore::new(temp.path());
        seed(
            &store,
            at((2026, 8, 29), (9, 0)),
            &entry(
                "vendor-invoice",
                "Chased the vendor.",
                "awaiting the corrected invoice",
                "closes when the corrected invoice arrives",
            ),
        );

        let before_close =
            reconcile_today(temp.path(), at((2026, 8, 30), (8, 15))).expect("carry-forward run");
        assert_eq!(before_close, vec!["vendor-invoice".to_owned()]);

        // The item is resolved later the same day.
        seed(
            &store,
            at((2026, 8, 30), (15, 0)),
            &entry(
                "vendor-invoice",
                "Corrected invoice arrived; filed.",
                "nothing",
                "nothing further",
            ),
        );

        let after_close =
            reconcile_today(temp.path(), at((2026, 8, 30), (16, 0))).expect("later run");

        assert!(
            after_close.is_empty(),
            "a carried item closed later the same day drops out: {after_close:?}"
        );
    }

    #[test]
    fn reports_exactly_the_still_open_carried_items() {
        let temp = tempfile::tempdir().expect("temp dir");
        let store = WorklogStore::new(temp.path());
        seed(
            &store,
            at((2026, 8, 29), (9, 0)),
            &entry(
                "alpha",
                "Started alpha.",
                "waiting on alpha",
                "closes on the alpha reply",
            ),
        );
        seed(
            &store,
            at((2026, 8, 29), (9, 30)),
            &entry(
                "beta",
                "Started beta.",
                "waiting on beta",
                "closes on the beta reply",
            ),
        );
        seed(
            &store,
            at((2026, 8, 29), (10, 0)),
            &entry("gamma", "Finished gamma.", "nothing", "nothing further"),
        );

        let carried = reconcile_today(temp.path(), at((2026, 8, 30), (8, 0)))
            .expect("reconcile should succeed");

        assert_eq!(
            carried,
            vec!["alpha".to_owned(), "beta".to_owned()],
            "only the still-open carried items, sorted, and not the closed one"
        );
    }

    #[test]
    fn does_not_carry_or_report_an_item_todays_file_already_has() {
        let temp = tempfile::tempdir().expect("temp dir");
        let store = WorklogStore::new(temp.path());
        seed(
            &store,
            at((2026, 8, 29), (9, 0)),
            &entry(
                "vendor-invoice",
                "Chased the vendor.",
                "awaiting the corrected invoice",
                "closes when the corrected invoice arrives",
            ),
        );
        // Today's file already has its own, non-carried entry for the item.
        seed(
            &store,
            at((2026, 8, 30), (7, 30)),
            &entry(
                "vendor-invoice",
                "Picked it back up this morning.",
                "still awaiting the corrected invoice",
                "closes when the corrected invoice arrives",
            ),
        );

        let carried = reconcile_today(temp.path(), at((2026, 8, 30), (9, 0)))
            .expect("reconcile should succeed");

        assert!(
            carried.is_empty(),
            "an item already present is not reported as carried forward: {carried:?}"
        );
        let today = store.read_day(on((2026, 8, 30))).expect("read today");
        assert_eq!(
            today.len(),
            1,
            "no carried-forward duplicate should be appended: {today:?}"
        );
        assert_eq!(today[0].done, "Picked it back up this morning.");
    }
}
