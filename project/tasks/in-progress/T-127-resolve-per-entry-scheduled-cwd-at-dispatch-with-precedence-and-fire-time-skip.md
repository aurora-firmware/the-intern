---
id: T-127
title: Resolve per-entry scheduled cwd at dispatch with precedence and fire-time
  skip
status: pending
priority: high
assigned-role: developer
created: '2026-07-05'
spec: S-009
---

# Resolve per-entry scheduled cwd at dispatch with precedence and fire-time skip

## Description

In the periodic dispatcher (`crates/bob/src/serve.rs`), when a periodic event is
dequeued with its job id (T-126), resolve the fire's working directory from the
**live** schedule table (via the reload handle / `ReloadHandle::subscribe`) using
precedence: per-entry `cwd` (T-118) → `pi_agent_cwd` → inherited launch cwd.
Acquire the worker with that directory via the cwd-aware acquisition (T-122) when
a per-entry cwd applies. If the resolved per-entry `cwd` does not exist at fire
time, skip that fire with a warning and a monitoring failure record (analogous to
the missing-prompt-file skip); the entry fires again next tick. If the job id no
longer resolves to a live entry (removed between enqueue and fire), fall back to
the service-wide default and record the condition (ADR-013). If the pool is at
`max_processes` for a per-entry-cwd fire, skip with a warning rather than block or
evict.

## Acceptance Criteria

AC-1: WHEN the dispatcher dequeues a `periodic` event THE SYSTEM SHALL resolve the
      working directory from the live schedule table using precedence per-entry
      `cwd` → `pi_agent_cwd` → inherited launch cwd and acquire the worker with
      that directory.
AC-2: IF the resolved per-entry `cwd` does not exist at fire time THEN THE SYSTEM
      SHALL skip that fire with a warning and a monitoring failure record, leaving
      the entry to fire on its next tick.
AC-3: IF the dequeued job id no longer resolves to a live entry THEN THE SYSTEM
      SHALL fall back to the service-wide default working directory and record the
      condition.
AC-4: IF the worker pool is at `max_processes` when a per-entry-cwd fire is
      dispatched THEN THE SYSTEM SHALL skip that fire with a warning rather than
      block or evict a worker.

## Dependencies

- `T-126` — job id carried to the dispatcher + supervisor cwd wiring
- `T-118` — `ScheduleEntry.cwd` on the live schedule table
- `T-122` — cwd-aware dedicated-worker acquisition

## Files to Touch

- `crates/bob/src/serve.rs` — dispatcher cwd resolution, precedence, fire-time
  skip/fallback, and cwd-aware acquire
- `crates/pi-agent-supervisor/src/lib.rs` — add a thin cwd-aware acquisition
  passthrough: a `Command::AcquireSessionWithCwd { cwd, response_tx }` variant,
  a `Handle::acquire_session_with_cwd(&self, cwd: PathBuf)` method mirroring the
  existing `acquire_session`, and the actor command-match arm routing to
  `pool::SessionPool::acquire_session_with_cwd` (T-122). Passthrough only — no
  pool or spawn logic (that shipped in T-122).

## Verification

```bash
cd the-intern/service && cargo build -p bob && cargo test -p bob serve && cargo test -p pi-agent-supervisor
```

## Work Log

### Session 1 — 2026-07-07

Read the (empty) Work Log, the task file, S-009, and ADR-013, then traced the full call path the dispatcher would need: `crates/bob/src/serve.rs::start_periodic_dispatcher` → `pi_agent_supervisor::Handle` → `pi_agent_supervisor::Actor`/`Command` → `pool::SessionPool`. Confirmed `SessionPool::acquire_session_with_cwd` (added by T-122, `crates/pi-agent-supervisor/src/pool.rs`) has no counterpart in `crates/pi-agent-supervisor/src/lib.rs`'s `Command` enum or `Handle` — the only actor-facing acquisition method is `Handle::acquire_session()` (no cwd parameter), and `start_periodic_dispatcher` holds a concrete `pi_agent_supervisor::Handle`, not a trait object, so there is no way to reach the pool-level method without adding new code to `lib.rs`. This gap was foreseen and explicitly documented as future work in T-122's own Work Log ("...any needed actor `Command`/`Handle` surface in `lib.rs`, is explicitly out of this task's file scope"), but T-127's Files to Touch listed only `crates/bob/src/serve.rs`, not `crates/pi-agent-supervisor/src/lib.rs`.

Also worked out (not yet implemented) that AC-2 (skip + monitoring record when a resolved per-entry `cwd` doesn't exist at fire time) and AC-3 (fallback to default + record the condition when the job id no longer resolves to a live entry) are both implementable using only `crates/bob/src/serve.rs` — via `scheduler_adapter::ReloadHandle::subscribe()` to read the live table by job id, the unchanged `Handle::acquire_session()` for the fallback path, and existing `bob_core::types::{AuditRecord, AuditRecordKind::Report, ExternalReportAuditPayload}` through the `audit_sink: Arc<dyn AuditSink>` already built in `try_start_subsystems`. AC-1's actual per-entry-cwd acquisition and AC-4 (skip when that acquisition would exceed `max_processes`) were blocked on the missing `pi-agent-supervisor` Handle surface.

Considered and rejected: implementing only the AC-2/AC-3 branches while leaving the "per-entry cwd resolved and exists" case either as an unimplemented match arm (violates the no-placeholder-implementations quality bar) or silently falling through to the default-cwd `acquire_session()` path (a real functional regression — an operator-configured per-entry `cwd` would be silently ignored). Rejected both; escalated the whole task instead of committing a partial, functionally-incorrect dispatcher change.

No production or test files were modified this session. Escalated to the Architect for a Files-to-Touch decision.

**Architect resolution (2026-07-07):** RESOLVED as a work-item scope omission, not a design gap. Directive: `Files to Touch` amended above to add `crates/pi-agent-supervisor/src/lib.rs`, scoped strictly to a thin passthrough (`Command::AcquireSessionWithCwd`, `Handle::acquire_session_with_cwd`, one actor match arm to `pool::SessionPool::acquire_session_with_cwd`) — no new pool/spawn/bound-check logic, that shipped in T-122. Verification extended to include `cargo test -p pi-agent-supervisor`. No spec or ADR change; AC-2/AC-3 were already unblocked and can proceed regardless.

### Session 2 — 2026-07-08

Resumed after the Architect resolved the Session 1 escalation as a work-item scope omission and amended T-127's Files to Touch to add `crates/pi-agent-supervisor/src/lib.rs` for a thin cwd-aware acquisition passthrough. Implemented all four acceptance criteria via six red→green→refactor cycles, one commit each, on the task branch.

**Cycle 1 (passthrough, pi-agent-supervisor):** Added `Command::AcquireSessionWithCwd { cwd, response_tx }`, `Handle::acquire_session_with_cwd(&self, cwd: PathBuf)` (built exactly like `acquire_session`), and the actor match arm routing to `pool::SessionPool::acquire_session_with_cwd` (T-122) — passthrough only, no pool/spawn/bound-check logic, per the Architect's guidance. Wrote `acquire_session_with_cwd_returns_a_session_id_tracked_by_list_sessions` (mirroring the existing `list_sessions_returns_bound_session_ids` Handle test) first, confirmed it failed to compile (method didn't exist), then added the implementation and confirmed all 61 `pi-agent-supervisor` tests passed.

**Cycle 2 (AC-1, resolution + dedicated acquisition):** Added `PeriodicCwdResolution` (`PerEntry`/`ServiceDefault`/`EntryNotFound`) and `resolve_periodic_cwd(job_id, live_entries)` to `serve.rs`, with four unit tests covering each precedence outcome (including a `None` job id and a job id absent from the live table). Wired `start_periodic_dispatcher` to accept a `watch::Receiver<Vec<ScheduleEntry>>` (subscribed from the scheduler-adapter's `ReloadHandle` at the real call site) and an `Arc<dyn AuditSink>`, updated the two pre-existing T-126 dispatcher tests and the production call site for the new signature, then wrote `periodic_dispatcher_acquires_dedicated_worker_at_resolved_per_entry_cwd` — a real-spawn test (mirroring T-122's pool-level cwd test) that enqueues a periodic event whose job id resolves to a live entry with a per-entry `cwd`, and asserts the dedicated worker's reported `pwd` matches the resolved directory. Confirmed it timed out (red) before wiring the `PerEntry` branch to `acquire_session_with_cwd`, then implemented the full match (`PerEntry`/`ServiceDefault`/`EntryNotFound`) in one pass since all three arms live in the same code block, and confirmed green (52/52 `bob` serve tests). `chrono` was not yet a `bob` dependency, needed for the AC-2 record's timestamp added in this same cycle for compile purposes — added to `crates/bob/Cargo.toml` (see Obstacles). Caught and fixed a stray `marker.txt` left in the crate root by an early draft of this test (its warm-pool worker also ran the cwd-writing script, inheriting the unset default cwd); fixed by dropping the warm pool to 0 for that test rather than just deleting the artifact.

**Cycle 3 (AC-2, missing-directory skip + monitoring record):** The `!cwd.exists()` check and `record_periodic_fire_skipped` helper (building an `AuditRecord` with `AuditRecordKind::Report` / `ExternalReportAuditPayload { outcome: ReportOutcome::Error, .. }`, reusing existing bob-core types rather than adding a new audit kind) were already written as part of cycle 2's single match edit. Wrote `periodic_dispatcher_skips_fire_and_records_failure_when_per_entry_cwd_is_missing` (pairing a missing-directory entry with a fail-fast supervisor so any accidental acquisition attempt would be a visibly different failure path), confirmed it passed immediately, then did a vacuity check per the T-121/T-122 precedent: temporarily forced the existence check to never trigger, reran, confirmed the test failed (timed out waiting for the audit record), then restored the check and reran to confirm green. Committed as a `test(...)` commit since production code was already correct.

**Cycle 4 (AC-3, stale-job-id fallback):** The `EntryNotFound` branch (warn + fall back to plain `acquire_session`) was likewise already written in cycle 2. Wrote `periodic_dispatcher_falls_back_to_default_cwd_when_job_id_not_in_live_table` (enqueues a periodic fire whose job id matches no live entry, asserts the fire still reaches a real worker via the default path), confirmed it passed immediately, then did the same vacuity check: temporarily short-circuited the `EntryNotFound` branch to `continue` before acquiring, reran, confirmed failure, restored, reran to confirm green. Committed as `test(...)`.

**Cycle 5 (AC-4, max_processes skip without eviction):** The `Err(e)` arm on `acquire_session_with_cwd` (skip with warning, no eviction) was already in place from cycle 2, relying on T-122's existing pool-level refusal. Wrote `periodic_dispatcher_skips_per_entry_cwd_fire_without_evicting_when_pool_is_full` — fills the sole `max_processes` slot with an ordinary fire, captures its session id, then fires a second event resolving to a per-entry `cwd`, and asserts (a) no dedicated worker/marker ever appears and (b) `list_sessions()` afterward is unchanged (still exactly the first session). Confirmed it passed immediately, then did a stronger vacuity check than the "disable a check" pattern used in cycles 3–4: temporarily made the error arm simulate the *forbidden* behavior (kill all live sessions, then retry the cwd-scoped acquisition), reran, confirmed the test failed (proving it would catch a real eviction regression), reverted, reran to confirm green. Committed as `test(...)`.

**Refactor cycle:** Extracted the duplicated `acquire_session().await` + warn-and-continue block (identical between the `ServiceDefault` and `EntryNotFound` arms) into a private `acquire_default_session_or_warn` helper. Reran the full `bob serve` suite (52 passed) to confirm no behavior change, then formatted and committed.

**Tried and rejected:** Considered writing `resolve_periodic_cwd` fully test-first before any wiring (strict per-AC TDD ordering), but since AC-1 through AC-4 all live in the exact same `match resolution { .. }` block in the dispatcher, implementing them one arm at a time while leaving the others as compile-breaking gaps wasn't practical — instead implemented AC-1's full match (all four resolution outcomes) in one edit backed by the AC-1 test, then added dedicated tests for AC-2/AC-3/AC-4 against the already-correct code, with an explicit non-vacuity check for each (matching the precedent set in T-121/T-122's Work Logs for "test-after, verified non-vacuous" cycles). Considered hand-rolling an RFC 3339 timestamp with `std::time` alone to avoid touching `crates/bob/Cargo.toml`, but rejected it as unnecessary risk/inconsistency versus reusing the already-vetted `chrono = "0.4"` dependency identical to three sibling crates.

**What remains:** Nothing outstanding for T-127. All four acceptance criteria are implemented and covered by dedicated tests; the task's own verification command (`cargo build -p bob && cargo test -p bob serve && cargo test -p pi-agent-supervisor`) and the broader `cargo test --workspace` both pass cleanly, and `cargo fmt --all -- --check` is clean.

**Obstacles Encountered:** (1) `chrono` was not a direct `bob` dependency; added `chrono = "0.4"` to `crates/bob/Cargo.toml` (matching three sibling crates exactly) since `crates/bob/src/serve.rs`'s own AuditRecord construction needed it — a minor deviation from the literal Files to Touch list, noted for the reviewer. (2) An early AC-1 test draft left a stray `marker.txt` in the crate root from a warm-pool worker inheriting the unset default cwd; fixed at the root cause (`warm_pool_size: 0`) rather than papering over it. (3) Pre-existing `cargo clippy -p pi-agent-supervisor` failure at `pool.rs::register_interactive_exit_watcher` reproduced during a sanity pass; confirmed unrelated to this diff and already documented as pre-existing debt in T-126's independent review and in this repo's CLAUDE.md. No `pi` binary was required — all new tests use `sh` stand-ins consistent with this file's existing conventions.

## Review
