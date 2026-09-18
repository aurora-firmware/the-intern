---
id: T-207
title: Rewrite the email-triage block-handling rule to file a task instead of an
  open worklog item
status: in-progress
priority: high
assigned-role: developer
created: '2026-09-17'
---

# Rewrite the email-triage block-handling rule to file a task instead of an open worklog item

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

`references/escalation.md` is the single authoritative source every
category workflow file cross-references for what happens when an
escalation send or a category action is blocked by the S-004 gate — today
it says to "record the block as an open worklog item." Rewrite it, per
`S-010` (v0.3), to say the block is filed as a `bob task` (status
`blocked`), naming the message and what would unblock it, and that the
message is still not treated as handled. Also update this file's own
account of "no synchronous reply is expected" for an escalation: the
awaited reply is now tracked as a `todo`/`blocked` task the run retries,
not an open worklog item. This is the single place that wording changes;
`T-208`/`T-209` only need to keep matching it by cross-reference, not
restate it.

## Acceptance Criteria

AC-1: The system shall not state that a blocked action or a pending
escalation is recorded as an open worklog item.

AC-2: WHEN an action a category workflow attempts is blocked by the S-004
gate THE SYSTEM SHALL instruct filing a `blocked` `bob task` naming the
message and the refused action, and SHALL instruct that the message is not
treated as handled.

AC-3: WHEN an escalation email is sent to the manager address THE SYSTEM
SHALL instruct filing a task for the awaited reply, and state that a later
run discovers it by listing the job's own task board.

AC-4: The system shall state that the worklog entry for the message names
the task filed, rather than recording the open condition itself.

## Dependencies

- `T-206` — this file's wording must stay consistent with `worklog.md`'s
  own account of filing and discovering tasks

## Files to Touch

- `the-intern/bob-skills/skills/email-triage/references/escalation.md`

## Verification

```bash
grep -n "open worklog item\|carried.forward\|reconcil" the-intern/bob-skills/skills/email-triage/references/escalation.md
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
