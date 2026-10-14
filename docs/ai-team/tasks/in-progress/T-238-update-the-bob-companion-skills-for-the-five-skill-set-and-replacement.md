---
id: T-238
title: Update the bob-companion skills for the five-skill set and replacement
status: in-progress
priority: medium
assigned-role: developer
created: '2026-10-13'
---

# Update the bob-companion skills for the five-skill set and replacement

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

Update the `bob-companion` Claude Code plugin where it describes the
installed skill set or the skill refresh, so operators using it get the
CR-016 behaviour (CR-016 item 8 — the plugin keeps its own four skills; only
its descriptions of bob change).

- `the-intern/bob-companion/claude/skills/bob-setup/SKILL.md` (~line 87): the
  shared skills `bob init` installs are now five, including
  `the-intern-docs` (answers questions about bob from the installed manual);
  a zip install asks before overwriting an existing install, `-y` skips the
  prompt, and the default skill folder is replaced as a whole on every
  install (local edits are not kept); non-zip upgrades refresh with
  `bob init --skills-only --force`.
- `the-intern/bob-companion/claude/skills/bob-cli/references/command-reference.md`:
  its `bob init` entry (~lines 14–15) lists four skills "at
  `skill_install_path`" — list five. It has no `--skills-only` entry: add a
  `bob init --skills-only [--force]` entry stating it installs at the default
  skill install path resolved from the environment, never follows a
  `skill_install_path` override, and keeps per-file semantics (`--force`
  replaces existing files).
Do not add, remove or rename companion skills. No internal IDs; follow
`docs/ai-team/docs/coding-guidelines-skills.md`.

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

AC-1: The `bob-setup` skill and the `bob-cli` command reference's `bob init`
      entry shall each name five installed bob skills, including
      `the-intern-docs`.
AC-2: The `bob-setup` skill shall describe the install prompt, `-y`, the
      whole-folder replacement, and the non-zip refresh command.
AC-3: The `bob-cli` command reference shall contain a `bob init --skills-only
      [--force]` entry stating the environment-resolved default path, that a
      `skill_install_path` override is not followed, and its per-file
      semantics.
AC-4: The changed companion files shall contain no internal
      task/bug/spec/ADR/issue IDs.

## Dependencies

- `T-236` — final `install.sh` behaviour the companion describes

## Files to Touch

- `the-intern/bob-companion/claude/skills/bob-setup/SKILL.md` — skill set and install behaviour
- `the-intern/bob-companion/claude/skills/bob-cli/references/command-reference.md` — `--skills-only` path resolution

## Verification

```bash
grep -n "the-intern-docs\|skills-only" the-intern/bob-companion/claude/skills/bob-setup/SKILL.md the-intern/bob-companion/claude/skills/bob-cli/references/command-reference.md
! grep -nE "\b(T|B|S|CR)-[0-9]{3}\b|ADR-[0-9]{3}" the-intern/bob-companion/claude/skills/bob-setup/SKILL.md the-intern/bob-companion/claude/skills/bob-cli/references/command-reference.md
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
