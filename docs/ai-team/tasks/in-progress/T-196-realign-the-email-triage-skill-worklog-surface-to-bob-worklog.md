---
id: T-196
title: Realign the email-triage skill worklog surface to bob worklog
status: pending
priority: medium
assigned-role: developer
created: '2026-08-30'
---

# Realign the email-triage skill worklog surface to bob worklog

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

Component 4, canonical email-triage edits: point every part of the
`email-triage` skill that still describes hand-run diary mechanics or a
"first-run reconciliation" retry point at the `bob worklog` command.
S-015's Exclusions bar changes to `email-triage` *beyond* pointing it at
the new command — this task is exactly that (classification signals,
category matching, and the act-or-escalate decision stay untouched).
Canonical (vendor-neutral) files only; pi-package regeneration is T-199;
the six `references/categories/*.md` files are T-200.

**1. `the-intern/bob-skills/skills/email-triage/SKILL.md`** — the following
stale surfaces (line numbers approximate):

- The four-step run summary (~L23, "reconcile (first executed run of the
  day…)") and the numbered step "### 1. Determine whether this is the day's
  first executed run, and reconcile" (~L71): the run no longer decides
  first-run; the loop's opening step is to read today's carried-forward set
  from `bob worklog list` output (the command has already reconciled before
  it responds).
- The cross-reference to the `worklog` skill's `references/reconciliation.md`
  "First-run reconciliation" section (~L74) — T-195 deletes that section;
  drop the reference.
- The frontmatter `description` / intro delegation list that still claims
  `worklog` owns "first-run detection, and reconciliation" — align with
  `S-011`'s amended Responsibility row (the command owns those).
- The "Tool usage" section (~L42–L60): rewrite from `read` of `worklog/*.md`
  plus `bash` `cat` / `test` / `mkdir` / append to the single `bash` surface
  invoking `bob worklog append` / `bob worklog list`. Its cross-reference to
  the `worklog` skill's `references/entry-format.md` append-command shape
  (~L50) goes away with it.
- Step 3, blocked action (~L123–L128, where "first-run" and
  "reconciliation" are split across two lines) and blocked escalation send
  (~L162–L167): the
  `Next` guidance "retry at the next first-run reconciliation once an
  admitting allow rule exists" — repoint the retry trigger to "the
  carried-forward set reported by `bob worklog list` at the start of any
  run".
- Step 4, "Record a worklog entry for the message" (~L175–L191): the
  primary write instruction "Follow the `worklog` skill's own
  `references/entry-format.md` for how to create `worklog/` and today's
  file if either is still missing, the exact append-command shape" — T-195
  deletes that content; replace with a single `bob worklog append` call
  (the command creates `worklog/` and today's file itself). Fix the `Next`
  "next first-run reconciliation" phrasing here too.

**2. `the-intern/bob-skills/skills/email-triage/references/worklog.md`** —
its delegation text lists "how to tell whether a run is the day's first
executed run" and "how first-run reconciliation carries forward open items"
among the mechanics it defers, and says "This skill's own loop step 1 is
the point at which a carried-forward blocked action is retried." Rewrite so
the consuming skill reads today's carried-forward set from `bob worklog`
output and retries carried-forward blocked actions against that set. Do not
change the item-identifier definition or the email-specific open/close
causes.

**3. `the-intern/bob-skills/skills/email-triage/references/escalation.md`**
(~L113–L115) — "the escalated message's open worklog item stays open,
carried forward at each day's first-run reconciliation": repoint to "…
carried forward by `bob worklog` on every run until the reply arrives".

All three files must stay free of this project's internal identifiers.

## Acceptance Criteria

AC-1: The `email-triage` `SKILL.md` shall contain no step that decides
whether a run is the day's first executed run, no cross-reference to a
`worklog` "First-run reconciliation" or `entry-format.md` append-command
section, and no instruction to create `worklog/` or today's file by hand;
its run loop's opening step and its per-message write step shall use
`bob worklog list` / `bob worklog append`.

AC-2: The `email-triage` `SKILL.md` "Tool usage" section and frontmatter /
intro delegation list shall describe only `bash` invocations of
`bob worklog append` / `bob worklog list` for diary mechanics — no `read`
of `worklog/*.md`, no `cat`/`test`/`mkdir` shell calls, and no claim that
the `worklog` skill owns first-run detection or reconciliation.

AC-3: WHERE `SKILL.md` step 3 or step 4 describes retrying a carried-forward
blocked action THE SYSTEM SHALL name the carried-forward set reported by
`bob worklog list` at the start of a run as the retry trigger, not a
"first-run reconciliation".

AC-4: The `references/worklog.md` and `references/escalation.md` worklog
text shall describe `bob worklog` performing carry-forward on every run,
with the item-identifier definition and the email-specific open/close
causes left unchanged.

AC-5: IF any of the three edited files contains a project-internal
identifier (a spec, task, bug, or ADR number) THEN the task is not
complete.

## Dependencies

- `T-193` — the `bob worklog` surface the rewritten skill text points at
- `T-195` — rewrites the `worklog` skill (and deletes the `reconciliation.md` / `entry-format.md` sections this file cross-references), so the two stay consistent

## Files to Touch

- `the-intern/bob-skills/skills/email-triage/SKILL.md` — first-run step, four-step summary, delegation list, Tool usage, step-3/step-4 retry points and hand-creation instruction
- `the-intern/bob-skills/skills/email-triage/references/worklog.md` — delegation text realigned to the command
- `the-intern/bob-skills/skills/email-triage/references/escalation.md` — carry-forward sentence repointed to `bob worklog`

## Verification

```bash
cd the-intern/bob-skills
! grep -REn 'S-[0-9]{3}|T-[0-9]{3}|B-[0-9]{3}|ADR-[0-9]{3}|first executed run|first-run|>> worklog|mkdir -p worklog|test -f worklog' skills/email-triage/SKILL.md skills/email-triage/references/worklog.md skills/email-triage/references/escalation.md
grep -RIl 'bob worklog' skills/email-triage/
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
