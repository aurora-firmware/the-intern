---
id: B-002
title: pi-agent-supervisor terminate test flakes under load because spawn_config
  sets 50 ms deadline
severity: high
status: resolved
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

### Diagnosis 1 — 2026-05-19

**Reproduction status:** Confirmed. Isolation runs (single test, 10×) 0/10 failures. Full suite default concurrency (20 runs) 3 failures with panic at `process.rs:436` (`cooperative child should terminate without force-kill`). `--test-threads=1` (5 runs) 0/5 failures. `--test-threads=16` (10 runs) 4/10 failures. Flake rate scales with concurrency, confirming a load-driven timing fault rather than a logic fault.

**Evidence captured:**
- Panic location: `crates/pi-agent-supervisor/src/process.rs:436` — assertion inside `terminate_requests_graceful_shutdown_before_deadline`.
- Failure observed only under concurrent test load; isolation always passes; sequential always passes.
- Test ordering shows `terminate_requests_graceful_shutdown_before_deadline` runs concurrently with other shell-spawning tests (T-039's pool-level tests), each launching `sh -c "trap 'exit 0' TERM; while :; do sleep 1; done"` children.

**Isolated fault:** `spawn_config` (`crates/pi-agent-supervisor/src/process.rs:225`) and `test_config` (`crates/pi-agent-supervisor/src/pool.rs:243` and `crates/pi-agent-supervisor/src/lib.rs:257`) set `child_termination_deadline: Duration::from_millis(50)`. With many concurrent `sh` children running `trap 'exit 0' TERM; while :; do sleep 1; done`, SIGTERM delivery + shell interrupting its `sleep 1` subprocess + trap handler + `exit 0` + kernel wait notification can collectively exceed 50 ms under scheduling pressure. `time::timeout(50ms, child.wait())` then expires, the supervisor force-kills, and `outcome.forced` becomes `true`, violating the test assertion.

**Root cause or fault hypothesis:** The 50 ms `child_termination_deadline` in the three test helpers is too tight for reliable cooperative shell termination on a loaded machine. Production `Config::default()` uses 10 s and is unaffected. The inline 25 ms config in `actor_shutdown_terminates_active_and_warm_worker_processes` (which uses `trap '' TERM` workers to intentionally exercise force-kill) is also unaffected by this hypothesis and must remain unchanged.

**Planned verification:** Raise `child_termination_deadline` to 500 ms (10× current value) in `spawn_config` (`process.rs:225`), `test_config` in `pool.rs:243`, and `test_config` in `lib.rs:257`. Leave the inline 25 ms configs intact. Then run:
```
for i in 1..10; do cargo test -p pi-agent-supervisor 2>&1 | grep "test result" | head -1; done
for i in 1..10; do cargo test -p pi-agent-supervisor -- --test-threads=16 2>&1 | grep "test result" | head -1; done
```
All runs must report `39 passed; 0 failed`.

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

### Session 1 — 2026-05-19

The diagnosis prescribed raising `child_termination_deadline` from 50 ms to 500 ms in the three test helpers (`spawn_config` in `process.rs:225`, `test_config` in `pool.rs:243`, `test_config` in `lib.rs:257`). The edits were applied and verification run.

500 ms turned out to be insufficient: under `--test-threads=16`, `terminate_requests_graceful_shutdown_before_deadline` still failed ~15% of the time. The cooperative worker is `sh -c "trap 'exit 0' TERM; while :; do sleep 1; done"`, and the shell only delivers the trap after the current `sleep 1` syscall returns. Worst-case cooperative response is therefore close to 1 s plus scheduling jitter — a 500 ms deadline is structurally too tight.

The deadline was raised to 2000 ms (2× margin over the 1 s sleep). 20 consecutive `--test-threads=16` runs passed. The official verification (10 normal-concurrency + 10 high-concurrency) then ran clean: `39 passed; 0 failed` every time.

The inline 25 ms `Config` in tests that intentionally exercise force-kill (e.g. `actor_shutdown_terminates_active_and_warm_worker_processes`, whose workers use `trap '' TERM`) was left untouched. Production `Config::default()` (10 s) was left untouched.

`Cargo.lock` also picked up one line: `tracing-subscriber` under the `extension-ipc` entry. That entry was already declared in `extension-ipc/Cargo.toml` as a `dev-dependencies` member; the lockfile was simply out of sync on `dev-agent`. The lockfile sync is included in the commit.

Commit on `bug/B-002-terminate-deadline-flake`: `2d2ed3f` — `fix(pi-agent-supervisor): raise test child_termination_deadline to 2000ms`. Nothing remains for the next session.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that diagnosis, fix, verification, and code quality passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->

### Review Verdict — 2026-05-19

PASS

**Stage 1 — Bug criteria**

- Diagnosis Log is present (Session 1 — 2026-05-19) and records all required fields: reproduction status (confirmed, 3/20 full-suite failures; 0/10 isolation failures; 4/10 under --test-threads=16), evidence captured (panic location `process.rs:436`, concurrency correlation), isolated fault (`spawn_config`/`test_config` at `process.rs:225`, `pool.rs:243`, `lib.rs:257`), and root cause hypothesis (50 ms deadline structurally too tight for a cooperative worker whose worst-case response is ~1 s due to `sleep 1` in the trap handler).
- Fix addresses the isolated fault exactly: `child_termination_deadline` raised from 50 ms to 2000 ms in all three test helpers. The deviation from the diagnosis-prescribed 500 ms is well-justified (500 ms still flaked ~15% under --test-threads=16 because worst-case shell response exceeds 500 ms) and is documented in both the commit message and Work Log.
- Fix Verification is documented in the Work Log: 10 normal-concurrency runs (39 passed; 0 failed) and 10 --test-threads=16 runs (39 passed; 0 failed). The bug's probabilistic nature makes empirical multi-run verification the appropriate substitute for a deterministic regression test; this is acceptable.
- Scope is correct: only the three test helpers were changed. Production `Config::default()` (10 s, `lib.rs:43`) is untouched. The intentional 25 ms force-kill configs (`process.rs:450`, `lib.rs:543`) are untouched. The remaining inline 50 ms configs in `process.rs` (lines 242, 274, 305) are in tests that spawn short-lived shell commands (`printf`, `if [ ... ]`) that exit immediately without needing cooperative termination — those are not related to the flake and correctly left unchanged.
- No unrelated behavior was added.

**Stage 2 — Code quality**

- Correctness: The 2000 ms value is the right order of magnitude; it provides 2× margin over the 1 s sleep period plus scheduling jitter. Logic is unchanged; only the constant is raised.
- Tests: No new test was added, which is appropriate: a deterministic regression test for a probabilistic timing flake is impractical. The empirical 20-run verification protocol is the project-standard substitute and is documented.
- Security: No credentials, no external input, no queries. Not applicable.
- Readability: The changed lines are straightforward numeric literal updates. No dead code or debugging artifacts introduced.
- Performance: Not applicable to a test-only constant change.
- Cargo.lock: The single added line (`tracing-subscriber` under the `extension-ipc` package) matches the existing `[dev-dependencies]` declaration in `extension-ipc/Cargo.toml`. The lockfile was simply out of sync; the change is legitimate and introduces no new dependency.
