---
id: T-001
title: 'Scaffold GitHub Actions CI: build, test, deploy'
status: pending
priority: medium
assigned-role: unassigned
created: '2026-05-15'
---

# Scaffold GitHub Actions CI: build, test, deploy

## Description

The repository has no CI today. There is also no application source code yet
(see `CLAUDE.md`: design phase on branch `pi-agent-design`). The goal of this
task is to land three GitHub Actions workflow skeletons so that PRs surface
checks immediately and the deploy entry point exists for later tag-driven
releases.

Workflow contents are intentionally trivial — each job runs a single shell
step that prints an identifying message (e.g. `echo "build placeholder"`).
Real Rust / Node build and test logic is added in later tasks, once the
service skeleton exists.

Triggers:
- `build.yml` — on `pull_request` and on `push` to `dev-agent` and `main`.
- `test.yml` — on `pull_request` and on `push` to `dev-agent` and `main`.
- `deploy.yml` — on `push` of tags matching `v*` only.

Out of scope (explicit): no secrets / OIDC / env wiring, no coverage gates or
quality thresholds, no Docker image build or push, no release-tagging,
changelog, or semantic-release automation, and no real toolchain matrices
(use a single placeholder runner — matrices come when code exists).

## Acceptance Criteria

AC-1: The system shall provide `.github/workflows/build.yml`, `.github/workflows/test.yml`, and `.github/workflows/deploy.yml`.
AC-2: WHEN a pull request is opened against any branch THE SYSTEM SHALL run the `build` and `test` workflows and surface them as PR checks.
AC-3: WHEN a tag matching `v*` is pushed THE SYSTEM SHALL run the `deploy` workflow, and IF the trigger is anything other than a `v*` tag push THEN THE SYSTEM SHALL NOT run `deploy`.
AC-4: Each workflow shall contain at least one job whose only step prints an identifying placeholder message and exits 0.
AC-5: The system shall NOT reference any GitHub secret, container registry, coverage tool, or release-automation action in these workflows.

## Dependencies

- None

## Files to Touch

- `.github/workflows/build.yml` — new file; PR + push(dev-agent, main) trigger, single echo step
- `.github/workflows/test.yml` — new file; PR + push(dev-agent, main) trigger, single echo step
- `.github/workflows/deploy.yml` — new file; tag `v*` push trigger only, single echo step

## Verification

```bash
# Files exist and parse as YAML
test -f .github/workflows/build.yml && test -f .github/workflows/test.yml && test -f .github/workflows/deploy.yml
python3 -c "import yaml,sys; [yaml.safe_load(open(p)) for p in sys.argv[1:]]" \
  .github/workflows/build.yml .github/workflows/test.yml .github/workflows/deploy.yml

# Triggers are correct
grep -q "pull_request" .github/workflows/build.yml
grep -q "pull_request" .github/workflows/test.yml
grep -E "tags:\s*$|v\*" .github/workflows/deploy.yml

# Forbidden content is absent
! grep -RinE "secrets\.|docker/build-push|codecov|semantic-release|changelog" .github/workflows/
```

After merge to a feature branch, open a PR against `dev-agent` and confirm
both `build` and `test` checks appear; push a throwaway `v0.0.0-ci-test` tag
to confirm `deploy` runs (and delete the tag afterwards).

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

### Session 1 — 2026-05-15

Picked up T-001 on branch `task/T-001-scaffold-github-actions-ci`. The Work Log was empty (first session).

**What was done.**
Created `.github/workflows/` directory and three YAML workflow skeleton files — `build.yml`, `test.yml`, and `deploy.yml` — along with a shell-based test suite at `tests/test_workflows.sh`. Followed the red-green-refactor TDD cycle: wrote the test suite first (confirmed 11 failures), then implemented the three workflow files (all 13 tests pass). Both phases committed separately on the task branch.

**Workflow details:**
- `build.yml` and `test.yml` trigger on `pull_request` (any branch) and on `push` to `dev-agent` or `main`. Each has a single job with `echo "build placeholder"` / `echo "test placeholder"`.
- `deploy.yml` triggers only on `push` of tags matching `v*`. It has no branch-push trigger and no `pull_request` trigger. Single job with `echo "deploy placeholder"`.

**Decisions made.**
- Used `ubuntu-latest` as the runner for all three jobs. The task says "single placeholder runner — matrices come when code exists," so no matrix was added.
- No `workflow_dispatch` or other triggers added; the task description is precise about triggers.
- No `on: true` YAML boolean alias used — the `on:` key is kept as a plain string to avoid the common YAML-boolean footgun with `on`.

**What was tried and rejected.**
- Considered adding `workflow_dispatch` to all workflows for easy manual testing. Rejected: the task explicitly constrains triggers and the task says to stay minimal.

**What remains.**
- Manual smoke test: open a PR against `dev-agent` to confirm `build` and `test` checks appear; push a `v0.0.0-ci-test` tag to confirm `deploy` runs (and delete the tag). This requires an actual GitHub remote and is noted in the task's Verification section as a post-merge step.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->
