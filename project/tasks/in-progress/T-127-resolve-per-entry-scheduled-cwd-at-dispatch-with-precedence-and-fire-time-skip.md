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

**Remaining work:** all four acceptance criteria, resuming the TDD cycle with the Architect's guidance above.

## Review
