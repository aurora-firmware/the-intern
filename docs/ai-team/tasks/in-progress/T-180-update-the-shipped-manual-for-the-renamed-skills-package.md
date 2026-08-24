---
id: T-180
title: Update the shipped manual for the renamed skills package
status: in-progress
priority: medium
assigned-role: developer
created: '2026-08-23'
spec: S-014
---

# Update the shipped manual for the renamed skills package

<!--
Task Quality Rules (see the new-task skill for full details):
  - Atomic — one clear outcome.
  - One-shottable — ≤ 3–4 files touched, ≤ 5 ACs, Description ≈ 20 lines.
  - Verifiable — concrete Verification command or explicit manual steps.
  - Self-contained — Description is enough to start without follow-up questions.
  - EARS — every AC matches one of the five EARS patterns below.
  - Dependency-honest — list every prior task this one reads from or modifies.
-->

## Description

The shipped mdBook manual names the skills package directory in prose and in a
copy-pasteable command, so a stale path fails in a reader's shell rather than in
CI. The operator guide names it when explaining skill installation and again in a
`SKILL_PACKAGE_SRC=` assignment the reader is expected to paste; a shell test
under `the-intern/docs/` asserts a documented `cp -r` command containing the
path.

Both the quickstart and the operator guide separately use `email-skills` as the
name of an example *workspace* directory. That is unrelated to the package path,
but leaving it standing beside a renamed package invites a reader to conflate the
two, so rename those examples in the same pass.

The manual's CLI reference is derived from `--help` at build time and needs no
edit here.

## Acceptance Criteria

<!-- EARS pattern reference. Every criterion must match one pattern:
  1. Ubiquitous            — The system shall [outcome]
  2. Event-driven          — WHEN [trigger] THE SYSTEM SHALL [outcome]
  3. Unwanted-behaviour    — IF [fault] THEN THE SYSTEM SHALL [outcome]
  4. State-driven          — WHILE [state] THE SYSTEM SHALL [outcome]
  5. Optional              — WHERE [feature included] THE SYSTEM SHALL [outcome]

Examples:
  AC-1: WHEN the user submits valid credentials THE SYSTEM SHALL
        redirect to /dashboard within 200ms.
  AC-2: IF the password is incorrect THEN THE SYSTEM SHALL return 401
        and display "Invalid credentials".
  AC-3: The system shall log every authentication attempt with user id
        and outcome.
-->

AC-1: The system shall name the runtime skills package as
`the-intern/bob-skills` everywhere the shipped manual refers to it.
AC-2: WHEN the operator-guide trust test is run THE SYSTEM SHALL pass against the
documented command carrying the new path.
AC-3: The system shall use an example workspace name that cannot be mistaken for
the package directory.
AC-4: WHEN the manual is built THE SYSTEM SHALL produce the book without error.

## Dependencies

- `T-179` — the package must already live at its new path.

## Files to Touch

- `the-intern/docs/src/operator-guide/index.md` — package path in prose, in the paste-and-run assignment, and the example workspace name.
- `the-intern/docs/src/quickstart/index.md` — the example workspace name.
- `the-intern/docs/test_operator_guide_email_triage_trust.sh` — the asserted documented command.

## Verification

```bash
./the-intern/docs/test_operator_guide_email_triage_trust.sh
! grep -rn "email-skills" the-intern/docs/src/
(cd the-intern/docs && mdbook build)
```

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

### Session 1 — 2026-08-24

Confirmed all three Verification commands failed against the current (stale) content before making any change: `! grep -rn "email-skills" the-intern/docs/src/` failed because six literal `email-skills` references remained, and `./the-intern/docs/test_operator_guide_email_triage_trust.sh` exited 1 — not because of the rename, but because two of its `first_matching_line` anchor patterns (`"Deploy an owner-only working directory"` and `"Add the S-004 action rules"`) no longer matched the current operator-guide headings (`"Bootstrap the owner-only workspace with `bob init`."` and `"Replace the bootstrap-wide action rules..."`); under `set -euo pipefail` an empty `grep` match inside a `$(...)` assignment aborted the script before it could reach its pass/fail summary. That mismatch was introduced by an earlier, unrelated doc-wording commit (`54419cd`, "docs(bob): document init bootstrap workflow", 2026-08-13) and predates this task; since the file was already in this task's "Files to Touch" list and AC-2 requires the test to pass, I fixed both anchors in the same edit rather than filing a separate bug, and noted it here for visibility. `mdbook build` already passed at baseline, so it served as a regression guard rather than a red test.

Cycle 1 (commit `92baac4`): updated `the-intern/docs/test_operator_guide_email_triage_trust.sh` — repaired the two stale anchor patterns and renamed the "asserted documented command" absence-check from `cp -r the-intern/email-skills/.` to `cp -r the-intern/bob-skills/.` (Files to Touch item 3). Verified the script now runs to completion and passes (9/9).

Cycle 2 (commit `6f25781`): renamed all six `email-skills` references in `the-intern/docs/src/operator-guide/index.md` and `the-intern/docs/src/quickstart/index.md`. Two categories: (a) the package path in prose and in the `SKILL_PACKAGE_SRC=` assignment, renamed to `the-intern/bob-skills/...` per AC-1; (b) the example *workspace* directory name (`bob init /srv/workspaces/email-skills`, `WORKSPACE=/srv/workspaces/email-skills`, `WORKSPACE="$HOME/workspaces/email-skills"`), renamed to `email-triage` per AC-3 — chosen because it already matches the job name and `config/email-triage.toml` used throughout the same examples, and is unambiguously distinct from the `bob-skills` package directory.

Re-ran all three Verification commands together after both cycles: the trust test passes (9/9), the repo-wide `email-skills` grep finds nothing under `the-intern/docs/src/`, and `mdbook build` completes without error. `git diff dev-agent...HEAD --stat` confirms only the three files named in "Files to Touch" were modified. Nothing remains for this task.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->

### Review Verdict — 2026-08-24

PASS

**Stage 1 — Acceptance Criteria** (checked against `dev-agent...task/T-180-update-the-shipped-manual-for-the-renamed-skills-package`, commits `92baac4`, `6f25781`):

- AC-1 (package named `the-intern/bob-skills` everywhere): met. Both prose references and the `SKILL_PACKAGE_SRC=` assignment in `operator-guide/index.md` were renamed; confirmed `! grep -rn "email-skills" the-intern/docs/src/` exits 0 on the branch (repo-wide, not just the two edited files).
- AC-2 (trust test passes against the documented command carrying the new path): met. Ran `the-intern/docs/test_operator_guide_email_triage_trust.sh` on the branch — 9/9 checks pass, exit 0.
- AC-3 (example workspace name that cannot be mistaken for the package directory): met. `email-skills` (workspace) renamed to `email-triage` in `operator-guide/index.md` (two spots) and `quickstart/index.md`, unambiguously distinct from the `bob-skills` package directory and consistent with the existing `config/email-triage.toml` naming used throughout the same examples.
- AC-4 (manual builds without error): met. Ran `mdbook build` (with `BOB_BIN` pointed at a locally built debug binary, required for the `cli-reference` preprocessor) on the branch — completes with exit 0, only a pre-existing, unrelated mermaid-preprocessor version warning.
- No unspecified behavior added; `git diff dev-agent...HEAD --stat` shows only the three files listed under "Files to Touch" were touched, matching the Work Log's claim.

**Verification of the Work Log's stale-anchor claim** (specifically checked, not accepted on faith):

- `git show 54419cd -- the-intern/docs/src/operator-guide/index.md` confirms that commit (2026-08-13, "docs(bob): document init bootstrap workflow") retitled the exact two headings the test anchors depended on: "Deploy an owner-only working directory for the job's mutable state." → "Bootstrap the owner-only workspace with `bob init`.", and "Add the S-004 action rules scoped to the skill install path, then reload policy." → "Replace the bootstrap-wide action rules with the S-004 rules scoped to the skill install path, then reload policy." That commit is unrelated to the skills-package rename.
- `git merge-base --is-ancestor 54419cd task/T-180-...` and, more precisely, `git merge-base --is-ancestor 54419cd 2ad1269` (the branch's actual fork point from `dev-agent`) both succeed — `54419cd` was already on `dev-agent` before T-180 branched.
- Checked out the branch's fork point (`2ad1269`) in a separate worktree and ran `the-intern/docs/test_operator_guide_email_triage_trust.sh` there directly (no Developer commits applied): it exits 1, aborting after 7 of 9 checks — exactly the `set -euo pipefail` abort-on-empty-`first_matching_line` failure mode the Work Log describes. This confirms the breakage predates the Developer's work and was not introduced by an over-eager rename edit.

**Scope call — fixing the anchors inline vs. filing a separate bug**: reasonable. `the-intern/docs/test_operator_guide_email_triage_trust.sh` was already an explicit item in this task's "Files to Touch" list, and AC-2 requires that exact test to pass — the fix was not incidental, it was necessary to satisfy a stated acceptance criterion on a file already in scope. Per the Developer agent's own Decision Authority ("Minor refactoring within files the task owns, only if needed to implement the feature") and the `new-bug` skill's charter (reporting defects "discovered outside the current task's scope"), this defect was squarely inside scope, not outside it, so `new-bug` did not apply. The fix itself is minimal (two literal string replacements) and was committed separately (`92baac4`, type `fix`) from the rename commit (`6f25781`, type `docs`), keeping the two concerns cleanly separated for review.

**Stage 2 — Code Quality**: diff is minimal and precisely scoped (3 files, 9 insertions/9 deletions total); no dead code, no unrelated refactor bundled in; test-script anchor names remain descriptive; commit messages conform to `git-conventions` (`fix(docs): repair stale anchors and rename cp -r path in trust test`, `docs(operator-guide): rename skills package path to bob-skills`, both ≤72 chars, imperative, no period). No source/Rust files touched, so `cargo fmt`/`clippy` are not implicated.

Both stages pass. No blocking issues found.
