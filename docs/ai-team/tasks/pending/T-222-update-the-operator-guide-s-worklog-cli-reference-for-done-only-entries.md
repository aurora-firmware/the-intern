---
id: T-222
title: Update the operator guide's worklog CLI reference for Done-only entries
status: pending
priority: medium
assigned-role: developer
created: '2026-09-21'
---

# Update the operator guide's worklog CLI reference for Done-only entries

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

`the-intern/docs/src/operator-guide/index.md`'s worklog action-rule
passage (the `bob worklog*` matcher's stability explanation) enumerates
the command's flags in free text as `--item`/`--done`/`--left`/`--next` —
`T-215` narrows the CLI to `--item`/`--done` only. Rewrite that
enumeration to the two-flag shape. Nothing else in this file documents
worklog entry output or the duplicate-suppression comparison, so no other
passage needs to change; the action-rule matcher shape itself
(prefix-anchored on `bob worklog append`/`bob worklog list`) is unaffected.

## Acceptance Criteria

AC-1: The system shall not state that a `bob worklog append` call carries
a `--left` or `--next` value anywhere in the file.

AC-2: WHERE the worklog action-rule matcher's stability rationale is
described THE SYSTEM SHALL attribute it to the `--item`/`--done` values
only.

## Dependencies

- `T-215` — documents the CLI's actual final flag/output shape

## Files to Touch

- `the-intern/docs/src/operator-guide/index.md`

## Verification

```bash
grep -n "\-\-left\|\-\-next\|Left:\|Next:" the-intern/docs/src/operator-guide/index.md
# expect no output
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
