---
id: B-025
title: periodic_event_is_dispatched_to_pi_agent_with_payload_as_prompt 
  intermittently fails on CI with idle-reaper timeout elapsed
severity: high
status: in-progress
created: '2026-07-17'
---

# periodic_event_is_dispatched_to_pi_agent_with_payload_as_prompt intermittently fails on CI with idle-reaper timeout elapsed

## Summary

`serve::tests::periodic::periodic_event_is_dispatched_to_pi_agent_with_payload_as_prompt`
in `the-intern/service/crates/bob/src/serve.rs` has failed on the self-hosted CI
runner's `Tests` job twice in a row (on two separate pushes to `dev-agent`/PR
#38), each time with the identical panic
`idle reaper must eventually release the one-shot session: Elapsed(())` at
`crates/bob/src/serve.rs:2003:14`. Both times, only one of the two parallel
`Tests` matrix jobs failed while the other (running the identical commit)
passed cleanly, and the test has never failed locally (15/15 isolated runs,
and 3x concurrent local runs of the full `serve::` suite, all passed). This
points to CI-runner load/contention as the trigger, not a logic bug in the
fix under test, but it currently blocks PR #38 from having fully green CI on
every push.

## Reproduction Status

Status: intermittent — confirmed twice on CI (not a one-off), never
reproduced locally despite deliberate attempts to simulate load.

## Evidence

- CI run 1: `https://github.com/aurora-firmware/the-intern/actions/runs/29561962415/job/87826174214`
  — `Tests` job, `test result: FAILED. 157 passed; 1 failed`, same test, same
  panic message and location.
- CI run 2: `https://github.com/aurora-firmware/the-intern/actions/runs/29606972803/job/87972449137`
  — `Tests` job, `test result: FAILED. 157 passed; 1 failed`, identical panic:
  ```
  thread 'serve::tests::periodic::periodic_event_is_dispatched_to_pi_agent_with_payload_as_prompt' panicked at crates/bob/src/serve.rs:2003:14:
  idle reaper must eventually release the one-shot session: Elapsed(())
  ```
- In both runs, the *other* parallel `Tests` matrix job (same commit) passed
  cleanly, and every other job (`Build`, `Format`, `Documentation`, `User
  Documentation`) passed on both matrix slots both times.
- Local reproduction attempts (both unsuccessful — test passed every time):
  `cargo test -p bob --lib serve::tests::periodic::periodic_event_is_dispatched_to_pi_agent_with_payload_as_prompt -- --exact`,
  run 15 times consecutively: 15/15 passed, ~0.2s each.
  Three copies of `cargo test -p bob --lib serve::` run concurrently (to
  simulate CPU contention): all three runs' full suites (56 tests each)
  passed, 0 failed.
- Read the test (`the-intern/service/crates/bob/src/serve.rs`, function
  `periodic_event_is_dispatched_to_pi_agent_with_payload_as_prompt`): it is
  `#[tokio::test(flavor = "current_thread")]` — single-threaded — and spawns a
  real `sh` subprocess as the pi-agent worker, then polls (every 20ms, up to
  a hardcoded `Duration::from_secs(5)` outer timeout) for the supervisor's
  idle reaper to release the one-shot session. The test configures
  `pi_agent_idle_reap_timeout: Duration::from_millis(100)`, so under no
  contention the reaper should fire and be observed well within a few hundred
  milliseconds — the 5s budget is normally generous headroom, not a tight
  margin.

## Reproduction Steps

Not reliably reproducible on demand. Occurs on the self-hosted CI runner when
the `Tests` job's per-commit matrix (two parallel jobs, each running a full
`cargo test --workspace`) is under load. Ran twice, failed both times, always
on only one of the two parallel jobs.

## Expected Behavior

The test should pass consistently in CI regardless of concurrent load from
the other matrix job (or any other runner activity), since the test's actual
required work (spawn a `sh` subprocess, forward a prompt, wait ≤100ms for the
configured idle-reap timeout to elapse and be observed) is inherently fast.

## Actual Behavior

The test's outer 5-second timeout is occasionally insufficient on the
self-hosted CI runner, causing a panic under `Elapsed(())` even though the
underlying behavior (idle-reap release) is presumably still working correctly
— it just isn't observed within the test's fixed budget when the single
OS thread backing the `current_thread` tokio runtime doesn't get scheduled
promptly enough under host contention.

## Environment

- OS / platform: Linux (self-hosted GitHub Actions runner, container image
  `localhost:5000/rust-dev:1.0.1`).
- Language / runtime version: Rust workspace at `the-intern/service`,
  `RUSTUP_TOOLCHAIN: 1.96.0-x86_64-unknown-linux-gnu`; tokio `current_thread`
  test runtime.
- Relevant dependencies: real subprocess spawn (`sh` worker script) and IPC
  via `pi-agent-supervisor`; the supervisor's idle-reaper background task.
- Branch / commit: `dev-agent`, observed on commits `10c4f13` and `cec22e7`
  (both after B-022/B-023/B-024 were merged) — the test itself predates all
  three fixes and was not modified by any of them.

## Related

- PR: `#38` (`Promote dev-agent → main: scheduler JSON-state persistence,
  reliability fixes, per-entry cwd resolution`) — currently blocks fully
  green CI on this PR.
- Bug: `B-017` (periodic dispatcher no longer kills the pi worker immediately
  after prompt-delivery ack — this test's comment references B-017 as the
  reason release is left to the idle reaper rather than closed synchronously).

## Suspected Area

`the-intern/service/crates/bob/src/serve.rs`, test
`periodic_event_is_dispatched_to_pi_agent_with_payload_as_prompt` (around
line 1917-2005) — specifically the test's own timing assumptions (hardcoded
5s outer timeout, `current_thread` runtime flavor, real subprocess I/O), not
the production idle-reaper/dispatcher logic it exercises, which has no other
evidence of malfunction (every other periodic/reaper-related test passes
consistently).

## Fix Verification

```bash
# Must pass consistently, including under simulated CPU contention:
cd the-intern/service && cargo test -p bob --lib serve::tests::periodic::periodic_event_is_dispatched_to_pi_agent_with_payload_as_prompt -- --exact
cd the-intern/service && cargo test --workspace
# Ideally also verified to pass CI twice in a row after the fix.
```

## Diagnosis Log

## Work Log

## Review
