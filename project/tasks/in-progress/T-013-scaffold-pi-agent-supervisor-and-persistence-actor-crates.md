---
id: T-013
title: Scaffold pi-agent-supervisor and persistence actor crates
status: pending
priority: high
assigned-role: unassigned
created: '2026-05-16'
spec: S-001
---

# Scaffold pi-agent-supervisor and persistence actor crates

## Description

Create the two remaining subsystem actor crates: `pi-agent-supervisor` (S-001
§Components, Phase 2 owner) and `persistence` (S-001 §Components, Phase 1b
fills it in). Same scaffold pattern as T-011 and T-012.

The supervisor's `Handle` exposes an extra method `list_sessions() -> ServiceResult<Vec<SessionId>>` that returns `Ok(Vec::new())` rather than
`NotImplemented`. This lets `bob sessions list` (T-019/T-024) work end-to-end
from day one against an empty pool, per S-002 §Component 6.

Dependencies: `tokio`, `bob-core`, `tracing`, `async-trait`. Both crates
forbid unsafe code.

## Acceptance Criteria

AC-1: The system shall provide library crates `pi-agent-supervisor` and `persistence` under `the-intern/service/crates/`, each exposing a public `Handle` and `start`.
AC-2: WHEN `pi_agent_supervisor::Handle::list_sessions` is called THE SYSTEM SHALL return `Ok(Vec::new())`.
AC-3: WHEN any other `Handle` command method on these two crates is called THE SYSTEM SHALL return `Err(ServiceError::NotImplemented)`.
AC-4: WHEN `cargo check --workspace --manifest-path the-intern/service/Cargo.toml` is run THE SYSTEM SHALL exit with code 0.
AC-5: The system shall declare `#![forbid(unsafe_code)]` in both crates' `lib.rs`.

## Dependencies

- `T-007` — workspace and `bob-core` skeleton
- `T-008` — `SessionId` used by `list_sessions`
- `T-009` — `ServiceError` / `ServiceResult`

## Files to Touch

- `the-intern/service/crates/pi-agent-supervisor/Cargo.toml` — new
- `the-intern/service/crates/pi-agent-supervisor/src/lib.rs` — new; scaffold + `list_sessions`
- `the-intern/service/crates/persistence/Cargo.toml` — new
- `the-intern/service/crates/persistence/src/lib.rs` — new; scaffold

## Verification

```bash
cd the-intern/service && cargo check --workspace
cd the-intern/service && cargo test -p pi-agent-supervisor --lib list_sessions
```

## Work Log

### Session 1 — 2026-05-17

Implemented T-013 by scaffolding two new service workspace crates: `pi-agent-supervisor` and `persistence`, following the existing actor pattern from prior subsystem scaffolds. I started with tests first for each crate. For `pi-agent-supervisor`, I intentionally returned `NotImplemented` from `list_sessions()` to force a red test, then changed it to `Ok(Vec::new())` for green; `kill_session()` remains `Err(ServiceError::NotImplemented)` and is covered by a focused test. For `persistence`, I intentionally returned `Ok(())` from `enqueue_event()` to force a red test, then changed it to `Err(ServiceError::NotImplemented)` for green. Both crates expose public clonable `Handle`, public `Actor`, `start(cfg) -> (Handle, JoinHandle<()>)`, and `#![forbid(unsafe_code)]` in `lib.rs`. I ran focused crate tests and both required workspace check commands; all passed. I considered adding extra persistence command methods, but kept the scaffold minimal and aligned with prior crate patterns to satisfy the acceptance criteria without introducing unneeded surface area. Nothing remains for this task branch.

## Review
