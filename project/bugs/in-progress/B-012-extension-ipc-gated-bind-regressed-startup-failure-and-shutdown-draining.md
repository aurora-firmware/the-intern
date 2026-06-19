---
id: B-012
title: B-009 gated extension.sock bind regressed startup failure handling and
  shutdown connection draining
severity: medium
status: in-progress
created: '2026-06-19'
---

# B-009 gated extension.sock bind regressed startup failure handling and shutdown connection draining

## Summary

The B-009 fix routed the production `extension.sock` bind through
`extension_ipc::start()` (the gated `extension-ipc::Listener::bind`) and added a
shutdown signal to `run_listener`. PR #24 review found two regressions introduced
by that change, both in
`the-intern/service/crates/extension-ipc/src/lib.rs`:

1. **Bind failures no longer abort startup (security-relevant).**
   `extension_ipc::start()` logs a non-empty-path `Listener::bind` failure and
   returns `None`, letting `bob serve` continue without owning the configured
   extension socket. This regresses the documented `serve` contract that either
   socket bind failure returns `ServiceError::ServiceDown`. It is
   security-sensitive because the same `extension_sock_path` is still passed to
   pi-agent workers as `BOB_EXTENSION_SOCK_PATH`
   (`serve.rs` `build_pi_agent_supervisor_config`): if the configured path cannot
   be bound because another local user controls the parent/path, bob can report
   healthy while workers try to use a socket bob did not create.

2. **Accepted extension connections outlive shutdown.**
   `run_listener` spawns each accepted connection with
   `tokio::spawn(run_connection(...))` and neither tracks, signals, nor joins
   those tasks. On the production path an idle connected peer keeps cloned
   subsystem handles alive (`MonitoringBackedHandle`, policy snapshot), keeping
   actor channels open and forcing `run_shutdown_protocol` to wait until
   `shutdown_drain_deadline` instead of draining promptly.

## Reproduction Status

Status: confirmed (by PR #24 code review and direct code inspection).

## Evidence

- `extension-ipc/src/lib.rs:244-251` — non-empty-path `Listener::bind` failure is
  logged and swallowed (`None`); `start()` returns `(Handle, JoinHandle)` with no
  way to signal the failure.
- `serve.rs:180-187` — production path calls `extension_ipc::start(...)` and
  ignores any bind outcome (no `?`), unlike `admin_rpc::start(...).map_err(..)?`
  at `serve.rs:238`.
- `serve.rs:104` — `extension_sock_path` is forwarded to the pi-agent supervisor
  config (worker `BOB_EXTENSION_SOCK_PATH`) regardless of bind success.
- `extension-ipc/src/lib.rs:209` — accepted connections are detached via
  `tokio::spawn`; `run_listener` shutdown (`:196`) only stops accepting.

## Expected Behavior

1. A non-empty `extension_sock_path` whose listener cannot be bound must fail
   `bob serve` startup with `ServiceError::ServiceDown`, before any pi-agent
   worker is launched with that path. An empty path (scaffold/tests) remains a
   no-op that does not bind.
2. On shutdown, in-flight extension connections are torn down (aborted/joined) so
   they release subsystem handles and shutdown drains promptly.

## Actual Behavior

1. Bind failure is logged and `bob serve` continues without the socket.
2. Detached connection tasks survive listener shutdown and can hold subsystem
   handles open until the drain deadline elapses.

## Suspected Area

`the-intern/service/crates/extension-ipc/src/lib.rs` (`start`, `run_listener`)
and the call site `the-intern/service/crates/bob/src/serve.rs:180`.

## Fix Verification

```bash
# From the-intern/service/
cargo test -p extension-ipc
cargo test -p bob serve::tests
cargo test --workspace
cargo fmt --all -- --check
```

- `extension_ipc::start` returns `Result` and a non-empty unbindable path yields
  `Err`; `start_subsystems` with such a path returns `ServiceError::ServiceDown`.
- After `run_listener` shutdown, a connected peer's stream is closed (EOF), proving
  the connection task was torn down rather than left detached.

## Diagnosis Log

### Diagnosis 1 — 2026-06-19

Reproduction status: confirmed by PR #24 review and direct inspection of the code
on `dev-agent` (commits `52f215a`, `b53fc9e`).

Evidence captured: see the Evidence section above — the swallowed `None` bind
result at `lib.rs:244-251`, the unchecked `start()` call at `serve.rs:180`, the
worker path forwarding at `serve.rs:104`, and the detached connection spawn at
`lib.rs:209`.

Isolated fault:
- Part 1: `extension_ipc::start` has an infallible signature and discards bind
  failures, so the serve path cannot propagate them.
- Part 2: `run_listener` does not retain the connection task handles, so its
  shutdown path cannot stop them.

Root cause: the B-009 rewiring moved the bind into `extension_ipc::start` but kept
that function infallible (unlike `admin_rpc::start`), and added listener shutdown
without accounting for the connection tasks the listener spawns.

Planned verification: see Fix Verification.

## Work Log

### Session 1 — 2026-06-19

Fixed both regressions on branch `bug/B-012-extension-ipc-gated-bind-regressions`
(commit `0023026`).

Part 1 — startup failure handling. Changed `extension_ipc::start` from an
infallible `(Handle, JoinHandle)` to `std::io::Result<(Handle, JoinHandle)>`,
mirroring `admin_rpc::start`. A non-empty `extension_sock_path` now binds eagerly
and returns `Err` on failure (the silent `None` fallthrough is gone); an empty path
still binds nothing for the scaffold/test case. `serve.rs` propagates the error via
`.map_err(..)?`, so `start_subsystems` returns `ServiceError::ServiceDown` (and runs
best-effort socket cleanup) before any pi-agent worker is launched with
`BOB_EXTENSION_SOCK_PATH`. Updated the three in-crate `start()` call sites to
`.expect(..)`.

Part 2 — shutdown connection draining. `run_listener` now tracks accepted
connections in a `tokio::task::JoinSet`, reaps finished ones via a guarded
`join_next` select branch, and calls `connections.shutdown().await` after the
shutdown signal breaks the accept loop. The aborted connection tasks drop their
cloned monitoring/snapshot handles, so they no longer hold actor channels open past
the drain.

Regression tests added:
- `extension-ipc`: `start_with_unbindable_path_returns_err` (parent-is-a-file →
  `start` returns `Err`); `shutdown_tears_down_in_flight_connections` (a connected,
  verified-live peer sees EOF after shutdown, and the actor join completes within a
  timeout). The latter was confirmed red against the pre-fix `run_listener`.
- `bob`: `start_subsystems_returns_service_down_when_extension_socket_cannot_bind`.

Verification: `cargo test --workspace` passes (bob 118, extension-ipc 31, 0
failures); `cargo fmt --all -- --check` clean.

### Review Verdict — 2026-06-19

PASS (self-verified by the orchestrator outside the multi-agent loop). Both review
findings from PR #24 are addressed with code changes that match the documented
`serve` contract, each backed by a regression test, with the shutdown test confirmed
to fail against the pre-fix code. Full workspace suite and format check are green.
