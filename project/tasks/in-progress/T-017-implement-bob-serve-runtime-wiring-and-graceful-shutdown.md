---
id: T-017
title: Implement bob serve runtime wiring and graceful shutdown
status: pending
priority: high
assigned-role: unassigned
created: '2026-05-16'
spec: S-001
---

# Implement bob serve runtime wiring and graceful shutdown

## Description

Fill `crates/bob/src/serve.rs` (stubbed in T-014) with the runtime wiring
S-002 §Component 3 describes. The function constructs every subsystem actor
using the scaffold implementations from T-011, T-012, T-013, hands each
adapter the handles it depends on (admin-rpc gets handles to every subsystem
its method registry dispatches to; extension-ipc gets policy-control and
monitoring handles; requests-handler gets persistence and monitoring; …),
binds `admin.sock` and `extension.sock`, installs SIGTERM/SIGINT handlers,
and runs the shutdown protocol from Rust coding guidelines §8 when a signal
arrives.

Shutdown sequence: stop accepting new admin connections → cancel subsystem
workers → drain bounded queues up to `cfg.shutdown_drain_deadline` → reap
pi-agent children (none yet in scaffold, but the call is made and times out
under `cfg.shutdown_reap_deadline`) → flush audit (no-op for scaffold) →
remove socket files → exit. Each phase emits a `tracing::info!` span.

## Acceptance Criteria

AC-1: The system shall provide `bob::serve::run(cfg: BobConfig)` that constructs every subsystem actor from T-011, T-012, T-013 and binds `admin.sock` and `extension.sock` at the configured paths.
AC-2: WHEN `SIGTERM` or `SIGINT` is delivered to a running `bob serve` process THE SYSTEM SHALL stop accepting new admin connections, cancel subsystem workers, attempt to drain bounded queues within `cfg.shutdown_drain_deadline`, remove the two socket files, and exit with code 0.
AC-3: IF any subsystem actor fails to start during `serve::run` THEN THE SYSTEM SHALL emit `tracing::error!`, unwind any partially bound state (including socket files), and return `Err(ServiceError::ServiceDown)`.
AC-4: WHILE `bob serve` is running THE SYSTEM SHALL emit a `tracing::info!` event for each subsystem actor's start and stop lifecycle.

## Dependencies

- `T-011`, `T-012`, `T-013` — subsystem scaffolds
- `T-015` — `BobConfig` populated
- `T-016` — tracing initialised before `serve::run` is called

## Files to Touch

- `the-intern/service/crates/bob/src/serve.rs` — replace stub; full wiring + shutdown protocol
- `the-intern/service/crates/bob/Cargo.toml` — touch; add `tokio` features `signal`, `rt-multi-thread`, `macros`, and path-deps on every subsystem crate

## Verification

```bash
cd the-intern/service && cargo test -p bob serve::tests
cd the-intern/service && cargo build -p bob
# manual: run `cargo run -p bob -- serve` and send SIGTERM; exit code must be 0.
```

## Work Log

## Review
