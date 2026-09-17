---
id: T-211
title: Update the operator guide's worklog continuity prose for same-day 
  duplicate suppression
status: pending
priority: high
assigned-role: developer
created: '2026-09-17'
---

# Update the operator guide's worklog continuity prose for same-day duplicate suppression

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

`the-intern/docs/src/operator-guide/index.md`'s "Cross-day continuity"
paragraph (near the end of the scheduled-job walkthrough) states: "Cross-day
continuity — carrying a still-open item forward from the most recent prior
day — now runs inside `bob worklog` itself: every `bob worklog list` and
`bob worklog append` call reconciles today's file before it returns, so the
`bob worklog*` `bash` rule above is the only rule this path needs." This is
now false per `S-015`/`S-010` (v0.5/v0.3, amended by `CR-013`). Replace it
with: `bob worklog` never reads or writes any day's file but the one an
invocation names — a day's file holds only what that day's runs appended;
`email-triage`'s own continuity (an escalation awaiting a reply, an action
the S-004 gate blocked) now lives on the job's task board instead, which is
why the already-documented `bob task*` rule (this guide already lists it) is
required for this workflow too, not only for `bob task` users generally. No
new rule needs adding — both `bob worklog*` and `bob task*` are already
documented — this is a wording correction plus one clarifying sentence.

## Acceptance Criteria

AC-1: The system shall not state that `bob worklog` reconciles against a
prior day's file or carries an item forward.

AC-2: The system shall state that a day's worklog file holds only what that
day's runs appended.

AC-3: WHERE the scheduled email-triage walkthrough is documented THE SYSTEM
SHALL state that its cross-day continuity for escalations and S-004 blocks
depends on the existing `bob task*` action rule, not on `bob worklog`.

## Dependencies

- `T-203` — documents the CLI's actual final behavior
- `T-206` — documents email-triage's actual final continuity mechanism

## Files to Touch

- `the-intern/docs/src/operator-guide/index.md`

## Verification

```bash
grep -n "reconciles today's file\|carrying a still-open item forward" the-intern/docs/src/operator-guide/index.md
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
