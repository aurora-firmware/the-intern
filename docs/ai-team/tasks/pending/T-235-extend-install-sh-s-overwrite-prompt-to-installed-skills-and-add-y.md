---
id: T-235
title: Extend install.sh's overwrite prompt to installed skills and add -y
status: pending
priority: medium
assigned-role: developer
created: '2026-10-13'
---

# Extend install.sh's overwrite prompt to installed skills and add -y

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

Extend `install.sh`'s existing-install confirmation to installed skills and
add a `-y` argument (CR-016 item 4; S-013 v0.4 Component 3, Design
Principles, Exclusions, Phase 6; ADR-017 §2, §4, §5). This task covers the
check-and-prompt phase only; replacing the skill folder is T-236.

Before writing anything, `install.sh` decides whether an installation exists:
a binary at `~/.local/bin/bob`, OR any entry at all in the default skill
install path. Add a skill-path resolver next to `resolve_extension_path`:
`$XDG_DATA_HOME/bob/skills` (absolute `XDG_DATA_HOME` only, as today), else
the platform default — `~/.local/share/bob/skills` on Linux,
`~/Library/Application Support/bob/skills` on macOS. "Any entry" includes
dotfiles and a dangling symlink at `bob/skills` (`-e || -L`). If one
exists, it asks once to overwrite (today's binary prompt, extended). Answering
anything but yes aborts with no binary, extension or skill written. Warnings
printed before the prompt:
- installed binary differs from the bundled one (byte comparison; a
  comparison that cannot complete counts as different): a different bob
  version is installed, and the installed skills (the documentation skill
  included) and the extension will be replaced and may differ from what is
  there now, including local edits;
- skills installed but no binary: the existing skills will be replaced;
- identical binaries: no warning, prompt only.
Fresh install (no binary, empty or absent skill path): no prompt. `-y`
answers yes to the prompt (warnings still printed). Without `-y` and with no
input available, abort with no changes (existing behaviour). `install.sh`
reads no config. Add tests in `test-install.sh` for each case.

Test isolation (binding): `test-install.sh` isolates `HOME` but inherits
`XDG_DATA_HOME` (e.g. ~lines 88, 134, 400, 426). Make every `install.sh` run
in it — existing and new — set `XDG_DATA_HOME` explicitly (`env -u
XDG_DATA_HOME` or a path under `$tmp_dir`), so the suite can never touch the
developer's real data directory once T-236 empties the skill folder.

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

AC-1: WHEN a binary exists at `~/.local/bin/bob` OR the default skill install
      path holds any entry THE SYSTEM SHALL prompt to overwrite before
      writing anything.
AC-2: IF the operator answers anything but yes, or no input is available
      without `-y`, THEN THE SYSTEM SHALL exit non-zero leaving the binary,
      extension and skill install path unchanged.
AC-3: WHEN the installed binary differs from the bundled one (or cannot be
      compared) THE SYSTEM SHALL print the different-version warning before
      the prompt; WHEN skills exist without a binary THE SYSTEM SHALL print
      the skills-will-be-replaced warning; WHEN the binaries are identical
      THE SYSTEM SHALL print no warning.
AC-4: WHERE `-y` is given THE SYSTEM SHALL proceed without prompting and still
      print the applicable warning.
AC-5: WHEN neither a binary nor any entry (dotfiles and dangling symlinks
      included) in the skill install path exists THE SYSTEM SHALL install
      without prompting; and every `install.sh` run in `test-install.sh`
      shall set `XDG_DATA_HOME` explicitly.

## Dependencies

- None

## Files to Touch

- `the-intern/install-bundle/install.sh` — argument parsing (`-y`), installation detection, binary comparison, warnings, prompt
- `the-intern/install-bundle/test-install.sh` — cases for each AC

## Verification

```bash
bash the-intern/install-bundle/test-install.sh
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
