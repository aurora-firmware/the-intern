---
id: B-013
title: admin-rpc dispatch sessions.list/kill tests fail under T-101 extension 
  fail-closed gate
severity: high
status: open
created: '2026-06-23'
task: T-101
---

# admin-rpc dispatch sessions.list/kill tests fail under T-101 extension fail-closed gate

## Summary

Five `admin-rpc` dispatch unit tests for the existing `sessions.list` and
`sessions.kill` methods fail because their test helpers start the supervisor
with `pi_agent_supervisor::Config::default()`, which carries an **empty**
`extension_path`. T-101 added a fail-closed gate that rejects a missing
extension file, so `pi_agent_supervisor::start(Config::default())` now returns
`Err(ChildProcess)` and the helpers' `.expect(...)` panics. This leaves the
workspace baseline (`cargo test --workspace`) **red on `dev-agent`**, which
blocks the dev-loop from claiming any task. The fail-closed behaviour itself is
correct (T-101 / ADR); only the admin-rpc test helpers are stale.

This is an integration-filed regression: it was introduced when
`task/T-101-extension-spawn-guard` merged (commit `9a0306f`) but escaped
detection because T-101's verification scope was `cargo test -p pi-agent-supervisor`
and `cargo test -p bob` — it never ran `cargo test -p admin-rpc` despite changing
a contract (`pi_agent_supervisor::start`) that admin-rpc tests depend on.

source_branch: `task/T-101-extension-spawn-guard` (merged, deleted)

## Reproduction Status

Status: confirmed

Reproduced deterministically via `cargo test --workspace` from
`the-intern/service/`. Failure is logic-based (empty extension path), not
environmental — it does not depend on `pi` being on `PATH` (the gate at
`process.rs:43` checks the extension file before any spawn/exec) and is not the
documented Unix-socket sandbox caveat.

## Evidence

- Failing command: `cargo test --workspace` (from `the-intern/service/`)
- Failing target: `admin-rpc --lib` — `test result: FAILED. 114 passed; 5 failed`.
  Every other crate in the workspace is green (incl. `pi-agent-supervisor`: 42 passed).
- Failing tests:
  - `dispatch::tests::dispatch_sessions_list_with_active_session_returns_that_session_id`
  - `dispatch::tests::dispatch_sessions_list_returns_empty_list_when_no_sessions`
  - `dispatch::tests::dispatch_sessions_kill_without_params_returns_invalid_request`
  - `dispatch::tests::dispatch_sessions_kill_with_unknown_session_id_returns_invalid_request`
  - `dispatch::tests::dispatch_sessions_kill_with_valid_session_id_returns_ok`
- Panic (identical for all five):
  ```
  panicked at crates/admin-rpc/src/dispatch.rs:1228:
  supervisor start must succeed in tests:
  ChildProcess { detail: "pi extension file does not exist at expected path ''" }
  ```

## Reproduction Steps

1. Check out `dev-agent` (clean tree).
2. From `the-intern/service/`, run `cargo test -p admin-rpc` (or `cargo test --workspace`).
3. Observe the five `dispatch::tests::dispatch_sessions_*` failures above.

## Expected Behavior

`cargo test -p admin-rpc` and `cargo test --workspace` pass on `dev-agent`. The
`sessions.list` / `sessions.kill` dispatch tests construct a supervisor whose
`extension_path` points at a real file (the contract T-101 introduced), so
`pi_agent_supervisor::start` succeeds.

## Actual Behavior

The two test helpers in `dispatch.rs` —
`make_dispatcher_with_supervisor()` (`dispatch.rs:1226`) and
`make_supervisor_handle()` (`dispatch.rs:1233`) — call
`pi_agent_supervisor::start(pi_agent_supervisor::Config::default())`.
`Config::default()` sets `extension_path: PathBuf::new()` (empty) and
`warm_pool_size > 0`, so `start` → `pool::SessionPool::new` eagerly prewarms a
worker → `process.rs:43` `if !cfg.extension_path.is_file()` rejects the empty
path → `Err(ChildProcess { detail: "pi extension file does not exist at expected
path ''" })`. The helpers `.expect("supervisor start must succeed in tests")`
and panic.

## Environment

- OS / platform: Linux (Debian 13, kernel 6.12)
- Language / runtime version: Rust (workspace toolchain via mise)
- Relevant dependencies: `pi-agent-supervisor`, `admin-rpc`
- Branch / commit: `dev-agent` @ `53b59c1`; regression introduced at merge `9a0306f` (T-101)

## Related

- Task: `T-101` (introduced the fail-closed extension gate)
- Specification: `CR-002` / `CR-003` (CR-002 pending tasks T-104–T-108 also touch this area but do not fix these helpers)

## Suspected Area

`the-intern/service/crates/admin-rpc/src/dispatch.rs` — the test helpers
`make_dispatcher_with_supervisor()` and `make_supervisor_handle()`. They must set
a real `extension_path` on the `Config` before calling
`pi_agent_supervisor::start`, mirroring the supervisor's own `test_config`
pattern (`pi-agent-supervisor/src/lib.rs:262`, which uses
`std::env::current_exe()`). No production code change is expected.

## Fix Verification

```bash
cd the-intern/service && cargo test -p admin-rpc
cd the-intern/service && cargo test --workspace
```

## Diagnosis Log

<!-- Mandatory before implementation. Append one entry before changing production code. Format:
### Diagnosis N — YYYY-MM-DD
Reproduction status:
Evidence captured:
Isolated fault:
Root cause or fault hypothesis:
Planned verification:
-->

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that diagnosis, fix, verification, and code quality passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->
