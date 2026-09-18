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

### Session 1 — 2026-09-18

Rewrote `the-intern/bob-skills/skills/email-triage/SKILL.md` and `the-intern/bob-skills/skills/email-triage/references/worklog.md` to move `email-triage`'s continuity surface from `bob worklog`'s removed cross-day carry-forward to the job's own `bob task` board, per `S-010` v0.3 (CR-013-amended), grounded in T-205's rewritten `worklog` skill (`the-intern/bob-skills/skills/worklog/SKILL.md`, `references/entry-format.md`, `references/reconciliation.md`) and the canonical `tasks` skill (`the-intern/bob-skills/skills/tasks/SKILL.md`).

`SKILL.md`'s four-step loop is now: (1) list the job's own task board via `bob task list`, board resolved explicitly at the job's own working directory rather than via `bob task`'s upward search (citing the `tasks` skill's "Where the board lives" and S-010's "Task board location" requirement for why), retrying every task still `blocked` (an S-004-refused action — retry the same `himalaya` call; on success, move to `done` via `bob task status` and append a worklog entry naming the closed task; on continued refusal, leave `blocked` and record the attempt on the task itself via the tasks skill's "Record progress without changing status," not in the worklog) or `todo` (a pending escalation — nothing to actively resend; the reply surfaces as ordinary unseen mail and is handled/closes the task in steps 2–4); (2) list unseen mail (unchanged); (3) act on or escalate each message, filing a `bob task` (`blocked` for an S-004-refused action or a refused escalation send, `todo` for a successfully sent escalation) instead of recording an "open worklog item"; (4) record a worklog entry for the message that now must name the identifier of any task filed or closed that step, satisfying AC-5's cross-referencing requirement. Frontmatter description and the "Tool usage" section were updated to name the `tasks` skill and `bob task` calls alongside `worklog`/`bob worklog` in the gated surface.

`references/worklog.md` was rewritten around the same model: the item-identifier convention (`<subject> (from <sender>)`) is now also the recommended naming convention inside a filed task; "Open items live in the worklog only" became "Open items live on the task board, never in mailbox flag state or in the worklog," explaining that `bob worklog` can no longer fill that role since it never carries anything across days; "How an open item closes" was rewritten around `bob task status <id> done` for both closing causes (manager reply arrives; a retried S-004 block succeeds), each pointing back at the relevant `SKILL.md` step.

Both of the task's Verification grep commands pass exactly as specified: `grep -n "carried.forward\|carry.forward\|reconcil" SKILL.md references/worklog.md` produces no output (exit 1), and `grep -n "bob task" references/worklog.md` produces multiple matches (6 lines).

What was deliberately rejected: extending this rewrite into `references/escalation.md` or the `references/categories/*.md` workflow files. Those files still say "record the block as an open worklog item" and still cite the old worklog-carries-it-forward model (confirmed by grep across `references/`) — but they are outside this task's `Files to Touch`, and CR-013's own Potential Impact section flags them as a separate, later rewrite ("the escalation and S-004-block category workflows... are rewritten, not merely trimmed" — filed as its own concern, not folded into S-010's amendment). I treated this task strictly as the SKILL.md/worklog.md slice of that larger CR-013 fallout, per its explicit Files to Touch and dependency on only T-205. I also considered mapping both open-item causes (blocked action, pending escalation) to a single status (`blocked`, since the `tasks` skill's own definition of "stalled on something outside this run's control" fits both) rather than splitting `blocked`/`todo`, but rejected that in favor of the split the task's AC-2 explicitly offers ("blocked or todo as appropriate") and that S-010's Workflow text supports (only the S-004-gate case is ever called "blocked" there) — `todo` for a sent-and-awaiting-reply escalation reads as "nothing has started on our side yet" rather than "we are stalled," which is a defensible, if not the only possible, reading.

What remains: `references/escalation.md` and `references/categories/*.md` (`newsletter-bulk.md`, `automated-notification.md`, `meeting-scheduling.md`, `self-escalation.md`, `direct-request.md`, `suspected-spam.md`) still say "record the block as an open worklog item" and, in `automated-notification.md`'s case, explicitly name the now-removed "reconciliation model" — already covered by the queued `T-207` (block-handling rule rewrite) and `T-208`/`T-209` (category workflow repointing), so no new follow-up task is needed. This task (T-206) is otherwise complete and ready for review.

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

Both stages passed. Reviewed the full post-change text of both files on
`task/T-206-...` (commit `1ecff4e`), not just the grep-based Verification
commands, against the literal AC text, `S-010` v0.3, and `CR-013`.

**Stage 1 — Acceptance Criteria**

- AC-1: Met. `SKILL.md` step 1 states `bob task list` is called with the
  board "resolved **explicitly** to this job's own working directory
  rather than through `bob task`'s own default upward search," citing the
  `tasks` skill's "Where the board lives" and S-010's "Task board
  location" requirement, and extends explicit resolution to "every `bob
  task` call this skill makes, not only this one."
- AC-2: Met. `SKILL.md` step 3 files `blocked` for a category action the
  gate refuses, `todo` when an escalation send succeeds, and `blocked`
  when the escalation send itself is refused — all three cases file a
  `bob task` instead of an "open worklog item." `worklog.md`'s "Open items
  live on the task board" section restates the same mapping.
  On the blocked/todo split itself: the Developer's Work Log reasoning
  (S-004-refused action → `blocked`; sent-and-awaiting-reply escalation →
  `todo`) was cross-checked against S-010's own text and the `tasks`
  skill's status definitions, not taken on trust. S-010's Workflow
  ("every task still `blocked` or `todo`... a pending manager escalation,
  or an action S-004 blocked") is genuinely ambiguous about ordering, and
  both S-010's Workflow and CR-013's own resolution text use "blocked or
  todo as appropriate" without pinning one canonical mapping — this
  delegation of judgment appears deliberate. Read against the `tasks`
  skill's definitions (`blocked` = "stalled on something outside this
  run's control"; `todo` = "not yet started"), the chosen split is
  defensible if the "item" being tracked for an escalation is understood
  as "act on the manager's reply" (genuinely not yet started) rather than
  "the escalation's own state" — not the only possible reading, as the
  Developer's own Work Log acknowledges, but internally consistent
  throughout both files and functionally correct: `blocked` tasks are the
  only ones step 1 actively retries (re-issuing the same `bash` call),
  while `todo` tasks are correctly left for the reply to surface as unseen
  mail — matching S-010's "How an open item closes" behavior regardless of
  which label is attached to which cause. Not a gap against AC-2's "as
  appropriate" language.
- AC-3: Met. `SKILL.md` step 1 (successful retry) and step 4 (manager
  reply) both instruct moving the task to `done` via `bob task status`;
  `worklog.md`'s "How an open item closes" section states the same for
  both causes.
- AC-4: Met. Independently re-ran the task's grep pattern
  (`carried.forward\|carry.forward\|reconcil`) against both files on the
  task branch — no matches. Broadened the search to every "carr*" token:
  the only three hits are "it carries the confidence-gated..." (unrelated
  sense), "`Done`/`Left`/`Next` fields every entry carries" (unrelated
  sense), and "never carries anything into another day's file" (a
  negation, not a claim of carry-forward). No claim anywhere that `bob
  worklog` carries an item forward or reports a carried-forward set.
- AC-5: Met. `SKILL.md` step 4 states the entry "must name the identifier
  of any `bob task` this message's handling filed or closed, so the diary
  and the board stay cross-referenced," with explicit sub-bullets for the
  filed and closed cases; step 1's successful-retry path also names the
  closed task in its `bob worklog append` call.
- Scope: confirmed via `git show --stat` on the task branch's single
  commit (`1ecff4e`) that only `SKILL.md` and `references/worklog.md`
  were touched. The canonical task file's Work Log entry was committed
  separately, directly on `dev-agent` (`e6203ba`), matching this
  repository's established pattern (e.g. T-205) — not a Files-to-Touch
  violation.

**Out-of-scope claim (escalation.md / categories/*.md).** Independently
read the three pending task files under `docs/ai-team/tasks/pending/`:
`T-207` (`Files to Touch`: `references/escalation.md`), `T-208`
(`automated-notification.md`, `direct-request.md`,
`meeting-scheduling.md`), and `T-209` (`newsletter-bulk.md`,
`self-escalation.md`, `suspected-spam.md`) — together these are exactly
the seven files the Developer's Work Log names. Independently grepped
`references/escalation.md` and all six `references/categories/*.md` files
and confirmed the stale "record the block as an open worklog item" /
"carried forward by `bob worklog`" / "reconciliation model" language is
still present there (and confirmed `categories/README.md`, not named by
the Developer, has no such language either). No new follow-up task is
needed; T-207/T-208/T-209 already cover this fully.

**Stage 2 — Code Quality.** Both files read coherently and consistently
with each other and with `S-010`/`CR-013`: cross-references to the
`tasks` skill's actual section names ("Where the board lives," "Record
progress without changing status") and to the `worklog` skill are
accurate on inspection. No dead prose, no unspecified behavior added, no
security/performance concerns (docs-only change).

Minor non-blocking observation: `worklog.md`'s closing paragraph says a
still-open item is "listed and retried again the next time `SKILL.md`
step 1 runs" for both the blocked-retry and unanswered-escalation causes,
but `SKILL.md` step 1 itself is explicit that a `todo` escalation task has
"nothing to actively resend" — only listed, not retried. This is loose
summary phrasing, not a contradiction (the detailed text a few lines
above it in the same section gets this right), and does not affect any
AC. No action required.

Next owner: Development Loop.
