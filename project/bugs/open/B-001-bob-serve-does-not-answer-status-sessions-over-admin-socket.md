---
id: B-001
title: bob serve does not answer status/sessions over admin socket
severity: high
status: open
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
