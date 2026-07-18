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

### Review Verdict — 2026-07-18

PASS

**Diagnosis→fix evidence chain (verified before Stage 1/2):** Complete. The Diagnosis Log
contains reproduction status, independently re-verified evidence (`gh run list`/`gh run view`
across all 4 recent `dev-agent` commits, job-level timing showing serialized back-to-back
execution on the single `auroralab` runner, and confirmation PR #38 is the only open PR), an
isolated fault (`build.yml`'s missing `concurrency` block, explicitly not `serve.rs` or
`pi-agent-supervisor`, both already cleared by B-025/B-026), a planned fix (exact YAML block,
with reasoning for group-key semantics and a rejected alternative), and planned verification
(structural/behavioral/cross-branch-safety/local-sanity). This is a materially stronger evidence
chain than B-025/B-026, which is the correct outcome given this bug exists specifically because
those two treated the symptom rather than the CI-topology cause.

**Stage 1 — Bug criteria:**
- Diagnosis Log reproduction status and evidence: present and independently re-verified (4/4
  push+pull_request pairs for the same SHA, consistent failure pattern on the later-queued run).
- Fix addresses the isolated fault: yes — `git diff dev-agent..bug/B-027-ci-duplicate-trigger-contention -- .github/workflows/build.yml`
  shows exactly the planned `concurrency` block (4 lines), placed immediately after `on:` and
  before `permissions:`, matching the fix contract with no deviation (confirmed by the Work Log
  and independently by re-reading the file).
- Fix Verification steps followed: the local/structural-sanity portion (`cargo test --workspace`)
  was run and passed; the structural/behavioral/cross-branch-safety portions require live GitHub
  Actions observation on the next push and are explicitly and honestly flagged as outstanding in
  the Work Log, consistent with the equivalent caveat this repo's process already accepted for
  B-025/B-026's CI-only verification steps.
- No unrelated behavior added: confirmed — `git diff <merge-base>..bug/B-027-ci-duplicate-trigger-contention --stat`
  shows only `.github/workflows/build.yml | 4 ++++`, nothing else. The apparent 111-line diff
  against the bug file itself (visible when diffing directly against `dev-agent`) is an artifact
  of the Diagnosis/Work Log entries being committed on `dev-agent` per the repo's git model, not a
  change made on the bug branch — the bug branch touches no lifecycle files, confirmed via
  merge-base diff.

**Stage 2 — Code quality:**
- Correctness: parsed the modified `build.yml` with `python3`/`PyYAML` directly —
  `concurrency` is a proper top-level sibling key of `name`/`on`/`permissions`/`env`/`jobs` (not
  nested under `on:`), appears exactly once, and is syntactically valid. Group-key logic verified
  against actual GitHub Actions context semantics: `github.head_ref` is populated only on
  `pull_request` events (source branch name) and `github.ref_name` only on `push` events (short
  ref name); for PR #38 (`dev-agent` -> `main`), both resolve to `dev-agent`, so the push and
  pull_request runs for the same commit collapse into group `CI-dev-agent` as intended. `main`
  pushes resolve to `CI-main`, a distinct group — confirmed no cross-branch collision.
- Group-key scrutiny requested in the review brief: (1) the group key is per-branch, not
  per-commit, so a newer push on `dev-agent` legitimately cancels an in-progress run for an
  *older* commit on the same branch — this is standard, desired GitHub Actions behavior (stale CI
  for a superseded commit is expected to be superseded), separate from and additive to the
  push/pull_request-duplicate fix this bug targets; it does not conflate two "genuinely
  unrelated" commits incorrectly, it correctly treats a later commit on the same branch as
  superseding an earlier one. (2) `cancel-in-progress: true` cancelling a run mid-flight while
  GitHub evaluates PR mergeability is a real, transient GitHub Actions characteristic — but it
  self-resolves once the surviving (newer) run in the same group completes and reports the same
  job name (`Tests`) for the same head SHA; it is not unique to this fix and is the standard,
  widely-used idiom for exactly this push+pull_request-duplication problem (GitHub's own
  documented pattern for it). The Diagnosis Log explicitly reasoned about this and about the
  rejected alternative (dropping the `pull_request` trigger), correctly identifying the chosen
  approach as lower-risk and reversible.
- `deploy.yml`: read in full — `name: Release`, `on: push: tags: ['*']` only, no `concurrency`
  key (untouched by this diff, correctly out of scope), distinct workflow name from `CI` and a
  disjoint trigger surface (tag refs never coincide with `dev-agent`/`main` branch names even if
  it had inherited a similarly-templated group key). No collision risk, confirmed directly rather
  than assumed.
- Branch protection / required-check-name concern: `tests` job's `name: Tests` is identical
  regardless of triggering event (`push` or `pull_request`), so a required check keyed to
  "Tests" for the head SHA is satisfied by whichever run in the group actually completes with a
  success conclusion — this is the standard, well-established GitHub Actions pattern for
  collapsing duplicate push/PR triggers and is why it's documented as GitHub's own recommended
  idiom for this scenario, not a novel or risky construction. This cannot be proven from a local
  sandbox; the bug's own Fix Verification section already accounts for this by requiring
  observation of PR #38's checks on the next live push, which is the correct place to close the
  loop, not this review.
- Tests: no source code changed (confirmed via merge-base diff); `cargo test --workspace` was
  run locally by the Developer and passed, which is the right and sufficient sanity check for a
  CI-config-only change — not re-run in this review since the diff contains no source deltas to
  re-verify.
- Readability / minimalism: 4-line, additive, easily-reversible change; no dead code, no
  unrelated refactoring, no lifecycle files touched on the bug branch.
- Bug Fix Addendum — regression test: no automated regression test is possible for this class of
  fault (GitHub Actions dual-trigger timing on a self-hosted runner cannot be exercised from this
  repo's local test suite); the Diagnosis Log's structural/behavioral/cross-branch-safety Planned
  Verification substitutes for it, consistent with the precedent already accepted for B-025/B-026
  and with this review's explicit instruction to judge on reasoning/safety/minimalism rather than
  unobtainable local proof.

**Escalation consideration:** The review brief flagged this as a plausible ESCALATE candidate
given repo-wide CI blast radius. Weighed against that: the fix is a single well-established,
additive, and trivially reversible GitHub Actions idiom, squarely within the bug's own stated
Suspected Area (`build.yml`'s trigger configuration), backed by a diagnosis that already
considered and rejected a materially riskier alternative (dropping the `pull_request` trigger).
It does not touch `deploy.yml`, application source, or any GitHub-side branch-protection
configuration (which lives outside this repo and this diff regardless). This does not meet the
bar for ESCALATE (no internally contradictory spec, no criterion unmeetable without a spec
change, no root cause outside the bug's own scope) — it is a normal, well-reasoned, minimal,
in-scope bug fix, so PASS stands rather than a process escalation.

**Non-blocking observations:**
- Real confirmation still depends on observing live GitHub Actions runs on the next push while
  PR #38 is open, exactly as the bug's own Fix Verification section and Work Log already state.
- Pre-existing, unrelated working-tree entries (`pr-35-review.md`/`pr-38-review.md`) were left
  untouched by this review, consistent with the Developer's own note.

Next owner: Bug-Fix Loop.
