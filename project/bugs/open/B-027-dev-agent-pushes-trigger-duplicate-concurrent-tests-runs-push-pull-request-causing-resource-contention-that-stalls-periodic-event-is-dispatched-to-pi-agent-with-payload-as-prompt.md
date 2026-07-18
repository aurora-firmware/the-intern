---
id: B-027
title: dev-agent pushes trigger duplicate concurrent Tests runs (push + 
  pull_request), causing resource contention that stalls 
  periodic_event_is_dispatched_to_pi_agent_with_payload_as_prompt
severity: high
status: open
created: '2026-07-18'
---

# dev-agent pushes trigger duplicate concurrent Tests runs (push + pull_request), causing resource contention that stalls periodic_event_is_dispatched_to_pi_agent_with_payload_as_prompt

## Summary

`.github/workflows/build.yml` triggers on both `pull_request` and
`push: branches: [dev-agent, main]`. Whenever a commit lands on `dev-agent`
while a `dev-agent` → `main` promotion PR is open (the repo's standard
workflow per `CLAUDE.md`'s git model — PR #38 is exactly this), that single
commit fires **two independent workflow runs** for the identical commit: one
from the `push` event, one from the `pull_request` event, started roughly
2 seconds apart, each running a full `cargo test --workspace` on the shared
self-hosted runner pool. This is genuine, avoidable resource contention (not
a test matrix), and it has been the root cause of four consecutive CI
failures of `serve::tests::periodic::periodic_event_is_dispatched_to_pi_agent_with_payload_as_prompt`
(`the-intern/service/crates/bob/src/serve.rs`) across bugs B-025 and B-026,
neither of which resolved it because both treated it as a test-code timing
problem rather than a CI-workflow-topology problem. Confirmed directly: for
the run pair where this last failed, the `push`-triggered run (created
`2026-07-17T20:06:03Z`) succeeded, while the `pull_request`-triggered run for
the *same commit* (created `2026-07-17T20:06:05Z`, two seconds later) is the
one whose `Tests` job failed — consistent across all four observed failures,
always the later-starting/contending job, never the first.

## Reproduction Status

Status: confirmed — directly verified via `gh run view --json event,createdAt,conclusion`
on the paired runs for the same commit.

## Evidence

- `.github/workflows/build.yml:3-8`:
  ```yaml
  on:
    pull_request:
    push:
      branches:
        - dev-agent
        - main
  ```
  No `concurrency` block anywhere in the file — nothing prevents two
  workflow runs for the same commit from executing simultaneously.
- `gh run view 29609969929 --repo aurora-firmware/the-intern --json event,createdAt,conclusion`
  → `{"conclusion":"success","createdAt":"2026-07-17T20:06:03Z","event":"push"}`
- `gh run view 29609973101 --repo aurora-firmware/the-intern --json event,createdAt,conclusion`
  → `{"conclusion":"failure","createdAt":"2026-07-17T20:06:05Z","event":"pull_request"}`
  Both runs are for the identical commit (`dev-agent` at that push); the
  `pull_request` run's `Tests` job failed with the same panic documented in
  B-025/B-026 (`idle reaper must eventually release the one-shot session:
  Elapsed(())`, `test result: FAILED. ... finished in 20.11s` — the entire
  widened timeout consumed).
- The same pairing pattern (one `Tests` job of two passes cleanly in well
  under a minute; the other fails after consuming its entire timeout) was
  observed identically in the three earlier CI failures documented in
  B-025's and B-026's bug files, across three different test configurations
  (5s/`current_thread`, 20s/`multi_thread`, 20s/`current_thread`) — the one
  constant across every failure is the duplicate-trigger topology, not any
  property of the test itself.
- B-025 and B-026 both independently confirmed (via extensive local
  contention simulation, including `taskset`-forced CPU oversubscription in
  B-026) that ordinary preemptive scheduling delay does not reproduce this
  failure locally — consistent with the actual mechanism being resource
  contention specific to two full concurrent `cargo test --workspace`
  invocations sharing the same constrained self-hosted runner capacity,
  which is what the duplicate trigger produces on every affected commit.

## Reproduction Steps

1. Push a commit to `dev-agent` while a PR from `dev-agent` to `main` is
   open (e.g. PR #38).
2. Observe via `gh pr checks <N>` or the Actions tab that two separate
   workflow runs start for the same commit within a few seconds of each
   other — one tagged `push`, one tagged `pull_request`.
3. Observe that the `Tests` job on one of the two runs (usually, per
   observed evidence, the `pull_request`-triggered one) intermittently fails
   on `periodic_event_is_dispatched_to_pi_agent_with_payload_as_prompt` with
   an idle-reaper timeout, while the other passes cleanly and quickly.

## Expected Behavior

A single commit should not cause two full, redundant `cargo test --workspace`
invocations to compete for the same finite self-hosted runner capacity. Per
standard GitHub Actions practice, a `concurrency` group (or equivalent) should
ensure at most one meaningful CI run per commit/ref is actually executing,
cancelling or superseding the redundant one rather than letting both run and
contend.

## Actual Behavior

Every commit to `dev-agent` while a promotion PR is open triggers two
concurrent full-workspace test runs, and the resulting resource contention
has caused `periodic_event_is_dispatched_to_pi_agent_with_payload_as_prompt`
to fail on 4 out of 4 opportunities so far (across three different
timeout/runtime-flavor configurations attempted in B-025 and B-026), each
time consuming its entire timeout budget with no partial progress.

## Environment

- OS / platform: Linux (self-hosted GitHub Actions runner, container image
  `localhost:5000/rust-dev:1.0.1`).
- CI config: `.github/workflows/build.yml`, `on: pull_request` +
  `on: push: branches: [dev-agent, main]`, no `concurrency` block.
- Branch / commit: `dev-agent` at `1e1eb3a` (after B-026 merged) — failure
  observed on the immediately following push, in the `pull_request`-event
  run paired with a successful `push`-event run for the same commit.

## Related

- Bug: `B-025` (first fix attempt — widened timeout + `multi_thread`; did
  not resolve the issue because it treated this as a test-timing problem).
- Bug: `B-026` (second fix attempt — reverted to `current_thread`; also did
  not resolve the issue, and its own Diagnosis Log explicitly anticipated
  this outcome, stating the next investigation should "pursue
  infrastructure-level evidence outside this repository's visibility" if
  the revert didn't work — this bug is that next investigation, and the
  evidence turned out to be inside the repository after all: the workflow's
  own trigger configuration).
- PR: `#38` (`Promote dev-agent → main: scheduler JSON-state persistence,
  reliability fixes, per-entry cwd resolution`) — still blocks fully green
  CI on this PR; every push while it's open pays the double-run cost.

## Suspected Area

`.github/workflows/build.yml` — missing a `concurrency` group to prevent
duplicate `push`/`pull_request` runs for the same commit from executing
simultaneously. Not `the-intern/service/crates/bob/src/serve.rs` or
`crates/pi-agent-supervisor/` — both were audited in depth by B-025 and
B-026 and found deterministic and bounded; the recurring failure is fully
explained by CI-runner contention from the duplicate trigger, independent of
any property of the test or the code it exercises.

## Fix Verification

```bash
# Structural: confirm only one Tests job runs (or the redundant one is
# cleanly cancelled/skipped) for a single commit to dev-agent while PR #38
# is open:
gh pr checks 38 --repo aurora-firmware/the-intern
gh run list --repo aurora-firmware/the-intern --branch dev-agent --limit 4

# Behavioral: after the fix, push a commit and confirm no resource-contention
# related failure recurs across at least two consecutive pushes:
cd the-intern/service && cargo test --workspace
```

## Diagnosis Log

## Work Log

## Review
