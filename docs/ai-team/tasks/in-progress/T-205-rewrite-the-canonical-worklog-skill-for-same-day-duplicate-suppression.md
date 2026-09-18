---
id: T-205
title: Rewrite the canonical worklog skill for same-day duplicate suppression
status: in-progress
priority: high
assigned-role: developer
created: '2026-09-17'
---

# Rewrite the canonical worklog skill for same-day duplicate suppression

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

The canonical `worklog` skill
(`the-intern/bob-skills/skills/worklog/`) still teaches the retired
cross-day contract: `SKILL.md` tells a run to call `bob worklog list` at
the start of a run to receive "today's carried-forward set", and
`references/reconciliation.md` describes the old carry-forward mechanics in
full. Per `S-015` (v0.5, amended by `CR-013`), rewrite both to describe
same-day duplicate suppression instead: a day's file holds only what that
day's runs appended, `bob worklog` never reads or writes any other day's
file, and a run that needs to know what a previous day recorded asks for it
explicitly with `bob worklog list --date`. Repurpose
`references/reconciliation.md`'s content to same-day duplicate suppression
rather than deleting the file, so `SKILL.md`'s existing reference link and
any other cross-reference to it keep resolving.
`references/entry-format.md`'s "Carried-forward entries" section
(describing an entry the command writes automatically) is removed, since
the command never writes an entry a caller did not explicitly request.

## Acceptance Criteria

AC-1: The system shall not state anywhere in `SKILL.md` or its references
that `bob worklog` carries an item forward across days, reconciles against
a prior file, or reports a carried-forward set.

AC-2: WHERE `references/reconciliation.md` exists THE SYSTEM SHALL describe
same-day exact-duplicate suppression (compare incoming `Done`/`Left`/`Next`
against the item's most recent entry already in today's file; identical on
all three → no write) as the only automatic behavior `append` performs.

AC-3: The system shall state that a session needing to know what a
previous day recorded must call `bob worklog list --date <date>` itself,
and that nothing about that read is automatic.

AC-4: The system shall not describe first-run detection as something
either the skill or the command performs.

## Dependencies

- `T-203` — the skill documents the CLI's actual final output contract

## Files to Touch

- `the-intern/bob-skills/skills/worklog/SKILL.md`
- `the-intern/bob-skills/skills/worklog/references/reconciliation.md`
- `the-intern/bob-skills/skills/worklog/references/entry-format.md`

## Verification

```bash
grep -rniL "carried.forward\|carry.forward\|first-run\|reconcil" the-intern/bob-skills/skills/worklog/SKILL.md the-intern/bob-skills/skills/worklog/references/reconciliation.md the-intern/bob-skills/skills/worklog/references/entry-format.md
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
