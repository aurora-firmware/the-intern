---
id: T-181
title: Update repository-level references for the renamed skills package
status: pending
priority: medium
assigned-role: developer
created: '2026-08-23'
spec: S-014
---

# Update repository-level references for the renamed skills package

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

Repository-level references to the renamed package, none of which are part of
the shipped manual.

`CLAUDE.md`'s folder map names the directory and additionally describes it as the
"himalaya + email-triage pi-agent skills package", which understates what it now
holds: this is the core skill set bob supplies to every session it spawns, and it
already contains the domain-free `worklog`. The `.gitignore` carries a comment
anchored to the old path. The package's own README refers to itself by the old
name in its layout and instructions.

The README is also touched by T-178, which reduces its documented layout to a
single packaging target; this task only corrects the directory name.

## Acceptance Criteria

<!-- EARS pattern reference. Every criterion must match one pattern:
  1. Ubiquitous            — The system shall [outcome]
  2. Event-driven          — WHEN [trigger] THE SYSTEM SHALL [outcome]
  3. Unwanted-behaviour    — IF [fault] THEN THE SYSTEM SHALL [outcome]
  4. State-driven          — WHILE [state] THE SYSTEM SHALL [outcome]
  5. Optional              — WHERE [feature included] THE SYSTEM SHALL [outcome]

Examples:
  AC-1: WHEN the user submits valid credentials THE SYSTEM SHALL
        redirect to /dashboard within 200ms.
  AC-2: IF the password is incorrect THEN THE SYSTEM SHALL return 401
        and display "Invalid credentials".
  AC-3: The system shall log every authentication attempt with user id
        and outcome.
-->

AC-1: The system shall refer to the runtime skills package by its new name in
the repository folder map, the `.gitignore` comment, and the package README.
AC-2: The system shall describe the package as the core runtime skill set bob
supplies rather than as an email-specific package.
AC-3: The system shall leave the tracked-path behaviour of `.gitignore`
unchanged.

## Dependencies

- `T-179` — the package must already live at its new path, and it carries the README through the move.

## Files to Touch

- `CLAUDE.md` — folder map entry and its description.
- `.gitignore` — the comment anchored to the old package path.
- `the-intern/bob-skills/README.md` — self-references to the old directory name.

## Verification

```bash
! grep -n "email-skills" CLAUDE.md .gitignore the-intern/bob-skills/README.md
git check-ignore -v the-intern/bob-skills/.pi/skills 2>&1 | grep -q . && exit 1 || true
```

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

### Session 1 — 2026-08-24
Updated the repository-level references for the renamed runtime skills package in the three scoped files: the folder map in `CLAUDE.md`, the anchored comment in `.gitignore`, and the self-references and deployment examples in `the-intern/bob-skills/README.md`. I also rewrote the high-level description so the package is described as bob's core runtime skill set rather than as an email-only package.

I kept the change narrowly documentation-only and did not alter the ignore pattern itself, only the comment that explains why `/.pi` remains ignored while `the-intern/bob-skills/.pi/skills` stays tracked. Verification used the task's exact commands: `grep` confirmed no `email-skills` references remained in the three scoped files, and `git check-ignore` confirmed the tracked-path behavior for `the-intern/bob-skills/.pi/skills` stayed unchanged.

Nothing remains for implementation; next is reviewer validation and integration if it passes.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->
