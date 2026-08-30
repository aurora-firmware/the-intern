---
id: T-191
title: Add the worklog reconciliation step
status: pending
priority: high
assigned-role: developer
created: '2026-08-30'
---

# Add the worklog reconciliation step

<!--
Task Quality Rules (see the new-task skill for full details):
  - Atomic — one clear outcome.
  - One-shottable — ≤ 3–4 files touched, ≤ 5 ACs, Description ≈ 20 lines.
  - Verifiable — concrete Verification command or explicit manual steps.
  - Self-contained — Description is enough to start without follow-up questions.
  - EARS — every AC matches one of the five EARS patterns below.
  - Dependency-honest — list every prior task this one reads from or modifies.
-->

## Description

Adds Component 1 of S-015: the **reconciliation step** that carries
still-open items forward into today's worklog file and reports today's
carried-forward set. Add `crates/bob/src/worklog/reconcile.rs` and declare
`pub mod reconcile;` in `crates/bob/src/worklog/mod.rs`.

Expose one operation — "ensure today's file is reconciled, then report
today's carried-forward set" — consuming the `WorklogStore` from T-190. It
is invoked internally by `append` and `list` (T-192/T-193); it is **not** a
standalone subcommand.

Reconciliation rule (S-015 Contract):

- Find the nearest prior worklog file that **exists** by walking
  `<cwd>/worklog/*.md` backward by date from today — regardless of whether
  that file still shows anything open. Do **not** filter on "has open
  items" at the file level: a day that closed everything it mentions is
  real information and must not be skipped for an older file.
- For each item-identifier whose **own last entry in that source file** is
  open (per T-190's open test), carry it forward into today's file **iff**
  today's file has no entry for that item-identifier yet.
- A carried-forward entry copies the source entry's `Left` and `Next`
  verbatim; its `Done` field states the item was carried forward and names
  the source file. When the source file holds more than one entry for the
  item-identifier, the chronologically last is the source.
- Presence-tested, therefore idempotent: a second run finds the entry
  present and does nothing. No "reconciled today" marker.

Reporting: return every item-identifier whose most recent entry **in
today's file** is both (a) a carried-forward entry — identifiable because
its `Done` states so — and (b) still open per the open test. An item closed
later the same day drops out. The set is returned regardless of whether
this call's own pass wrote the carry-forward entry or found it present.

Unit-test in-file.

## Acceptance Criteria

AC-1: WHEN reconciliation runs and the nearest prior worklog file that
exists has an open last entry for an item-identifier absent from today's
file THE SYSTEM SHALL append a carried-forward entry for it to today's
file, copying `Left` and `Next` verbatim and setting `Done` to name the
source file.

AC-2: WHILE the nearest prior worklog file that exists shows every item it
mentions as closed THE SYSTEM SHALL carry nothing forward and SHALL NOT
walk past it to an older file.

AC-3: WHEN reconciliation runs a second time for the same day THE SYSTEM
SHALL make no further change to today's file.

AC-4: IF a source file holds both an earlier open entry and a later closing
entry for one item-identifier THEN THE SYSTEM SHALL treat that item as
closed and not carry it forward.

AC-5: WHEN the operation returns THE SYSTEM SHALL report exactly the
item-identifiers whose most recent entry in today's file is a
carried-forward entry that is still open, whether or not this call wrote
them.

## Dependencies

- `T-190` — provides `WorklogStore` (path resolution, entry read/write, open test)

## Files to Touch

- `the-intern/service/crates/bob/src/worklog/reconcile.rs` — new: reconciliation + carried-forward reporting, unit tests
- `the-intern/service/crates/bob/src/worklog/mod.rs` — add `pub mod reconcile;`

## Verification

```bash
cd the-intern/service && cargo test -p bob worklog::reconcile
```

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

### Session 1 — 2026-08-30

Implemented Component 1 of S-015, the worklog reconciliation step, as `crates/bob/src/worklog/reconcile.rs`, with `pub mod reconcile;` added to `crates/bob/src/worklog/mod.rs`. No other files touched; no CLI wiring (that is T-192/T-193). Six commits on `task/T-191-add-the-worklog-reconciliation-step`, one per red→green→refactor cycle. `cargo test -p bob worklog::reconcile` → 12 passed / 0 failed; `cargo fmt --all -- --check`, `cargo build -p bob`, `cargo doc -p bob`, and `cargo test --workspace` all clean.

**Public surface.** One operation: `pub fn reconcile_today(working_dir: &Path, now: NaiveDateTime) -> ServiceResult<Vec<String>>`. It takes the working directory and a `NaiveDateTime` (mirroring `WorklogStore::append`'s injected-time style and `cli/commands/task.rs`'s `today` injection): `now.date()` selects today's file, and `now` timestamps any carried entry this pass writes. It builds its own `WorklogStore::new(working_dir)` internally rather than taking one as a parameter — the store exposes no accessor for its directory, and reconciliation must scan `<cwd>/worklog/*.md` directly, so passing both a store and the dir would be redundant and desyncable. `WorklogStore` is a cheap clone-only `{ worklog_dir }` struct, so T-192/T-193 constructing a second one alongside is fine. Returns the carried-forward set, sorted and deduplicated.

**How it works.** (1) If `<cwd>/worklog/` is not a directory, return `Ok(vec![])` — nothing logged, nothing to reconcile, and a read must never invent the directory (ADR-015). (2) `nearest_prior_existing_date` reads the directory once, keeps every `<YYYY-MM-DD>.md` stem that parses as a date strictly before today, and takes the max. Existence is the *only* filter — a file that closed everything it mentions still wins, so an older file is never consulted past it (the spec's explicit correction of the "has open items" whole-file filter). (3) `carry_forward_open_items` reads the source day and today once; for each distinct source item whose own last entry is open per `item_open_state` and which has no entry in today's file yet, it appends a `WorklogEntry` copying the source item's chronologically-last `Left`/`Next` verbatim, with `Done` = `"Carried forward from <source>.md; it was still open in that file."`. (4) `report_carried_forward` re-reads today's file and returns every item whose most recent today entry both starts with the `"Carried forward from "` prefix and is still open.

**Design decisions.**
- Carried-forward entries are recognised by a `Done`-field prefix constant (`CARRIED_FORWARD_DONE_PREFIX`), not a separate marker — matches the spec's "identifiable because its `Done` states so" and keeps the pass presence-tested/idempotent with no "reconciled today" flag.
- Reused T-190's `item_open_state`, `WorklogStore::read_day`, and `WorklogStore::append` unchanged for the open test and all file I/O; reconcile.rs adds only the directory scan and the carry/report orchestration.
- `WORKLOG_DIR_NAME`/`FILE_DATE_FORMAT` are re-declared as local consts (with a doc note) because the store's copies are private and the task scopes edits to `reconcile.rs` + `mod.rs` only; both are fixed by ADR-015's `<cwd>/worklog/<date>.md` rule.
- The presence check reads today's entries once up front rather than re-reading after each write. Distinct source items can't collide, and the spec explicitly accepts "at most one duplicate in the narrow concurrent-first-run race" instead of locking (ADR-008), so a single read is correct.
- `nearest_prior_existing_date` still handles a `NotFound` from `read_dir` (returns `None`) as defence against the dir being removed between the `is_dir()` check and the scan.

**Tried and rejected.** Cycle 1 first resolved the source as `today.pred_opt()` (yesterday only); the cycle-2 tests `carries_from_the_nearest_prior_file_not_an_earlier_one` and `ignores_files_dated_today_or_later...` drove the switch to the directory scan. Cycle 6's `returns_an_empty_set_and_creates_nothing_when_the_worklog_directory_is_absent` was red until the `is_dir()` short-circuit was added (previously `report_carried_forward`'s `read_day` raised the store's missing-directory error). AC-3 and AC-4 tests (cycles 3–4) passed the moment they were written — the presence test and `item_open_state`'s "most recent entry" semantics from cycle 1 already satisfy them — so those two commits are `test(...)` regression coverage with no production change, consistent with how T-190 handled the same situation.

**Test coverage (12 in-file unit tests, each in its own `tempfile::tempdir`).** AC-1: `carries_forward_an_open_item_from_the_nearest_prior_file_verbatim`. AC-2: `does_not_walk_past_a_fully_closed_nearest_file_to_an_older_one`, plus `carries_from_the_nearest_prior_file_not_an_earlier_one` and `ignores_files_dated_today_or_later_when_choosing_the_source`. AC-3: `a_second_run_the_same_day_leaves_todays_file_unchanged` (byte-compares today's file across two runs). AC-4: `treats_a_source_item_reopened_then_closed_the_same_day_as_closed`. AC-5: `reports_a_carried_forward_entry_that_an_earlier_run_wrote`, `an_item_closed_later_the_same_day_drops_out_of_the_report`, `reports_exactly_the_still_open_carried_items`, `does_not_carry_or_report_an_item_todays_file_already_has`. Edges: `returns_an_empty_set_when_no_prior_worklog_file_exists`, `returns_an_empty_set_and_creates_nothing_when_the_worklog_directory_is_absent`.

**Reviewer notes.** `cargo clippy -p bob` still cannot produce a clean run due to pre-existing `task_board/store.rs` and `pi-agent-supervisor` debt (CLAUDE.md documents clippy is not a gate); none of the surviving clippy findings reference `reconcile.rs`. The carried-forward `Done` wording is not asserted verbatim anywhere — tests check the recognisable prefix and that the source filename appears — so T-197's skill rewrite can phrase it however it likes as long as the prefix constant stays in sync.

**Remaining (out of scope here):** T-192/T-193 wire `reconcile_today` into `bob worklog append`/`list` and surface the returned set in text/JSON output; T-197/T-198 update the skill and operator docs.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->
