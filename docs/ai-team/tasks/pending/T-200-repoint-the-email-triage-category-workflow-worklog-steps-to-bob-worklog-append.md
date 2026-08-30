---
id: T-200
title: Repoint the email-triage category workflow worklog steps to bob worklog 
  append
status: pending
priority: medium
assigned-role: developer
created: '2026-08-30'
---

# Repoint the email-triage category workflow worklog steps to bob worklog append

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

Component 4 tail: the six `email-triage` category workflow files each carry
a `## Worklog entry` paragraph that still prescribes the hand-run diary
recipe, which T-195/T-196 remove and T-198 stops admitting. Repoint each at
`bob worklog append`. One mechanical edit per file; classification signals,
category matching, and act-or-escalate logic stay untouched.

Files (`the-intern/bob-skills/skills/email-triage/references/categories/`):
`automated-notification.md`, `direct-request.md`, `meeting-scheduling.md`,
`newsletter-bulk.md`, `self-escalation.md`, `suspected-spam.md`.

In each, the `## Worklog entry` paragraph reads "Append one entry to
today's worklog file in the format `references/worklog.md` defines
(creating `worklog/` and today's file first if either is missing, per that
reference; …)". Rewrite it to "Append one entry with `bob worklog append`
(see `references/worklog.md`)" — drop the by-hand creation parenthetical,
keep whatever category-specific guidance follows about what the entry's
`Done`/`Left`/`Next` should say.

`automated-notification.md` additionally states (~L30–L32) that this
category "does not close via a manager reply … so it is not carried forward
at first-run reconciliation": reword to "… so `bob worklog` does not carry
it forward" (a fully-handled entry with `Left: nothing` is closed by the
command's own open test — the meaning is preserved).

Keep all six files free of this project's internal identifiers.

## Acceptance Criteria

AC-1: Each of the six category files' `## Worklog entry` paragraph shall
instruct appending the entry with `bob worklog append` and shall not
instruct creating `worklog/` or today's file by hand.

AC-2: The `automated-notification.md` carry-forward sentence shall describe
`bob worklog` not carrying a fully-handled item forward, with no reference
to "first-run reconciliation".

AC-3: The system shall leave each file's category matching signals,
classification guidance, and act-or-escalate instructions unchanged.

AC-4: IF any of the six files contains a project-internal identifier (a
spec, task, bug, or ADR number) THEN the task is not complete.

## Dependencies

- `T-196` — establishes the `email-triage` skill's `bob worklog` surface and the `references/worklog.md` these files point at

## Files to Touch

- `the-intern/bob-skills/skills/email-triage/references/categories/automated-notification.md`
- `the-intern/bob-skills/skills/email-triage/references/categories/direct-request.md`
- `the-intern/bob-skills/skills/email-triage/references/categories/meeting-scheduling.md`
- `the-intern/bob-skills/skills/email-triage/references/categories/newsletter-bulk.md`
- `the-intern/bob-skills/skills/email-triage/references/categories/self-escalation.md`
- `the-intern/bob-skills/skills/email-triage/references/categories/suspected-spam.md`

## Verification

```bash
cd the-intern/bob-skills
! grep -REn 'S-[0-9]{3}|T-[0-9]{3}|B-[0-9]{3}|ADR-[0-9]{3}|first-run|creating .worklog/. and today' skills/email-triage/references/categories/
grep -REl 'bob worklog append' skills/email-triage/references/categories/ | wc -l   # expect 6
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
