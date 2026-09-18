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

### Session 1 — 2026-09-18

Read T-207's rewritten "If an action is blocked" rule in `references/escalation.md` and T-208's completed Work Log / Review Verdict (`docs/ai-team/tasks/completed/T-208-...md` on `dev-agent`) before touching any file, to confirm the exact phrasing pattern already reviewed and approved for the sibling batch. Also spot-checked T-208's three edited files (automated-notification.md, direct-request.md, meeting-scheduling.md, already merged to `dev-agent`) directly to copy their post-edit "If ... is blocked" wording verbatim rather than re-deriving it.

Confirmed via the task's own Verification grep that this task has no AC-3 equivalent: none of newsletter-bulk.md, self-escalation.md, or suspected-spam.md reference "reconciliation model" or `references/worklog.md`'s carry-forward semantics at all — each file's only relevant section is its trailing "If the move is blocked" paragraph. This matched the task file's own Description/AC count (2 ACs, not 3), so no scope beyond the block-handling phrasing swap was needed in any of the three files.

Ran the task's Verification command first to confirm red state: 3 matches for "open worklog item" (one per file). Updated each file's "If the move is blocked" paragraph, replacing "record the block as an open worklog item and do not treat the message as handled" with "file a `blocked` `bob task` for it and do not treat the message as handled" — the identical substitution T-208 made, keeping every other sentence (the "Do not substitute some other action..." follow-on, and file-specific caveats like self-escalation.md's "never a reason to send an escalation for this message instead" and suspected-spam.md's "never a reason to reply, follow a link, or otherwise engage") unchanged, and continuing to cross-reference `references/escalation.md` for the mechanics rather than restating them, consistent with this file set's existing pointer style. This satisfies AC-1 and AC-2 for all three files.

Re-ran the Verification command afterward: zero matches / no output (green state, matching "expect no output"). Also grepped for "reconciliation model" across the three files as a sanity check (task has no such AC, but wanted to confirm no stray occurrence) — none found, as expected. Re-read all three files in full post-edit to confirm the ACs' literal text is satisfied, not just the grep pattern, and checked line lengths with `awk` — longest line is 93 characters, within the files' existing ~95-character wrap convention (matching T-208's verification approach).

Confirmed `git diff --stat` touches exactly the three files in Files to Touch and nothing else, including the task lifecycle file itself (no diff against `dev-agent` on the lifecycle file, per instructions not to edit it on the task branch).

Nothing remains for this task — all three files and both ACs are covered. Committed as a single docs commit (`c8cd09d`, `docs(email-triage): repoint remaining categories to task filing`) on the task branch. This Work Log entry is handed off for the loop to append to the canonical task file on `dev-agent`.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->
