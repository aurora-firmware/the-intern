---
id: B-002
title: pi-agent-supervisor terminate test flakes under load because spawn_config
  sets 50 ms deadline
severity: high
status: open
created: '2026-05-19'
---

# pi-agent-supervisor terminate test flakes under load because spawn_config sets 50 ms deadline

## Summary

The test `pi_agent_supervisor::process::tests::terminate_requests_graceful_shutdown_before_deadline` fails ~30 % of full-suite runs under concurrent test load and passes 100 % in isolation. The `spawn_config` test helper at `crates/pi-agent-supervisor/src/process.rs:225` (and the matching `test_config` helper in `pool.rs`) sets `child_termination_deadline: Duration::from_millis(50)`. Under load that budget cannot reliably absorb shell startup + signal delivery + tokio scheduling latency for `sh -c "trap 'exit 0' TERM; while :; do sleep 1; done"`, so `terminate()` falls into the force-kill path and the test's `assert!(!outcome.forced)` fails. T-039's new pool-level tests (`reap_idle_and_surplus_*`, `actor_shutdown_*`, `idle_reaper_*`, `sessions_list_reports_same_id_…`) spawn the same `trap … sleep 1` workers under the same 50 ms budget, increasing concurrency on the deadline and pushing the flake from rare to reliable.

## Reproduction Status

Status: confirmed — 3 failures in 10 consecutive runs of `cargo test -p pi-agent-supervisor` on `dev-agent` post-T-040; 5/5 isolation runs pass.

## Evidence

- Logs / stack traces / failing assertions: Failing assertion: `cooperative child should terminate without force-kill` (panic at `process.rs:436`).
- Screenshots or recordings: none
- Failing command or test: `cargo test -p pi-agent-supervisor` (full suite).
- First diagnostic step if not yet reproduced: Run `cargo test -p pi-agent-supervisor process::tests::terminate_requests_graceful_shutdown_before_deadline` in isolation — should pass. Then run the full suite 10 times to observe intermittent failures.

## Reproduction Steps

1. `cd the-intern/service`
2. Run `for i in 1..10; do cargo test -p pi-agent-supervisor 2>&1 | grep -E "test result|FAILED"; done`
3. Observe that 2–3 of the 10 runs report `test process::tests::terminate_requests_graceful_shutdown_before_deadline ... FAILED` with panic message `cooperative child should terminate without force-kill`.

## Expected Behavior

All 39 tests in `pi-agent-supervisor` pass on every run, including under load.

## Actual Behavior

The `terminate_requests_graceful_shutdown_before_deadline` test fails ~30 % of full-suite runs with panic at `crates/pi-agent-supervisor/src/process.rs:436`.

## Environment

- OS / platform: Linux (Codex execution environment)
- Language / runtime version: Rust workspace under `the-intern/service` (rustc stable)
- Relevant dependencies: `pi-agent-supervisor` crate, tokio test runtime
- Branch / commit: `dev-agent` post-merge of T-040 (`ceb872d`)

## Related

- Task: `T-039`
- Specification: none

## Suspected Area

`the-intern/service/crates/pi-agent-supervisor/src/process.rs:225` — `child_termination_deadline: Duration::from_millis(50)` in the test-only `spawn_config` helper. Same value in `pool.rs` `test_config`. Production callers configure their own deadline and are unaffected.

## Fix Verification

```bash
cd the-intern/service
for i in 1 2 3 4 5 6 7 8 9 10; do cargo test -p pi-agent-supervisor 2>&1 | grep -E "test result" | head -1; done
```

All 10 runs must report 39 passed / 0 failed.

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
