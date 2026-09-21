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

`the-intern/docs/src/operator-guide/index.md` documents `bob worklog
append`'s four-flag (`--item`/`--done`/`--left`/`--next`) shape and its
`Done`/`Left`/`Next` output — `T-215` narrows the CLI to `--item`/`--done`
only. Rewrite the section to match: two required flags, a single `Done`
value in output, and same-day duplicate suppression comparing `Done`
alone. Leave the surrounding action-rule matcher guidance (prefix-anchored
on `bob worklog append`/`bob worklog list`) unaffected, since the rule
shape itself does not change.

## Acceptance Criteria

AC-1: The system shall not state that `bob worklog append` takes a
`--left` or `--next` flag.

AC-2: The system shall not describe `Left` or `Next` as part of a worklog
entry's output.

AC-3: WHERE same-day duplicate suppression is documented THE SYSTEM SHALL
state that it compares `Done` alone.

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
