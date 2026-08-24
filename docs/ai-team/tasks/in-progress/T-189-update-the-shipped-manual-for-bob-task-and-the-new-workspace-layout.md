---
id: T-189
title: Update the shipped manual for bob task and the new workspace layout
status: in-progress
priority: medium
assigned-role: developer
created: '2026-08-23'
spec: S-014
---

# Update the shipped manual for bob task and the new workspace layout

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

The shipped manual's quickstart and operator guide both enumerate what `bob init`
creates and which skills it installs; both gain the board directory and the
fourth skill.

The operator guide additionally warrants a short section on the board itself,
because `bob task` is the first bob surface an operator meets that works with the
service stopped — every other subcommand except `init` fails without
`admin.sock`, and an operator who has learned that pattern will not expect this
one to behave differently.

The operator guide is also where S-011 placed the action-rule guidance for the
worklog's writes and for reference reads at the install path, so it is where
S-014's equivalent belongs: which rules admit the calls the shipped board skill
makes, and that absent rules deny. A fresh install works without this because the
generated first-run profile permits `bash` with no matchers, but an operator
narrowing that profile will silently disable the skill without it.

The CLI reference is derived from `--help` at build time, so `bob task`
documents itself there and needs no hand-written page. Do not add one.

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

AC-1: The system shall describe the workspace `bob init` produces as including
the board directory and the fourth installed skill, in both the quickstart and
the operator guide.
AC-2: The system shall state in the operator guide that `bob task` works while
the service is stopped.
AC-3: WHEN the manual is built THE SYSTEM SHALL generate the `bob task` reference
pages from the binary with no hand-written reference page added.
AC-4: The system shall tell the operator which action rules admit the calls the
shipped board skill makes, and that absent rules deny, alongside the equivalent
guidance already given for the worklog.

## Dependencies

- `T-180` — touches the same two manual pages for the package rename.
- `T-187` — the documented workspace layout must be final.

## Files to Touch

- `the-intern/docs/src/quickstart/index.md` — the workspace layout and installed skill set.
- `the-intern/docs/src/operator-guide/index.md` — the same, plus a short section on the board.

## Verification

```bash
(cd the-intern/docs && mdbook build)
grep -q "bob task" the-intern/docs/src/operator-guide/index.md
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
