---
id: T-130
title: Add end-to-end coverage for scheduled per-entry cwd execution
status: pending
priority: medium
assigned-role: developer
created: '2026-07-05'
spec: S-009
---

# Add end-to-end coverage for scheduled per-entry cwd execution

## Description

Extend the scheduler e2e suite
(`crates/bob/tests/scheduler_execution_e2e.rs`) to cover the per-entry cwd path
end to end: a scheduled entry with a `cwd` runs its pi session in that directory
(precedence honoured); a per-entry `cwd` that is absent at fire time causes the
fire to be skipped with a warning and the entry to remain; and the audit record
for a firing carries the resolved cwd. These tests use Unix domain sockets and
may require a normal (non-sandboxed) shell to pass locally; CI runs them on the
self-hosted runners.

## Acceptance Criteria

AC-1: WHEN a scheduled entry with a per-entry `cwd` fires THE SYSTEM SHALL run the
      pi session with that directory as its working directory, asserted by the
      test.
AC-2: IF a scheduled entry's per-entry `cwd` does not exist at fire time THEN THE
      SYSTEM SHALL skip the fire with a warning and leave the entry present,
      asserted by the test.
AC-3: WHEN a scheduled entry fires THE SYSTEM SHALL record the resolved cwd on the
      audit record, asserted by the test.

## Dependencies

- `T-127` — dispatch-time cwd resolution and fire-time skip
- `T-128` — resolved cwd recorded on the audit record

## Files to Touch

- `crates/bob/tests/scheduler_execution_e2e.rs` — add per-entry cwd e2e cases

## Verification

```bash
cd the-intern/service && cargo test -p bob --test scheduler_execution_e2e
```

## Work Log

### Session 1 — 2026-07-08

Read the (empty) Work Log, then T-127's and T-128's completed task files and Review Verdicts to understand the exact production dispatcher shape (`serve::start_periodic_dispatcher`, `PeriodicCwdResolution`/`resolve_periodic_cwd`, `record_periodic_fire_skipped`/`record_periodic_fire_fallback`/`record_periodic_fire_dispatched`) that the ACs needed to be exercised end-to-end. Confirmed the production dispatcher function and its helpers are private to the `bob` crate, so — following the existing convention already documented at the top of `scheduler_execution_e2e.rs` ("the production function lives in `bob/src/serve.rs` (private). This inline version is identical in behaviour...") — extended the file's existing `start_inline_dispatcher` replica rather than exposing any new `pub` surface from `serve.rs`, keeping the diff scoped to the single file in Files to Touch.

Implemented all three ACs via three red→green→refactor cycles, one commit each, on `task/T-130-scheduled-per-entry-cwd-e2e-coverage`.

**Cycle 1 (AC-1, per-entry cwd precedence):** Replicated `PeriodicCwdResolution`/`resolve_periodic_cwd` and lightweight `record_periodic_fire_skipped`/`record_periodic_fire_dispatched` helpers plus a `SpyAuditSink` using only public `bob-core` types, and extended `start_inline_dispatcher`'s signature to take `schedule_entries_rx: watch::Receiver<Vec<ScheduleEntry>>` and `audit_sink: Arc<dyn AuditSink>`, switching it from `dequeue_next`/`acquire_session` to `dequeue_next_with_job_id` + the full three-arm cwd resolution (mirroring T-127/T-128's `serve.rs` match block in one edit, since all three arms share the block — same "test-after with vacuity check" precedent T-127's Session 2 documented). Wrote the new AC-1 test referencing the not-yet-existing signature first, confirmed it failed to compile (RED), then implemented the plumbing and updated the pre-existing AC-4 test's closure (now threads `context.context_id` through `enqueue_with_job_id`, matching production's `admit_periodic_event`) and dispatcher call site for compilation, confirmed GREEN (2/2 tests passing). The new AC-1 test (`scheduled_entry_with_per_entry_cwd_runs_pi_session_in_that_directory_honouring_precedence`) deliberately configures the supervisor's service-wide `worker_cwd` to a *different* directory than the per-entry `cwd`, so a pass proves precedence, not just that some cwd was applied.

**Cycle 2 (AC-2, missing-directory skip):** The skip branch (`!cwd.exists()` → `record_periodic_fire_skipped` → `continue`) was already implemented as part of cycle 1's single match edit. Wrote `scheduled_entry_with_missing_per_entry_cwd_at_fire_time_skips_the_fire_and_leaves_the_entry_present` (schedule entry's `cwd` never created on disk; supervisor's worker script is `exit 1` so an accidental acquisition would be visibly distinct), confirmed it passed immediately (test-after), then did an explicit vacuity check: temporarily forced the existence check to `if false && !cwd.exists()`, reran, confirmed the test failed as expected (timed out waiting for the audit record), reverted, reran to confirm green. The test asserts the monitoring failure record's outcome/summary, that `supervisor.list_sessions()` stays empty (no acquisition ever attempted), and that the entry is still present in the live schedule table afterward (`scheduler_handle.subscribe().borrow()`).

**Cycle 3 (AC-3, resolved cwd on the audit record):** The `record_periodic_fire_dispatched` call (event-kind record, `resolved_cwd` field) was likewise already wired in cycle 1. Wrote `scheduled_entry_firing_records_the_resolved_cwd_on_the_audit_record`, confirmed it passed immediately, then vacuity-checked by temporarily changing `Ok(id) => (id, Some(cwd))` to `Ok(id) => (id, None)` in the `PerEntry` arm, reran, confirmed the assertion failed (`left: None, right: Some(...)`), reverted, reran to confirm green.

**Refactor:** Reviewed the final file for duplication; kept the three new tests' near-identical pipeline setup separate rather than parameterized, matching the Reviewer-endorsed precedent from T-127/T-128's Work Logs (per-test legibility over DRY). `cargo fmt --all` was run once after cycle 1 to normalize two long function signatures the formatter itself rewrapped; no further refactor needed.

**Tried and rejected:** Considered giving `start_inline_dispatcher`'s `EntryNotFound` arm its own distinct fallback audit record (mirroring T-127 Session 3's `record_periodic_fire_fallback`) for full production parity — rejected as code not required by any of T-130's three ACs (would violate the "no code exists that is not required by a test" quality bar), and none of the new tests exercise that tier.

**What remains:** Nothing outstanding for T-130. All three ACs are implemented and covered by dedicated tests. `cargo test -p bob --test scheduler_execution_e2e` (4 passed, up from 1), `cargo test -p bob serve` (56 passed, unaffected), `cargo test --workspace` (all green, 26/26 test-result groups), and `cargo fmt --all -- --check` (clean) all pass. Ran the e2e suite 5x in a row with no flakiness. `cargo clippy -p bob --test scheduler_execution_e2e -- -D warnings` shows no warnings attributable to this file (all reported issues are pre-existing `bob-core` pedantic-lint debt, already documented as non-gating in this repo's CLAUDE.md).

**Obstacles Encountered:** None — the Unix-domain-socket-backed tests ran fine in this session's shell (no sandbox restriction encountered), contrary to the possibility flagged in the task description. No out-of-scope bugs or spec/implementation discrepancies were found this session (unlike T-129's B-021); no `new-bug` skill invocation was needed.

## Review
