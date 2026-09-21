---
id: T-223
title: Update bob-skills README's worklog CLI reference for Done-only entries
status: pending
priority: medium
assigned-role: developer
created: '2026-09-21'
---

# Update bob-skills README's worklog CLI reference for Done-only entries

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

`the-intern/bob-skills/README.md` documents `bob worklog append`'s
four-flag shape and its action-rule listing in `--left`/`--next` terms —
`T-215` narrows the CLI to `--item`/`--done` only. Rewrite the relevant
passage(s) to match the two-flag shape; the action-rule matcher itself
(prefix-anchored on `bob worklog append`/`bob worklog list`) is unaffected
and stays as-is.

## Acceptance Criteria

AC-1: The system shall not state that `bob worklog append` takes a
`--left` or `--next` flag.

AC-2: The system shall not describe `Left` or `Next` as part of a worklog
entry's output.

## Dependencies

- `T-215` — documents the CLI's actual final flag/output shape

## Files to Touch

- `the-intern/bob-skills/README.md`

## Verification

```bash
grep -n "\-\-left\|\-\-next\|Left:\|Next:" the-intern/bob-skills/README.md
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
