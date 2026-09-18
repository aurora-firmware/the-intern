---
id: T-212
title: Update bob-skills README's worklog continuity prose for same-day 
  duplicate suppression
status: in-progress
priority: high
assigned-role: developer
created: '2026-09-17'
---

# Update bob-skills README's worklog continuity prose for same-day duplicate suppression

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

`the-intern/bob-skills/README.md` duplicates the operator guide's worklog
action-rule listing and cross-day continuity prose (`S-015` Component 5
already notes this duplication by name). It contains the same now-false
claim `T-211` fixes in the operator guide: that `bob worklog` reconciles
against the nearest prior file on every call. Apply the same correction
here — `bob worklog` never touches any day's file but the one named; a
blocked/escalated item's continuity is now the job's `bob task` board's job,
covered by the `bob task*` rule this README already documents (line ~335).
Also correct the file's live-validation narrative sentence(s) that describe
cross-day carry-forward as validated behavior (e.g. around "exercised the
raw-shell worklog recipe" / T-140 cross-references), consistent with `T-211`.

## Acceptance Criteria

AC-1: The system shall not state that `bob worklog` reconciles against a
prior day's file or carries an item forward.

AC-2: The system shall state that a day's worklog file holds only what that
day's runs appended.

AC-3: WHERE this README describes email-triage's cross-day continuity for
escalations and S-004 blocks THE SYSTEM SHALL attribute it to the job's
`bob task` board and the existing `bob task*` rule, not to `bob worklog`.

## Dependencies

- `T-203` — documents the CLI's actual final behavior
- `T-206` — documents email-triage's actual final continuity mechanism

## Files to Touch

- `the-intern/bob-skills/README.md`

## Verification

```bash
grep -n "reconciles today's file\|carrying a still-open item forward\|cross-day carry-forward" the-intern/bob-skills/README.md
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
