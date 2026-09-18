---
id: T-206
title: Rewrite email-triage's continuity surface to file bob task entries 
  instead of open worklog items
status: in-progress
priority: high
assigned-role: developer
created: '2026-09-17'
---

# Rewrite email-triage's continuity surface to file bob task entries instead of open worklog items

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

Per `S-010` (v0.3, amended by `CR-013`), `email-triage`'s continuity
mechanism moves from `bob worklog`'s (now-removed) cross-day carry-forward
to the job's own `bob task` board. Rewrite `SKILL.md` and
`references/worklog.md`: a run now begins by listing its own task board
(`bob task list`, board resolved **explicitly** at the job's own working
directory, never via `bob task`'s upward search — S-010's Configuration
Requirement "Task board location" exists specifically so two jobs never
converge on one board) and retrying every task still `blocked`/`todo`
before or alongside new mail. Anything the run cannot finish this pass
(escalation awaiting a reply, an action the S-004 gate blocked) is filed as
a task instead of an open worklog item. The worklog keeps recording only
what a run did — including the identifier of any task it filed or closed —
never anything carried across days. Reference the canonical `tasks` skill
(`the-intern/bob-skills/skills/tasks/SKILL.md`) for the command's own
mechanics, the same way this content already defers to `worklog` for the
diary's.

## Acceptance Criteria

AC-1: The system shall state that a run begins by listing the job's own
task board via `bob task list`, with the board resolved explicitly to the
job's own working directory rather than found by upward search.

AC-2: WHEN an escalation is sent or an action is blocked by the S-004 gate
THE SYSTEM SHALL instruct filing a `bob task` (status `blocked` or `todo`
as appropriate) rather than recording the item as open in the worklog.

AC-3: WHEN the underlying cause of a filed task resolves (a manager reply
arrives, or a retried blocked action succeeds) THE SYSTEM SHALL instruct
moving that task to `done` via `bob task status`.

AC-4: The system shall not state anywhere that `bob worklog` carries an
item forward across days or reports a carried-forward set.

AC-5: The system shall instruct that every worklog entry name the
identifier of any task filed or closed for that item, so the diary and the
board stay cross-referenced.

## Dependencies

- `T-205` — the `worklog` skill's own discipline (what this content defers
  to for diary mechanics) must already describe the amended contract

## Files to Touch

- `the-intern/bob-skills/skills/email-triage/SKILL.md`
- `the-intern/bob-skills/skills/email-triage/references/worklog.md`

## Verification

```bash
grep -n "carried.forward\|carry.forward\|reconcil" the-intern/bob-skills/skills/email-triage/SKILL.md the-intern/bob-skills/skills/email-triage/references/worklog.md
# expect no output
grep -n "bob task" the-intern/bob-skills/skills/email-triage/references/worklog.md
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
