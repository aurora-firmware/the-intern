---
id: T-122
title: Add cwd-aware dedicated-worker session acquisition bounded by 
  max_processes
status: pending
priority: high
assigned-role: developer
created: '2026-07-05'
spec: S-002
---

# Add cwd-aware dedicated-worker session acquisition bounded by max_processes

## Description

Per S-002 (Component 6, warm-pool contract), a per-entry scheduled `cwd` cannot
reuse a warm-pool worker — warm workers are pre-spawned with the service-wide
cwd. Add a cwd-aware acquisition path on the pool
(`crates/pi-agent-supervisor/src/pool.rs`, spawn helper in `process.rs`) that
spawns a **dedicated** worker whose `current_dir` is a caller-supplied directory
instead of binding a warm worker. Bound it by `max_processes` exactly like the
existing `acquire_session`: when active + warm workers already fill the limit,
**refuse** the acquisition (no eviction, no exceeding the bound) so the caller
(T-127) can skip the fire. A dedicated cwd-scoped worker consumes one
`max_processes` slot for the duration of the run.

## Acceptance Criteria

AC-1: WHEN a session is acquired with a caller-supplied working directory THE
      SYSTEM SHALL spawn a dedicated worker whose current directory is that
      directory rather than reusing a warm-pool worker.
AC-2: IF active plus warm workers already fill `max_processes` when a cwd-scoped
      session is requested THEN THE SYSTEM SHALL refuse the acquisition without
      evicting a live worker or exceeding the bound.
AC-3: WHILE a cwd-scoped dedicated worker is active THE SYSTEM SHALL count it
      against the `max_processes` limit for the duration of the run.

## Dependencies

- `T-121` — supervisor `Config` and worker-spawn `current_dir` support

## Files to Touch

- `crates/pi-agent-supervisor/src/pool.rs` — add cwd-aware acquisition + bound check
- `crates/pi-agent-supervisor/src/process.rs` — spawn a dedicated worker at a cwd

## Verification

```bash
cd the-intern/service && cargo test -p pi-agent-supervisor
```

## Work Log

## Review
