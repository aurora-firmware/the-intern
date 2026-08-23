---
id: T-186
title: Add the canonical tasks skill and deliver it to the pi package
status: pending
priority: medium
assigned-role: developer
created: '2026-08-23'
spec: S-014
---

# Add the canonical tasks skill and deliver it to the pi package

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

Writes the skill that teaches an agent to use the board, and delivers it through
the packaging mechanism that already exists.

The skill covers when work belongs on a board rather than in an in-session
checklist, how to write a description and a Definition of Done that another run
can pick up cold, what each status commits to — including why a blocked task
needs to say what it is waiting on and who owns it — and which subcommand
performs each move. It must **not** restate the file format as law: the command
defines the format, and skill prose that repeats it is free to drift from it.
Per S-011 the text must be intelligible without access to this repository's
specifications, decision records, tasks, or bugs.

The binary embeds the generated pi package wholesale, so the skill becomes an
embedded asset as soon as the packaging script emits it. That breaks two
exhaustive assertions in the same change: `init_assets.rs` pins the embedded
relative-path list, and `init_e2e.rs` asserts the installed skill set. Both are
updated here, not later.

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

AC-1: The system shall carry a `tasks` skill in the canonical skill source
describing when and how to use the board without defining the file format.
AC-2: WHEN the pi packaging script is run THE SYSTEM SHALL generate a `tasks`
skill tree alongside the existing three.
AC-3: The system shall assert an embedded asset list and an installed skill set
that both include the `tasks` skill.
AC-4: The system shall contain no reference to this repository's specifications,
decision records, tasks, or bugs in the skill's text.

## Dependencies

- `T-179` — the canonical source must already be at its new path.
- `T-185` — the skill describes the complete `bob task` surface, so that surface must exist.

## Files to Touch

- `the-intern/bob-skills/skills/tasks/SKILL.md` — new canonical skill (regenerate `.pi/skills/tasks/` from it).
- `the-intern/bob-skills/package-pi-skills.sh` — add the skill to the generated set.
- `the-intern/service/crates/bob/src/init_assets.rs` — extend the asserted embedded path list.
- `the-intern/service/crates/bob/tests/init_e2e.rs` — extend the asserted installed skill set.

## Verification

```bash
./the-intern/bob-skills/package-pi-skills.sh
./the-intern/bob-skills/test_package_pi_skills.sh
(cd the-intern/service && cargo test -p bob)
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
