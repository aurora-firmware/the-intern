---
id: T-188
title: Update the companion plugin for bob task and the new workspace layout
status: pending
priority: medium
assigned-role: developer
created: '2026-08-23'
spec: S-014
---

# Update the companion plugin for bob task and the new workspace layout

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

The bob-companion plugin's account of the CLI and of the workspace `bob init`
produces both go stale.

`bob-cli` names the subcommand set in its frontmatter description and again in
its opening paragraph, and needs `task` added to both, with a flag-by-flag
section in its command reference alongside the existing subcommands. That
reference's `bob init` section and the `bob-setup` skill each enumerate the
workspace files and the installed skill package by name; both gain the board
directory and the fourth skill.

No new skill is added. S-014 places the command's operating instructions in the
skill bob supplies through its extension, so that any session bob spawns can use
the command regardless of what tooling an operator happens to run. The companion
plugin records that the subcommand exists and how to drive it; it does not become
a second account of how to use the board.

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

AC-1: The system shall list `task` among the bob subcommands in the `bob-cli`
skill's description and body.
AC-2: The system shall document every `bob task` subcommand and its flags in the
companion command reference.
AC-3: The system shall describe the workspace `bob init` produces as including
the board directory and the fourth installed skill, in both places that layout is
enumerated.
AC-4: The system shall add no new skill directory to the companion plugin.

## Dependencies

- `T-185` — the documented command surface must be final.
- `T-187` — the documented workspace layout must be final.

## Files to Touch

- `the-intern/bob-companion/claude/skills/bob-cli/SKILL.md` — subcommand list in the description and body.
- `the-intern/bob-companion/claude/skills/bob-cli/references/command-reference.md` — a `bob task` section, and the `bob init` layout.
- `the-intern/bob-companion/claude/skills/bob-setup/SKILL.md` — the workspace layout and installed skill set.

## Verification

```bash
grep -q "bob task" the-intern/bob-companion/claude/skills/bob-cli/SKILL.md
grep -q "bob task" the-intern/bob-companion/claude/skills/bob-cli/references/command-reference.md
grep -q "tasks/" the-intern/bob-companion/claude/skills/bob-setup/SKILL.md
test "$(ls the-intern/bob-companion/claude/skills | wc -l)" -eq 4
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
