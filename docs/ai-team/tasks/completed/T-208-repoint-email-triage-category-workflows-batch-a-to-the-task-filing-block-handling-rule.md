---
id: T-208
title: Repoint email-triage category workflows batch A to the task-filing 
  block-handling rule
status: completed
priority: high
assigned-role: developer
created: '2026-09-17'
---

# Repoint email-triage category workflows batch A to the task-filing block-handling rule

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

Three category reference workflows each restate the same phrase
`references/escalation.md` (`T-207`) now defines differently: "follow the
block-handling rule `references/escalation.md` already establishes: record
the block as an open worklog item and do not treat the message as handled."
Update each occurrence to match `T-207`'s rewritten rule (filing a `blocked`
`bob task`, message still not treated as handled).
`automated-notification.md` additionally references
"`references/worklog.md`'s reconciliation model" when explaining that a
routine-failure note is not an open item under that model — update this to
reference the current (non-reconciling) worklog/task-board model instead.

## Acceptance Criteria

AC-1: The system shall not state, in any of the three files, that a blocked
action is recorded as an open worklog item.

AC-2: WHEN a category action is blocked by the S-004 gate THE SYSTEM SHALL
instruct filing a `bob task` per `references/escalation.md`'s rule, in all
three files.

AC-3: WHERE `automated-notification.md` describes a routine-failure note's
non-open-item status THE SYSTEM SHALL reference the current worklog/task
model rather than a "reconciliation model."

## Dependencies

- `T-207` — the block-handling rule these files cross-reference must
  already be rewritten

## Files to Touch

- `the-intern/bob-skills/skills/email-triage/references/categories/automated-notification.md`
- `the-intern/bob-skills/skills/email-triage/references/categories/direct-request.md`
- `the-intern/bob-skills/skills/email-triage/references/categories/meeting-scheduling.md`

## Verification

```bash
grep -n "open worklog item\|reconciliation model" the-intern/bob-skills/skills/email-triage/references/categories/automated-notification.md the-intern/bob-skills/skills/email-triage/references/categories/direct-request.md the-intern/bob-skills/skills/email-triage/references/categories/meeting-scheduling.md
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

Read T-207's rewritten "If an action is blocked" rule in `the-intern/bob-skills/skills/email-triage/references/escalation.md` and the current content of `references/worklog.md` before touching any category file, per the task's own guidance that escalation.md is meant to be the single place block-handling wording changes.

Updated all three "If the move/reply is blocked" sections (automated-notification.md, direct-request.md, meeting-scheduling.md) from the retired "record the block as an open worklog item" phrasing to T-207's current rule — "file a `blocked` `bob task` for it and do not treat the message as handled" — while continuing to cross-reference `references/escalation.md` rather than restating its mechanics, matching the existing one-line cross-reference style already used elsewhere in these files (e.g. the escalation cross-references in direct-request.md and meeting-scheduling.md's "answer needs information" sections). This satisfies AC-1 and AC-2.

For AC-3, updated automated-notification.md's routine-failure-note paragraph, which previously said the note is "not an open item under `references/worklog.md`'s reconciliation model" and explained the distinction via "`bob worklog` does not carry it forward the way it carries an escalation or a block." I considered a minimal find-and-replace of just the term "reconciliation model" but rejected it: `references/worklog.md`'s current model states that `bob worklog` never carries anything forward for any item, regardless of type — carry-forward of open items happens exclusively through a filed `bob task`. Keeping the old "`bob worklog` does not carry it forward" framing after swapping only the model's name would have left a now-inaccurate claim in place. Instead I rewrote the paragraph so the actual distinguishing fact is correct against the current model: unlike the model's two defined open-item causes (an escalation awaiting a manager's reply, or an action the action-authorization gate blocked), no `bob task` is filed for a routine failure note, so nothing tracks it as outstanding once the worklog entry is appended. The paragraph now references `references/worklog.md`'s "worklog/task-board model" (matching the task description's own suggested phrasing) instead of "reconciliation model."

Verified via the task's own Verification command (`grep -n "open worklog item\|reconciliation model" <3 files>`): confirmed 4 matches before the edits (red state) and zero matches after (green state, matching the task's "expect no output"). Re-read all three files in full afterward to confirm each AC's literal text is satisfied, not just the grep pattern, and checked line lengths stayed within the files' existing ~95-character wrap convention.

Nothing remains for this task — all three files and all three ACs are covered. Committed as a single docs commit (`d148ae7`, `docs(email-triage): repoint category blocked-handling to task filing`) on the task branch. Did not touch the task lifecycle file on this branch, per instructions; this Work Log entry is handed off for the loop to append to the canonical file on `dev-agent`.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->

### Review Verdict — 2026-09-18

PASS

**Stage 1 — Acceptance Criteria.** Read the full post-change text of all three files on
`task/T-208-...` (not just the grep output) and cross-checked against the current
`references/escalation.md` (T-207's rewritten rule) and `references/worklog.md`.

- AC-1: Confirmed no occurrence of "open worklog item" in any of the three files
  (`grep -rn "open worklog item" <3 files>` on the task branch: no matches). The retired
  phrase only remains in the untouched `suspected-spam.md`, `newsletter-bulk.md`, and
  `self-escalation.md`, which are correctly out of this batch's scope.
- AC-2: All three "If the move/reply is blocked" sections instruct "follow the
  block-handling rule `references/escalation.md` already establishes: file a `blocked`
  `bob task` for it and do not treat the message as handled" — matching T-207's rule in
  `escalation.md`'s "If an action is blocked" section ("file a `bob task` for it — status
  `blocked` ... do not treat the message as handled").
- AC-3: `automated-notification.md`'s routine-failure-note paragraph now reads "not an open
  item under `references/worklog.md`'s worklog/task-board model" — the "reconciliation
  model" phrase is gone and replaced with the task description's own suggested phrasing.

**Fact-check of the rewritten AC-3 paragraph.** The Work Log claims a straight
find-and-replace of "reconciliation model" would have left an inaccurate sentence in place
("`bob worklog` does not carry it forward the way it carries an escalation or a block").
Verified against `references/worklog.md`'s current content: "`bob worklog` records only what
a run explicitly appended on the day it ran, and never carries anything into another day's
file" — worklog itself never carries anything forward for any item type; tracking happens
exclusively via a filed `bob task` (worklog.md's "How an open item closes" section names
exactly two open-item causes: escalation `todo` and gate-blocked `todo`/`blocked`). The
rewritten paragraph correctly relocates the distinguishing fact to "no `bob task` is filed
for it, so nothing tracks it as outstanding" — this is accurate under the current model. The
Developer's reasoning for rejecting a minimal find-replace holds up.

**Cross-reference discipline (T-207 intent).** All three "If ... is blocked" sections still
point to `references/escalation.md` for the mechanics ("follow the block-handling rule
`references/escalation.md` already establishes") and state only the outcome in one line,
consistent with this file set's existing pointer style (e.g. direct-request.md's and
meeting-scheduling.md's "Escalate the message per `references/escalation.md` instead...this
file does not restate..."). No file restates `escalation.md`'s task-status, worklog-naming,
or denied-escalation mechanics.

**Scope.** `git diff dev-agent...task/T-208-...` touches exactly the three files in Files to
Touch (`automated-notification.md`, `direct-request.md`, `meeting-scheduling.md`) and
nothing else.

**Stage 2 — Code Quality.** Docs-only change; no build/test applies. Prose reads clearly,
each rewritten sentence is grammatically sound, no leftover inconsistent phrasing, and line
lengths stay within the files' existing ~95-character wrap convention (spot-checked longest
lines in `automated-notification.md`, max 94 chars).

Both stages pass. No blocking issues found.
