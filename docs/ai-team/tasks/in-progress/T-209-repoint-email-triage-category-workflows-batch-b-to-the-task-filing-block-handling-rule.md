---
id: T-209
title: Repoint email-triage category workflows batch B to the task-filing 
  block-handling rule
status: in-progress
priority: high
assigned-role: developer
created: '2026-09-17'
---

# Repoint email-triage category workflows batch B to the task-filing block-handling rule

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

The remaining three category reference workflows each restate the same
phrase `references/escalation.md` (`T-207`) now defines differently:
"follow the block-handling rule `references/escalation.md` already
establishes: record the block as an open worklog item and do not treat the
message as handled." Update each occurrence to match `T-207`'s rewritten
rule (filing a `blocked` `bob task`, message still not treated as handled).
This is the same mechanical edit `T-208` makes to the other three category
files; split into its own task only to stay within the file-count limit,
not because the content differs.

## Acceptance Criteria

AC-1: The system shall not state, in any of the three files, that a blocked
action is recorded as an open worklog item.

AC-2: WHEN a category action is blocked by the S-004 gate THE SYSTEM SHALL
instruct filing a `bob task` per `references/escalation.md`'s rule, in all
three files.

## Dependencies

- `T-207` — the block-handling rule these files cross-reference must
  already be rewritten

## Files to Touch

- `the-intern/bob-skills/skills/email-triage/references/categories/newsletter-bulk.md`
- `the-intern/bob-skills/skills/email-triage/references/categories/self-escalation.md`
- `the-intern/bob-skills/skills/email-triage/references/categories/suspected-spam.md`

## Verification

```bash
grep -n "open worklog item" the-intern/bob-skills/skills/email-triage/references/categories/newsletter-bulk.md the-intern/bob-skills/skills/email-triage/references/categories/self-escalation.md the-intern/bob-skills/skills/email-triage/references/categories/suspected-spam.md
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
