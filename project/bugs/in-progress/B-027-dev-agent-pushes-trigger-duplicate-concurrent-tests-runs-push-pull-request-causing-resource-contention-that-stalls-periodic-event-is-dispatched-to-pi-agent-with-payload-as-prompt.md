---
id: B-027
title: dev-agent pushes trigger duplicate concurrent Tests runs (push + 
  pull_request), causing resource contention that stalls 
  periodic_event_is_dispatched_to_pi_agent_with_payload_as_prompt
severity: high
status: in-progress
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

### Diagnosis 1 — 2026-07-18

Reproduction status: confirmed, deterministic pattern (not intermittent as a CI-topology fact,
though its downstream test-failure symptom is probabilistic). Independently re-verified beyond the
bug report's single cited pair.

Evidence captured:
- `.github/workflows/build.yml:3-8` read directly: `on: pull_request:` (no filters) +
  `on: push: branches: [dev-agent, main]`; no `concurrency:` key anywhere in the file (231 lines,
  full read).
- `.github/workflows/deploy.yml` read directly: `on: push: tags: ['*']` only, `name: Release`, no
  `concurrency:` key. No overlap risk with build.yml.
- `gh run list --repo aurora-firmware/the-intern --branch dev-agent --limit 15 --json
  databaseId,event,createdAt,conclusion,headSha,status`: every one of the 4 most recent commits to
  `dev-agent` (`1e1eb3a`, `47a539e`, `cec22e7`, `10c4f13`) produced exactly two runs, `push` then
  `pull_request` created 2-3s apart, identical `headSha` each time.
- `gh run view <id> --json event,createdAt,conclusion,jobs` on all 8 of those runs: in all 4 pairs
  the `push` run's `Tests` job succeeded and the `pull_request` run's `Tests` job failed with the
  identical panic in all 4 failing runs. 4/4 consistency, matching the bug report's claim.
- `gh api repos/aurora-firmware/the-intern/actions/runs/<id>/jobs`: all jobs across all 4 pairs ran
  on a single runner (`runner_name: auroralab`), with job start/end timestamps showing the two runs'
  jobs execute strictly serially (zero wall-clock overlap) — e.g. push run's 5 jobs span
  20:06:03-20:08:59, pull_request run's 5 jobs span 20:09:01-20:12:08 for the same commit,
  back-to-back with no gap. This refines (not contradicts) the bug report: the mechanism is
  queuing/serialization on a single-capacity self-hosted runner producing a redundant, delayed,
  back-to-back-queued `Tests` execution — not literal simultaneous CPU contention between two
  concurrently-running `cargo test` processes.
- `gh pr view 38 --json number,baseRefName,headRefName,state,title` / `gh pr list --state open`:
  confirms PR #38 is `dev-agent` -> `main`, OPEN, the only open PR — matches the promotion-PR
  pattern in CLAUDE.md's git model, confirming every `dev-agent` push during this PR's lifetime pays
  the double-run cost.

Isolated fault: `.github/workflows/build.yml` trigger configuration (`on: pull_request` +
`on: push: branches: [dev-agent, main]`, no `concurrency` block) — not `serve.rs` or
`pi-agent-supervisor`, both already audited by B-025/B-026. Every commit landing on `dev-agent`
while a `dev-agent`->`main` promotion PR is open produces two independent workflow runs for the
identical SHA; because the repo has a single self-hosted runner (`auroralab`, confirmed via
job-level `runner_name`), the second (redundant) run's 5 jobs queue fully behind the first run's 5
jobs, and the delayed, back-to-back-queued `Tests` job execution has coincided with the periodic
dispatcher's idle-reaper timeout on 4/4 observed opportunities across B-025/B-026.

Planned fix: add a workflow-level `concurrency` block to `.github/workflows/build.yml`:

```yaml
concurrency:
  group: ${{ github.workflow }}-${{ github.head_ref || github.ref_name }}
  cancel-in-progress: true
```

`github.head_ref` (pull_request events only) and `github.ref_name` (push events) both resolve to
the plain branch name (`dev-agent`), so the push and pull_request runs for the same branch/commit
collapse into one concurrency group and the older (redundant) run is cancelled, leaving exactly one
completed run per commit. `main` pushes and `dev-agent` pushes resolve to distinct groups
(`CI-main` vs `CI-dev-agent`), so unrelated branches never cancel each other. `cancel-in-progress:
true` is safe: the cancelled run is for an identical SHA (zero information loss), `podman run --rm`
cleans up terminated containers, and branch-protection required checks match by job name against
the SHA regardless of which run's event type posts them. Rejected alternative: restricting/dropping
the `pull_request` trigger and relying on push-triggered checks appearing on the PR — larger blast
radius (changes trigger semantics repo-wide) and its interaction with `main`'s branch-protection
configuration was not verified, so it carries unquantified risk versus the additive, easily-
reversible `concurrency` block. `deploy.yml` confirmed to share no group risk: separate workflow
(`github.workflow` = `Release`, not `CI`), tag-only trigger, currently no `concurrency` block, tag
ref names never coincide with `dev-agent`/`main`.

Planned verification:
- Structural: after the fix lands, push a commit to `dev-agent` while PR #38 is still open;
  `gh run list --repo aurora-firmware/the-intern --branch dev-agent --limit 4` should show one
  `cancelled` run and one `completed` run per commit (not two full completed runs).
- Behavioral: confirm no further contention-linked failures of
  `periodic_event_is_dispatched_to_pi_agent_with_payload_as_prompt` across at least 2-3 consecutive
  pushes to `dev-agent` while PR #38 remains open.
- Cross-branch safety: on the next `main` push occurring close in time to any `dev-agent` push,
  confirm via `gh run list --branch main` / `--branch dev-agent` that neither run was cancelled by
  the other (distinct `CI-main` / `CI-dev-agent` groups).
- `cd the-intern/service && cargo test --workspace` locally as a sanity check that no source change
  is needed/introduced (this is a CI-config-only fix).

## Work Log

### Session 1 — 2026-07-18

Implemented the fix contract recorded in the Diagnosis Log without further diagnosis (it was
already complete). Added a workflow-level `concurrency` block (`group: ${{ github.workflow }}-${{
github.head_ref || github.ref_name }}`, `cancel-in-progress: true`) to
`.github/workflows/build.yml`, placed immediately after the `on:` block and before `permissions:`
— the same location and content specified in the fix contract, no deviation. This is a
CI-config-only change; no source files were touched.

Verified locally: (1) parsed the modified YAML with `python3 -c "import yaml;
yaml.safe_load(...)"`, confirming `concurrency` sits as a proper top-level key alongside
`on`/`permissions`/`env`/`jobs` rather than accidentally nesting under `on:`; (2) full manual
re-read of the 235-line file confirming no duplication and correct indentation; (3)
`cd the-intern/service && cargo test --workspace` passed cleanly (all suites `ok`, `0 failed`),
confirming no source-level regression, as expected for a CI-config-only change.

Committed as `fix(ci): add concurrency group to collapse duplicate CI runs` (commit `4df9c36`) on
`bug/B-027-ci-duplicate-trigger-contention`. Deliberately staged only `.github/workflows/build.yml`
— pre-existing unrelated dirty-tree entries (`pr-35-review.md`/`pr-38-review.md`) predate this
session and were left untouched.

What remains, and what cannot be done from this session: the structural, behavioral, and
cross-branch-safety verification steps in the Diagnosis Log's Planned Verification all require
observing real GitHub Actions runs (one `cancelled` + one `completed` run per commit via
`gh run list`, absence of further contention-linked failures across 2-3 consecutive `dev-agent`
pushes, and confirmation that `main` and `dev-agent` pushes never cancel each other). None of this
is observable from a local sandbox — real confirmation can only happen on the next actual pushes to
`dev-agent` in the live GitHub Actions environment, the same honesty caveat B-025 and B-026 recorded
for their own CI-only verification steps.

**Obstacles Encountered:** None blocking. Pre-existing, unrelated working-tree state
(`pr-35-review.md`/`pr-38-review.md`) left untouched. This fix's real confirmation cannot be
verified locally, only on the next live CI runs.

## Review
