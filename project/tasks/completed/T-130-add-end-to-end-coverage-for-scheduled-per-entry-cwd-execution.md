---
id: T-130
title: Add end-to-end coverage for scheduled per-entry cwd execution
status: completed
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

### Review Verdict — 2026-07-08

PASS

Reviewed `task/T-130-scheduled-per-entry-cwd-e2e-coverage` (tip `a7588da`)
against `dev-agent` merge-base `d74af2d`, diffing
`the-intern/service/crates/bob/tests/scheduler_execution_e2e.rs` (the sole
file touched — 771 insertions / 13 deletions, matching the declared "Files to
Touch"). Cross-checked the replicated `PeriodicCwdResolution`/
`resolve_periodic_cwd`/`record_periodic_fire_skipped`/
`record_periodic_fire_dispatched` helpers and the extended
`start_inline_dispatcher` against the real production implementation in
`the-intern/service/crates/bob/src/serve.rs` (`start_periodic_dispatcher` and
its helpers, T-127/T-128) — the replica's match arms, audit-record shapes,
and precedence order are faithful to production. Verified independently in a
scratch `git worktree` (not from the Developer's self-report):
`cargo test -p bob --test scheduler_execution_e2e` (4 passed, up from 1),
`cargo test -p bob --lib serve` (56 passed), `cargo test --workspace` (26/26
test-result groups green, no compiler warnings), and
`cargo fmt --all -- --check` (clean).

**Stage 1 — Acceptance Criteria:**

- AC-1 (per-entry `cwd` fire runs the pi session in that directory, honouring
  precedence): met.
  `scheduled_entry_with_per_entry_cwd_runs_pi_session_in_that_directory_honouring_precedence`
  configures the supervisor's service-wide `worker_cwd` to a directory
  distinct from the schedule entry's per-entry `cwd`, fires the entry, and
  asserts (via a `pwd`-writing fake worker script) that the actual process
  cwd — canonicalized — equals the per-entry `cwd`, not the configured
  default. Because the marker file is read from inside the expected per-entry
  directory, a precedence regression (falling through to the service-wide
  default) would make the file never appear there and the test would time out
  and fail — this is a genuine precedence proof, not just "some cwd was
  applied."
- AC-2 (missing per-entry `cwd` at fire time skips the fire with a warning,
  entry remains): met.
  `scheduled_entry_with_missing_per_entry_cwd_at_fire_time_skips_the_fire_and_leaves_the_entry_present`
  never creates the entry's `cwd` on disk, pairs it with a fail-fast
  (`exit 1`) worker so an accidental acquisition would be visibly distinct,
  and asserts a `Report`-kind audit record with `outcome == Error` and a
  summary containing both the job id and "does not exist", that
  `supervisor.list_sessions()` stays empty (no acquisition attempted), and
  that the entry is still present in the live schedule table
  (`scheduler_handle.subscribe().borrow()`) afterward. I independently
  reproduced the Work Log's vacuity check in the scratch worktree —
  temporarily forcing the `!cwd.exists()` guard to `false && ...` — and
  confirmed the test fails (`a missing per-entry cwd at fire time must append
  a monitoring failure record`), then reverted and confirmed green again.
- AC-3 (resolved cwd recorded on the audit record for a firing): met.
  `scheduled_entry_firing_records_the_resolved_cwd_on_the_audit_record` fires
  a per-entry-`cwd` entry and asserts exactly one `Event`-kind audit record
  whose `ExtensionEventAuditPayload::resolved_cwd` equals the concrete
  per-entry `cwd` and whose `session_id` is set — matching T-123's field and
  T-128's "concrete resolved absolute path, not the raw per-entry field"
  requirement (for this precedence tier the two coincide, as T-128's own
  review already established for validated absolute per-entry paths).
- No unspecified behavior was added: the diff adds only what the three ACs
  require — the production-mirroring helpers/enum, a `SpyAuditSink`, the
  extended `start_inline_dispatcher` signature, and the three new tests. The
  Work Log's "Tried and rejected" note correctly declines to add a distinct
  `EntryNotFound` fallback audit record (T-127's AC-3, already covered
  elsewhere) since no T-130 AC or test exercises that tier.
- No unexpected files modified: `git diff --stat` against the merge-base
  shows only `scheduler_execution_e2e.rs`.
- The one pre-existing test's update
  (`schedule_entry_from_json_store_is_delivered_when_admitted_users_is_empty`,
  threading `context.context_id` through `enqueue_with_job_id` and adding the
  two new dispatcher parameters) is necessary, foreseeable plumbing to keep
  it compiling and semantically aligned with the now-extended dispatcher
  signature and production's own `admit_periodic_event` behavior — not scope
  creep.

**Stage 2 — Code Quality:**

- **Correctness:** the replicated resolution/dispatch logic matches
  production's `resolve_periodic_cwd`/`start_periodic_dispatcher` match
  arms exactly (`PerEntry`/`ServiceDefault`/`EntryNotFound`, existence check,
  `acquire_session_with_cwd` vs `acquire_session`, audit record placement
  before `send_prompt`), confirmed by direct comparison with
  `crates/bob/src/serve.rs`.
- **Tests:** all three new tests are independent (own `tempdir`, supervisor,
  monitoring/persistence/policy actors, and — where needed — their own
  `SpyAuditSink`; no shared mutable state), cover both a success path (AC-1)
  and failure/skip path (AC-2) plus a dedicated audit-content assertion
  (AC-3), and assert on concrete values (canonicalized paths, exact audit
  payload fields) rather than loose existence checks. I reproduced one
  vacuity check myself (AC-2, above); AC-1's and AC-3's assertion structure
  is self-evidently non-vacuous (a precedence or field-population regression
  would make the specific assertion fail, not just some looser check).
- **Security:** no hardcoded secrets, no new external input; test
  fixtures use `tempfile::tempdir()` for all filesystem state.
- **Readability:** new tests and helpers are clearly named and documented
  (each carries an `// AC-N (T-130): ...` comment tying it to its
  criterion); no dead code or commented-out blocks. The three new tests
  share substantial setup boilerplate, matching the Reviewer-endorsed
  precedent from T-127/T-128 (per-test legibility over DRY) already
  established in this same file.
- **Performance:** no unnecessary loops, blocking calls, or resource leaks;
  polling loops match the existing 50ms real-time-delay convention used by
  the pre-existing test in this file, and all task/session handles are
  joined with a bounded timeout at teardown.
- `cargo test --workspace` reproduced clean with zero compiler warnings
  attributable to this diff.

Both stages pass. No blocking issues found.

Next owner: Development Loop (`/dev-loop`) routes this to the Integrator for
merge.
