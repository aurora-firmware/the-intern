---
id: B-026
title: periodic_event_is_dispatched_to_pi_agent_with_payload_as_prompt still 
  hangs the full 20s timeout on CI after B-025's widen+multi_thread fix
severity: high
status: open
created: '2026-07-17'
---

# periodic_event_is_dispatched_to_pi_agent_with_payload_as_prompt still hangs the full 20s timeout on CI after B-025's widen+multi_thread fix

## Summary

B-025 diagnosed the CI failures of
`serve::tests::periodic::periodic_event_is_dispatched_to_pi_agent_with_payload_as_prompt`
(`the-intern/service/crates/bob/src/serve.rs`) as a test timing-margin issue —
a `#[tokio::test(flavor = "current_thread")]` test whose 5s outer timeout was
theorized to be insufficient under CI-runner scheduling contention (two
workflow runs firing for the same commit, since PR #38's head branch is
`dev-agent`). The fix (commit `d1a51c7`, merged) switched the test to
`flavor = "multi_thread", worker_threads = 2` and widened both outer
timeouts from 5s to 20s. That fix was reviewed PASS and merged, but the very
next CI run failed the **same test, same assertion, same panic message**
again — and critically, the failure log shows `finished in 20.16s`, meaning
the test consumed the *entire* widened 20-second budget without the idle
reaper's release ever being observed. This is a much stronger signal than
the original B-025 evidence: exhausting a 20x-widened timeout (200x the
configured 100ms `pi_agent_idle_reap_timeout`) is far less consistent with
"occasionally not enough scheduling headroom" and more consistent with
either (a) a genuine hang/deadlock specific to the CI environment that B-025
did not identify, (b) a regression introduced by the `multi_thread` runtime
switch itself, or (c) CI-runner resource starvation severe enough (e.g. CPU
quota/cgroup throttling causing multi-second-to-tens-of-seconds freezes,
not just slower scheduling) that no reasonable fixed timeout is safe. B-025
should be treated as necessary-but-insufficient, not wrong to have
attempted — but its "just widen + change flavor" fix did not resolve the
underlying issue and a deeper investigation is needed before merging PR #38
with confidence in a stable CI signal.

## Reproduction Status

Status: confirmed on CI (second and third consecutive CI failure of this
same test, across three separate pushes to `dev-agent`/PR #38 — the first
two with the original 5s timeout, pre-B-025; this third one with B-025's
20s timeout + multi_thread already applied). Still never reproduced locally
despite deliberate contention simulation in both B-025's diagnosis and its
implementation session.

## Evidence

- CI run (post-B-025-merge): `https://github.com/aurora-firmware/the-intern/actions/runs/29608348894/job/87976900354`
  — `Tests` job:
  ```
  thread 'serve::tests::periodic::periodic_event_is_dispatched_to_pi_agent_with_payload_as_prompt' panicked at crates/bob/src/serve.rs:2025:14:
  idle reaper must eventually release the one-shot session: Elapsed(())
  test result: FAILED. 157 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 20.16s
  ```
  Note the line number shifted from `:2003`/`:2002` (pre-B-025) to `:2025`
  because B-025's diff added lines above it — same call site, same
  `.expect("idle reaper must eventually release the one-shot session")`.
- The *parallel* matrix job for the same commit
  (`https://github.com/aurora-firmware/the-intern/actions/runs/29608346872/job/87976893577`)
  passed, with the entire `Tests` job finishing in 43s total (all ~275
  tests across the workspace) — meaning the passing job was not itself
  under heavy load system-wide, which is at least mildly inconsistent with
  a pure "whole runner is CPU-starved" explanation, though it doesn't rule
  out asymmetric load between the two specific jobs.
- Two prior CI failures on the *pre-B-025* code (5s timeout,
  `current_thread`) are documented in B-025's own bug file:
  `https://github.com/aurora-firmware/the-intern/actions/runs/29561962415/job/87826174214`
  and
  `https://github.com/aurora-firmware/the-intern/actions/runs/29606972803/job/87972449137`
  — both also `Elapsed(())` at the same assertion, both also only on one of
  two parallel matrix jobs.
- B-025's local verification (10-13 isolated runs, 20 concurrent runs under
  simulated contention with two background full-suite loops) never
  reproduced any failure — the failure is CI-environment-specific and has
  now defeated a 4x timeout increase plus a runtime-flavor change.

## Reproduction Steps

Not reproducible on demand locally. Push a commit to `dev-agent` (PR #38's
head branch, which triggers two concurrent CI workflow runs for the same
commit) and observe whether one of the two `Tests` jobs fails on this test.
Has now failed 3 out of 3 times this has been observable in CI across two
different timeout configurations (5s pre-B-025, 20s post-B-025).

## Expected Behavior

The test should pass reliably on CI. If the underlying cause is CI-runner
resource contention severe enough to stall a test for 20+ real seconds, that
either needs a fundamentally different test design (not dependent on a race
against wall-clock time) or is an infrastructure capacity issue that a test
timeout cannot paper over indefinitely.

## Actual Behavior

The test consumes its entire timeout budget (confirmed at both 5s and 20s)
without the idle reaper's release being observed, on one of two concurrent
CI jobs, every time it has been observed to fail — never a near-miss
(e.g., failing at 4.8s of a 5s budget or 19s of a 20s budget with only
fractional shortfall), which points away from "borderline timing" and
toward either a real stall/hang under CI conditions or brutally severe,
essentially unbounded contention.

## Environment

- OS / platform: Linux (self-hosted GitHub Actions runner, container image
  `localhost:5000/rust-dev:1.0.1`).
- Language / runtime version: Rust workspace at `the-intern/service`,
  `RUSTUP_TOOLCHAIN: 1.96.0-x86_64-unknown-linux-gnu`.
- Relevant dependencies: real subprocess spawn/IPC via `pi-agent-supervisor`;
  the supervisor's idle-reaper background task; as of B-025,
  `#[tokio::test(flavor = "multi_thread", worker_threads = 2)]`.
- Branch / commit: `dev-agent` at `47a539e` (after B-025 merged) — failure
  observed on the immediately following CI run.

## Related

- Bug: `B-025` (prior diagnosis/fix attempt for the same test failing the
  same way; its fix is merged but did not resolve the issue — this bug
  supersedes it with stronger evidence).
- PR: `#38` (`Promote dev-agent → main: scheduler JSON-state persistence,
  reliability fixes, per-entry cwd resolution`) — still blocks fully green
  CI on this PR.

## Suspected Area

`the-intern/service/crates/bob/src/serve.rs`, test
`periodic_event_is_dispatched_to_pi_agent_with_payload_as_prompt`, and/or
`the-intern/service/crates/pi-agent-supervisor/` (idle reaper, pool,
process termination) — B-025's diagnosis found this production code
deterministic and bounded by reading it, but did not achieve live
reproduction to actually exercise it under failure conditions; that
conclusion should be re-examined given the fix's failure to resolve the
issue. Also consider whether `flavor = "multi_thread"` itself interacts
badly with any `!Send`/thread-affinity assumption elsewhere in the
supervisor or its test doubles.

## Fix Verification

```bash
cd the-intern/service && cargo test -p bob --lib serve::tests::periodic::periodic_event_is_dispatched_to_pi_agent_with_payload_as_prompt -- --exact
cd the-intern/service && cargo test --workspace
# Real verification requires observing at least two consecutive green CI
# Tests runs on both matrix jobs after the fix lands.
```

## Diagnosis Log

## Work Log

## Review
