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

## Verification

```bash
cd the-intern/service && cargo build -p bob && cargo test -p bob serve
```

## Work Log

## Review
