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

### Session 1 — 2026-09-18

Rewrote `the-intern/bob-skills/skills/email-triage/references/escalation.md` per `S-010` v0.3, grounded in T-206's already-merged rewrite of `SKILL.md` and `references/worklog.md` (read first, as the Dependencies note requires, to keep wording/conventions consistent — the `blocked`/`todo` split, the `bob task list`/`bob task status` vocabulary, and the "task names the identifier, worklog entry names the task" convention all carry over unchanged).

Four changes, one per AC. (1) Merged the old escalation-send-specific "If the escalation send is denied" section into a new generic "If an action is blocked" section — this is the "block-handling rule" every `references/categories/*.md` file already cross-references by that name (confirmed via grep before editing: all six category files and `README.md` say "follow the block-handling rule `references/escalation.md` already establishes"), so it now explicitly covers both a category workflow's own blocked action and the escalation send itself, states filing a `blocked` `bob task` naming the message and the refused action plus what would unblock it, and states the message is not treated as handled (AC-2). (2) Rewrote the "no usable `From:` header" fallback tail in "If the escalation configuration is missing or malformed" the same way: file a `blocked` task rather than just "record the problem in the worklog." (3) Rewrote "No synchronous reply is expected": added that a successful send files a `todo` task for the awaited reply, and that a later run discovers it by listing the job's own task board (`bob task list`) — the same discovery path `SKILL.md` step 1 and `worklog.md` already establish (AC-3) — then replaced the closing paragraph's "the escalated message's open worklog item stays open, carried forward by `bob worklog`" with "the filed task stays open... until the reply's own per-message worklog entry closes it by moving the task to `done`." (4) Every place a task is filed or closed now explicitly says the worklog entry names that task's identifier "instead of recording the open condition itself there" (AC-4), matching `worklog.md`'s already-established "Open items live on the task board, never... in the worklog." Also removed all "open item"/"open worklog item"/"carried forward"/"reconciliation" phrasing (AC-1) — confirmed by the task's own grep verification (no output) and a broadened search for any "carr*" token or "open item" phrase (also no output).

What was tried and rejected: kept the header name/anchor "No synchronous reply is expected" unchanged because `references/worklog.md` line 60 cross-references it by that exact name — renaming it would have broken that reference for no benefit. Considered leaving "If the escalation send is denied" as its own section with a separate new "block-handling rule" section duplicating the same instructions, but rejected that as exactly the kind of restatement the task's Description warns against (T-208/T-209 "only need to keep matching it by cross-reference, not restate it" — the same discipline applies here: one escalation-send-specific paragraph pointing back at one generic rule, not two parallel copies of the rule). Verified before editing that no other file anchors on the literal header text "If the escalation send is denied" (only escalation.md's own internal cross-reference at the old line 57), so renaming/merging that section was safe.

What remains: `references/categories/*.md` (all six category files) still literally say "record the block as an open worklog item" in their own "If the move/reply is blocked" sections — confirmed still present, unchanged, and correctly out of scope: T-207's Files to Touch is `references/escalation.md` only, and the task's own Description states those files "only need to keep matching it by cross-reference, not restate it," which is exactly what T-208/T-209 (already queued) are for. No new follow-up task is needed. This task (T-207) is otherwise complete and ready for review.

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

Stage 1 (Acceptance Criteria) — all four ACs verified against the literal
post-change text of `references/escalation.md` on
`task/T-207-rewrite-the-email-triage-block-handling-rule-to-file-a-task-instead-of-an-open-worklog-item`,
not just the task's grep-based Verification command:

- AC-1: confirmed — no "open worklog item"/"carried forward"/"reconcil"/
  "open item" phrasing anywhere in the file (checked beyond the task's own
  grep list).
- AC-2: confirmed — the merged "If an action is blocked" section instructs
  filing a `blocked` `bob task` "naming the message and the refused
  action, and stating what would unblock it," and states the message "is
  not treated as handled."
- AC-3: confirmed — "No synchronous reply is expected" instructs filing a
  `todo` task for the awaited reply on send success, and states "a later
  run discovers it... by listing this job's own task board (`bob task
  list`)... not by reading a previous day's worklog."
- AC-4: confirmed — all three task-filing/closing points in the file
  ("If an action is blocked," the missing-`From:`-header fallback, and the
  "No synchronous reply is expected" closing paragraph) state the worklog
  entry names the task rather than recording the open condition itself.

Files to Touch: confirmed exactly one file changed
(`the-intern/bob-skills/skills/email-triage/references/escalation.md`,
`git diff --stat dev-agent..task/T-207-...`); the task file's own diff is
only the Work Log entry the loop had already committed separately to
`dev-agent`, not branch scope creep.

Cross-reference contract (item 5): independently grepped all six
`references/categories/*.md` files plus `references/categories/README.md`
— each still says "follow the block-handling rule
`references/escalation.md` already establishes," confirming the
Developer's claim that this file is the single cross-referenced authority
by name, not by section anchor. The rewritten "If an action is blocked"
section explicitly covers both a category workflow's own blocked action
("a category workflow's own action against a confidently classified
message, or the escalation send below") and, in a following paragraph,
the escalation-send-specific case ("For a denied escalation send
specifically, the refused action named in the filed task is the
escalation send itself..."). Confirmed this is a merge, not a
find-replace: the old escalation-only section was folded into one
generic rule plus one specific clarifying paragraph, matching the
Description's "single place that wording changes" instruction.

Broken-reference check (item 6): grepped the full `the-intern/` and
`docs/` trees for the literal old header text "If the escalation send is
denied." The only remaining occurrences are (a) the file's own git
history/diff, (b) completed tasks' historical Work Log prose (not live
cross-references), and (c) the generated, not-yet-regenerated
`the-intern/bob-skills/.pi/skills/email-triage/references/escalation.md`
mirror. That `.pi/` drift is expected and tracked separately —
`the-intern/bob-skills/README.md`'s "Regenerating the pi package" section
documents `.pi/skills/` as generated output requiring a dedicated
`package-pi-skills.sh` run after canonical `skills/` changes, and
`T-210` (pending, depends on `T-207`/`T-208`/`T-209`) is the task
responsible for that regeneration — not a T-207 defect. No live
cross-reference to the renamed header remains broken. Also confirmed
`references/worklog.md` line 60's cross-reference to the "No synchronous
reply is expected" header (kept unchanged) still resolves.

Cross-check against `S-010` (v0.3) Workflow and Configuration
Requirements sections: wording for the blocked-action case ("file a
`blocked` task naming the message, the action that was refused, and what
would unblock it") and the escalation-reply case ("file a task for the
awaited reply, naming the message and what the escalation asked") match
the spec's own phrasing closely. Cross-check against T-206's merged
`SKILL.md`/`references/worklog.md`: vocabulary (`bob task`,
`blocked`/`todo`, "action-authorization gate," "task names the
identifier, worklog entry names the task") is consistent throughout, and
SKILL.md step 3's blocked-action and escalation-send-denied instructions
match this file's rule near-verbatim.

Stage 2 (Code Quality) — this is a docs-only change; correctness
(wording matches spec/AC and sibling files), readability (clear section
structure, no dead prose), and no unrelated edits all check out. No
build/test commands apply to this task.

Minor observation (non-blocking): the six `references/categories/*.md`
files still literally say "record the block as an open worklog item,"
which is stale relative to this file's rewritten rule until `T-208`/
`T-209` land — already tracked and correctly out of this task's scope.

Both stages pass. No new bugs filed — the two out-of-scope items found
during review (`.pi/` package drift, category-file staleness) are already
covered by existing pending tasks `T-210` and `T-208`/`T-209`
respectively.
