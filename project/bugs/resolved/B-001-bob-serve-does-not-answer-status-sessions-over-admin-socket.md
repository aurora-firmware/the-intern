---
id: B-001
title: bob serve does not answer status/sessions over admin socket
severity: high
status: resolved
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

### Session 1 — 2026-05-18

Implemented B-001 using the recorded diagnosis as contract. I first reproduced the bug with the shell E2E test in elevated mode: `bob status` timed out while `bob serve` was running and both sockets existed, matching diagnosis. I then changed `bob::serve` wiring so `admin-rpc` is started with `admin_sock_path`, allowed UIDs, and subsystem handles (including supervisor), and removed the inert local admin listener binding in `serve.rs`. I kept extension socket lifecycle in `bob::serve` and retained explicit socket-file cleanup on shutdown. I added a guard that fails startup if `admin-rpc` did not create `admin.sock`, preserving service-down behavior for bind failures.

I adopted the provisional untracked regression test `crates/bob/tests/shell_e2e.rs`, formatted it, and committed it with the fix. I considered keeping socket ownership in `bob::serve` and teaching `admin-rpc` to consume a pre-bound listener, but rejected that as broader than needed for this bug; the minimal fix is to let `admin-rpc` own admin socket serving and keep `bob` cleanup semantics. Remaining work: reviewer pass and lifecycle updates on `dev-agent`.

Obstacles Encountered:
- Unix-domain-socket tests fail in sandbox with `Operation not permitted`; verification required elevated runs.
- No other blockers.

### Session 2 — 2026-05-18

Addressed the reviewer-reported flake at `shell_e2e` shutdown (`bob serve should exit before shutdown drain deadline`). I reproduced the failure in elevated runs exactly at the reported assertion, then measured SIGTERM-to-exit timing and observed shutdown finishing slightly above the configured `800ms` drain window (typically ~818-833ms), which made the exact-deadline assertion brittle. I updated the test to keep the same behavioral contract but with a bounded tolerance tied to configured drain behavior: `shutdown_exit_deadline = SHUTDOWN_DRAIN_DEADLINE + SHUTDOWN_EXIT_MARGIN` (300ms). I kept the clean-exit (`code 0`) and socket-file cleanup assertions unchanged.

I considered changing `serve` shutdown internals to force stricter timing, but rejected that because the issue is assertion brittleness rather than a service behavior defect, and the requested fix was to make verification robust while preserving intent.

What remains: reviewer re-check and canonical lifecycle updates on `dev-agent` (this bug branch intentionally did not edit the bug lifecycle file).

Evidence:
- Red repro (elevated): `cd the-intern/service && cargo test --test shell_e2e -- --nocapture` failed at `crates/bob/tests/shell_e2e.rs:148` with `bob serve should exit before shutdown drain deadline`.
- Timing evidence (elevated manual runs): shutdown observed around `818-833ms` with `BOB_SHUTDOWN_DRAIN_DEADLINE=800ms`.
- Required verification (elevated due Unix socket sandbox restriction): `cargo test -p bob serve::tests`, `cargo test -p admin-rpc`, and `cargo test --test shell_e2e -- --nocapture` all passed.
- Stability check: repeated `shell_e2e` 10 consecutive runs, all passed.

Obstacles Encountered:
- Sandbox blocks Unix-domain socket bind with `Operation not permitted`; Unix-socket tests required elevated execution for valid verification.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that diagnosis, fix, verification, and code quality passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->

### Review Verdict — 2026-05-18
FAIL

- File and location: `the-intern/service/crates/bob/tests/shell_e2e.rs:148`
  - What is wrong: The canonical Fix Verification command in this bug file (`cd the-intern/service && cargo test --test shell_e2e -- --nocapture`) is not reliably passing on the implementation branch. Repeated elevated runs fail with `bob serve should exit before shutdown drain deadline`, so verification is unstable.
  - What should change: Make the shutdown assertion robust (for example, add timing margin between configured drain deadline and wait timeout, or assert clean shutdown with a less brittle timeout strategy), then rerun the canonical Fix Verification command until stable.

- File and location: `project/bugs/in-progress/B-001-bob-serve-does-not-answer-status-sessions-over-admin-socket.md` (Fix Verification section)
  - What is wrong: Fix Verification is currently documented as satisfied by a single command, but the current implementation/test combination is flaky under review execution and does not consistently satisfy that step.
  - What should change: Update implementation and/or test timing so this documented Fix Verification step passes consistently; keep the bug file verification step aligned with deterministic evidence.

### Review Verdict — 2026-05-18
PASS

- Stage 1 (bug criteria): passed.
  - Diagnosis Log includes reproduction status, captured evidence, isolated fault, and root cause hypothesis.
  - Implementation in `the-intern/service/crates/bob/src/serve.rs` now starts `admin-rpc` with `admin_sock_path`/UID policy and subsystem handles, and no longer relies on an inert admin listener owned by `bob serve`, aligning with the isolated cause.
  - Regression test exists at `the-intern/service/crates/bob/tests/shell_e2e.rs` and validates `bob status` plus `bob sessions list --json` over `admin.sock`.
- Stage 2 (code quality and verification): passed.
  - Shutdown assertion was stabilized via explicit margin (`SHUTDOWN_EXIT_MARGIN`) and is no longer brittle against small scheduling overhead.
  - Required Fix Verification commands passed in elevated mode:
    - `cd the-intern/service && cargo test -p bob serve::tests`
    - `cd the-intern/service && cargo test -p admin-rpc`
    - `cd the-intern/service && cargo test --test shell_e2e -- --nocapture`
  - Stability spot-check: `shell_e2e` passed 10 consecutive elevated runs.
