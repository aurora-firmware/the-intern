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

### Diagnosis 1 — 2026-07-17

Reproduction status: intermittent, confirmed via CI evidence only (not independently re-run this
session; consistent with the bug file's own record of 15/15 local isolated runs and 3x concurrent
local full-suite runs passing). Live reproduction was not attempted, since the defect is understood
to be CI-load-dependent and not reproducible on demand locally.

Evidence captured:
- `git diff dev-agent -- crates/bob/src/serve.rs crates/pi-agent-supervisor/` on the bug branch
  produced no output — the code read in this session is byte-identical to what CI executed for the
  two reported failures.
- Full read of the idle-reaper call chain: `crates/pi-agent-supervisor/src/reaper.rs` (pure/bounded
  selection helpers), `crates/pi-agent-supervisor/src/pool.rs::reap_idle_and_surplus`/`kill_session`/
  `send_prompt`, `crates/pi-agent-supervisor/src/lib.rs::Actor::run` (the `tokio::select!` loop with
  `reap_tick = time::interval(idle_reap_timeout)`), and
  `crates/pi-agent-supervisor/src/process.rs::terminate` (SIGTERM →
  `time::timeout(child_termination_deadline, child.wait())` → SIGKILL fallback). All operations are
  internally bounded (worst-case logical latency in this test's config: ~100ms tick granularity +
  250ms termination deadline, well under the 5s test budget).
- `grep -n "Duration::from_secs(5)\|flavor = " crates/bob/src/serve.rs`: `current_thread` flavor +
  `Duration::from_secs(5)` outer timeouts are the standard convention across ~30+ tests in this file,
  not a margin unique to the failing test.
- `crates/pi-agent-supervisor/src/lib.rs:673-701`
  (`idle_reaper_removes_session_after_idle_timeout_without_prompt_activity`) uses an even tighter,
  non-polling pattern (fixed 180ms sleep vs. 40ms configured timeout, no retry), showing the B-025
  test's polling-with-timeout style is already the more robust convention in this codebase.
- `grep -rn "flavor = \"multi_thread\"" --include="*.rs" .`: precedent exists in
  `crates/admin-rpc/src/lib.rs` and `crates/bob/src/cli/commands/chat.rs` for `multi_thread` test
  runtimes.
- `.github/workflows/build.yml`: the `tests` job has no explicit matrix; the workflow's
  `on: pull_request` + `on: push: branches: [dev-agent, main]` triggers means a commit whose PR head
  branch is `dev-agent` (PR #38, "Promote dev-agent → main") fires two independent workflow runs,
  each with its own `Tests` job (`cargo test --workspace`) landing on the same self-hosted runner
  concurrently — directly matching the bug report's "only one of two parallel Tests jobs failed, same
  commit" observation as a CI-topology effect, not a defect in the code under test.
- `grep -rn "idle reaper must eventually release" . --include="*.rs"`: the panic string is unique to
  `crates/bob/src/serve.rs:2002` (`.expect(...)`). The CI panic cites `:2003:14`, a one-line
  discrepancy against the byte-identical current file; noted as a minor, non-material evidence
  caveat with no alternate candidate call site.

Isolated fault: not a defect in `pi-agent-supervisor`'s reaper/pool/process logic — that code is
deterministic and internally bounded. The fault is in the test itself:
`serve::tests::periodic::periodic_event_is_dispatched_to_pi_agent_with_payload_as_prompt`
(`crates/bob/src/serve.rs:1916-2005`), specifically the second
`tokio::time::timeout(Duration::from_secs(5), ...)` block at lines 1987-2002, which polls
`list_sessions()` for the idle-reaper release. Its fixed 5s wall-clock budget, combined with
`#[tokio::test(flavor = "current_thread")]` (all of the test's async work — actor task, reap timer,
20ms poll loop, real `sh` subprocess I/O — sharing one OS thread) and real subprocess spawn/
SIGTERM/wait() I/O, has insufficient headroom when that one OS thread is denied scheduling for an
extended stretch under CI-runner contention (a second, concurrently-triggered `Tests` job on the
same commit per the `build.yml` trigger analysis above).

Root cause / fault hypothesis: timing-margin defect in the test, not a logic bug in production code
(evidence-backed via code reading rather than live reproduction). The reaper's own required work
completes in well under 500ms of logical latency; the observed CI failures are explained by real
wall-clock scheduling starvation of the test's single OS thread under contention from a second
concurrent `Tests` job on the same self-hosted runner, which the fixed 5s `tokio::time::timeout`
does not tolerate in the worst case. This does not weaken confidence in the reaper's correctness —
every other reaper-related test passed in both failing CI runs.

Planned fix: increase the outer timeout margin for the idle-reaper-release wait (the block at
`serve.rs:1987-2002`) to a substantially larger fixed budget (e.g. 15-30s) to absorb realistic
contention spikes while still failing fast in the ordinary case, and/or change the test's
`#[tokio::test(...)]` attribute to `flavor = "multi_thread"` (with a small `worker_threads` count,
matching the precedent in `crates/admin-rpc/src/lib.rs` / `crates/bob/src/cli/commands/chat.rs`) so
the actor task, the poll loop, and subprocess I/O are not all serialized onto one potentially-starved
OS thread. Either change preserves exactly what the test verifies (that the idle reaper eventually
releases the one-shot session) — it only widens the margin/scheduling model, not the assertion.

Planned verification:
```bash
cd the-intern/service
cargo test -p bob --lib serve::tests::periodic::periodic_event_is_dispatched_to_pi_agent_with_payload_as_prompt -- --exact
cargo test --workspace
```
Ideally also confirmed by two consecutive green CI runs on PR #38 after the change lands.

## Work Log

### Session 1 — 2026-07-17

Fixed the flaky-CI timing test diagnosed in B-025. Changed
`periodic_event_is_dispatched_to_pi_agent_with_payload_as_prompt`
(`the-intern/service/crates/bob/src/serve.rs`) from
`#[tokio::test(flavor = "current_thread")]` to
`#[tokio::test(flavor = "multi_thread", worker_threads = 2)]`, matching
existing precedent in `crates/admin-rpc/src/lib.rs` and
`crates/bob/src/cli/commands/chat.rs`, and widened both
`tokio::time::timeout(Duration::from_secs(5), ...)` blocks in that test (the
dispatch-forward wait and the idle-reaper-release wait) to
`Duration::from_secs(20)`.

Widened both waits, not just the one that actually failed in CI, since the
diagnosis flagged that both share identical structural exposure (real
subprocess I/O + poll loop previously serialized on one OS thread) — a
partial fix leaving one wait fragile under the same failure mode would be
inconsistent. Did not touch the ~30 other tests in `serve.rs` sharing the
same `current_thread` + `Duration::from_secs(5)` convention, since the
diagnosis scoped those as ordinary convention, not defects. Chose 20s
(within the diagnosis's suggested 15-30s range) as a middle ground, and
applied both the timeout widening and the runtime-flavor change together as
complementary defenses, since the diagnosis's scheduling analysis suggested
the flavor change addresses the actual starvation mechanism while the wider
timeout absorbs residual contention neither fix alone would fully cover.

Verification: `cargo test -p bob --lib serve::tests::periodic::periodic_event_is_dispatched_to_pi_agent_with_payload_as_prompt -- --exact`
ran 13 times total (10 pre-commit + 3 post-commit), 13/13 passed, ~0.21-0.22s
each — confirming the widened timeout doesn't slow normal execution, only
worst-case headroom changed. Simulated contention: 20 concurrent runs of the
target test overlapped with two background loops each running the full
`serve::` suite (56 tests) three times — 20/20 target runs and 6/6 full-suite
runs passed, 0 failures (a heavier simulation than the diagnosis's own 3x
concurrent attempt). Local reproduction of the original CI failure was never
achieved, consistent with the bug report — the sandbox doesn't match the
self-hosted runner's contention profile, so this builds confidence but final
confirmation requires green CI on the actual PR. `cargo test --workspace`
all green, 0 failed. `cargo fmt --all -- --check` clean. Diff scope confirmed
via `git diff dev-agent --stat`: only `serve.rs` changed (25 insertions, 3
deletions), confined to the one diagnosed test function.

**Obstacles Encountered:** Background subshell `cargo test` invocations
initially failed with a cwd-propagation quirk specific to the sandboxed bash
tool; worked around with absolute `--manifest-path` per subshell — local
tooling friction only, unrelated to the bug. Local reproduction of the CI
failure was not achieved; the contention simulation is a best-effort
confidence builder, not proof under exact CI conditions.

## Review
