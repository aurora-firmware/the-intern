---
id: T-175
title: Harden install-bundle overwrite and PATH checks
status: pending
priority: medium
assigned-role: developer
created: '2026-08-16'
spec: S-013
---

# Harden install-bundle overwrite and PATH checks

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

Harden `the-intern/install-bundle/install.sh` following PR-46 review findings.
When an existing binary triggers the overwrite prompt but standard input has reached
EOF, the current bare `read` exits under `set -euo pipefail` without explaining
why installation stopped. Guard that read and print a clear non-zero abort message.

Also make `path_contains_dir` recognize a non-empty PATH entry with trailing
slashes as the same directory as its target. Preserve the POSIX meaning of an
empty PATH entry (the current directory): do not normalize it into `/`.

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

AC-1: IF an existing `~/.local/bin/bob` requires overwrite confirmation and standard
      input is at EOF THEN the installer SHALL print an explanatory error and exit
      non-zero before changing either installed file.
AC-2: WHEN `PATH` contains a non-empty entry equal to `~/.local/bin` except for one
      or more trailing slashes THE SYSTEM SHALL treat that directory as present and
      SHALL not print the PATH warning.
AC-3: WHEN `PATH` contains an empty entry THE SYSTEM SHALL preserve its current-directory
      semantics while evaluating whether `~/.local/bin` is present.

## Dependencies

- None

## Files to Touch

- `the-intern/install-bundle/install.sh` — guard EOF at the overwrite prompt and
  normalize non-empty PATH entries for directory comparison

## Verification

```bash
bash -n the-intern/install-bundle/install.sh

# From an isolated temporary bundle/HOME, pre-create ~/.local/bin/bob and run
# the installer with stdin redirected from /dev/null. Assert non-zero exit,
# the explanatory message, and that neither installed file changed.
# Repeat with PATH containing "$HOME/.local/bin/" and assert no PATH warning.
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
