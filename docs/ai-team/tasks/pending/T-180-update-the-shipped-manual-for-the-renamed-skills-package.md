---
id: T-180
title: Update the shipped manual for the renamed skills package
status: pending
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

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->
