---
id: B-001
title: bob serve does not answer status/sessions over admin socket
severity: high
status: in-progress
created: '2026-05-18'
task: T-025
---

# bob serve does not answer status/sessions over admin socket

## Summary

`bob serve` creates both Unix sockets but does not answer admin RPC calls over
`admin.sock`, so shell commands that rely on that channel (for example
`bob status` and `bob sessions list --json`) block until externally timed out.
This blocks T-025 AC-2/AC-3 and any end-to-end shell path that depends on
service-side admin RPC handling.

## Reproduction Status

Status: confirmed

Observed consistently in an elevated test run with explicit command deadlines.

## Evidence

- Logs / stack traces / failing assertions:
  - `bob status timed out after 1s` in `crates/bob/tests/shell_e2e.rs`
- Screenshots or recordings:
  - none
- Failing command or test:
  - `cd the-intern/service && cargo test --test shell_e2e -- --nocapture`
- First diagnostic step if not yet reproduced:
  - n/a

## Reproduction Steps

1. Create temp socket paths and spawn `bob serve` with
   `BOB_ADMIN_SOCK_PATH=<tmp>/admin.sock` and
   `BOB_EXTENSION_SOCK_PATH=<tmp>/extension.sock`.
2. Wait until both socket files exist.
3. Run `bob status` with the same environment overrides.
4. Observe that `bob status` does not exit within 1 second and must be killed.

## Expected Behavior

`bob status` should exit `0` and print a non-empty status payload while the
spawned `bob serve` process is running.

## Actual Behavior

`bob status` hangs and times out. Example assertion output:
`bob status timed out after 1s`.

## Environment

- OS / platform: Linux (Codex execution environment)
- Language / runtime version: Rust workspace under `the-intern/service`
- Relevant dependencies: `bob` crate / admin-rpc integration path
- Branch / commit: `task/T-025-add-end-to-end-shell-integration-smoke-test`

## Related

- Task: `T-025`
- Specification: `the-intern-agent-service-architecture.md`

## Suspected Area

`the-intern/service/crates/bob/src/serve.rs` runtime wiring between `serve`,
`admin-rpc`, and bound `admin.sock`.

## Fix Verification

```bash
cd the-intern/service && cargo test --test shell_e2e -- --nocapture
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

### Diagnosis 1 — 2026-05-18

Reproduction status:
- Confirmed.
- With elevated execution (outside sandbox socket restrictions), `cargo test --test shell_e2e -- --nocapture` fails consistently with:
  - `bob status timed out after 1s` (panic at `crates/bob/tests/shell_e2e.rs:187`).

Evidence captured:
- Canonical repro command failed as reported:
  - `cd the-intern/service && cargo test --test shell_e2e -- --nocapture`
  - Failure: `bob status timed out after 1s`.
- Direct trace with spawned `bob serve` showed:
  - both `/tmp/.../admin.sock` and `/tmp/.../extension.sock` exist (`-S` true),
  - `timeout 1s bob status` exits `124` (hang timeout),
  - serve logs show `admin-rpc actor started` but no listener-bind log from `admin-rpc`.
- Code evidence:
  - `bob serve` starts admin-rpc with defaults: `the-intern/service/crates/bob/src/serve.rs`
  - `admin-rpc` default has empty `admin_sock_path`: `the-intern/service/crates/admin-rpc/src/lib.rs`
  - `admin-rpc` only spawns listener when `admin_sock_path` is non-empty.
  - `bob serve`'s own listeners are explicitly "not polled".
  - client `status` call waits on `read_line` with no timeout, so no response means hang.

Isolated fault:
- Runtime wiring in `bob::serve::try_start_subsystems`: it creates inert bound sockets (`UnixListener::bind`) and keeps them alive, but does not connect them to request handling.
- Concurrently, `admin_rpc::start(Config::default())` disables `admin-rpc` listener creation, so no component accepts/dispatches admin RPC on `admin.sock`.

Root cause or fault hypothesis:
- Root cause: mismatched ownership contract for admin socket handling.
  - `bob` assumes it owns socket binding.
  - `admin-rpc` only runs accept loop when given `admin_sock_path`.
  - Current combination yields a bound socket file with no request handler, causing client calls (`status`, `sessions list`) to block waiting for replies.

Planned verification:
- After fix, run:
  - `cd the-intern/service && cargo test -p bob serve::tests`
  - `cd the-intern/service && cargo test -p admin-rpc`
  - `cd the-intern/service && cargo test --test shell_e2e -- --nocapture`
- Confirm `bob status` exits `0` with non-empty payload and `bob sessions list --json` returns `[]` while `bob serve` is running.

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
