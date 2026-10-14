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

### Session 1 — 2026-10-14
I updated the two bob-companion files named in the task.

- **`bob-setup` SKILL.md (init section):**
  - It now names the five shared skills: `himalaya`, `email-triage`, `tasks`, `worklog` and `the-intern-docs`. It says `the-intern-docs` answers questions about bob from the installed manual.
  - It covers the zip-install "Overwrite? [y/N]" prompt, `-y`, and the whole-folder replacement of the default skill folder on every install, so local edits are lost.
  - It says a `skill_install_path` folder is never touched by `install.sh`.
  - It gives `bob init --skills-only --force` as the non-zip refresh.
  - I took the wording from the T-236 `install-bundle/README.txt`, so it stays consistent with T-237.
- **`command-reference.md`:**
  - The `bob init` entry now lists five skills.
  - A new `bob init --skills-only [--force]` entry states that it installs skills only, takes no path, installs to the environment-resolved default path, does not follow a `skill_install_path` override, and keeps per-file semantics (`--force` replaces existing files).

The `bob init --help` text for `--skills-only` says it installs at `skill_install_path` and does not say the override is ignored; the "override never followed" statement comes from the task description and the install README and was not confirmed in the `init` source. I drafted a sentence saying files the package does not ship are not removed, and dropped it because I had not verified it.

Nothing remains for this task. I did not touch the lifecycle file or add or rename any companion skills.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->
