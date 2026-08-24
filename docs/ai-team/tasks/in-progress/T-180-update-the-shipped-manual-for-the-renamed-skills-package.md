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
