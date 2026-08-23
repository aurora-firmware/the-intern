---
id: T-178
title: Remove the claude packaging target from the runtime skills package
status: pending
priority: high
assigned-role: developer
created: '2026-08-23'
spec: S-014
---

# Remove the claude packaging target from the runtime skills package

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

CR-011 removes the Claude packaging target from the runtime skills package. It
was built to demonstrate that one canonical source could feed two vendors
without duplicating content, but no consumer ever appeared, and carrying it
through the package rename and the fourth skill S-014 adds would mean
maintaining generated output nobody installs.

Delete the generated `claude/` tree, the script that generates it, and the test
that verifies it. The package README documents a two-target layout in both its
directory map and its packaging instructions; reduce both to the pi target.

Do **not** touch `the-intern/bob-companion/claude/`. Despite the similar path
that is the hand-written Claude Code plugin for operating bob, with a different
audience, and it is unrelated to this package. Do not touch the canonical
`skills/` source, the generated `.pi/skills/` target, `package-pi-skills.sh`, or
its test: the canonical-source layer is deliberately kept so that adding a
second vendor target later stays cheap.

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

AC-1: The system shall contain no `claude/` packaging tree, no
`package-claude-skills.sh`, and no `test_package_claude_skills.sh` under the
runtime skills package.
AC-2: The system shall describe a single pi packaging target in the package
README's directory map and packaging instructions.
AC-3: WHEN the pi packaging script is run THE SYSTEM SHALL regenerate the pi
target and pass its test unchanged.
AC-4: The system shall leave `the-intern/bob-companion/` unmodified.

## Dependencies

- None.

## Files to Touch

- `the-intern/email-skills/claude/` — delete the generated tree.
- `the-intern/email-skills/package-claude-skills.sh` — delete.
- `the-intern/email-skills/test_package_claude_skills.sh` — delete.
- `the-intern/email-skills/README.md` — reduce the documented layout to one target.

## Verification

```bash
test ! -e the-intern/email-skills/claude
test ! -e the-intern/email-skills/package-claude-skills.sh
test ! -e the-intern/email-skills/test_package_claude_skills.sh
! grep -q "package-claude-skills" the-intern/email-skills/README.md
./the-intern/email-skills/test_package_pi_skills.sh
test -z "$(git status --porcelain the-intern/bob-companion)"
```

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

### Session 1 — 2026-08-23

Removed the generated runtime Claude packaging tree, its generator and test, and
updated the runtime package README to document the pi target only. The unrelated
`the-intern/bob-companion/` plugin was left unchanged. The empty `claude/`
directory chain remained after tracked-file deletion, so it was removed
explicitly. The implementation is committed on
`task/T-178-remove-the-claude-packaging-target` as `644e731`.

Verification passed: the Claude tree/script/test are absent, the README no
longer references `package-claude-skills`, `./test_package_pi_skills.sh` passes,
the companion plugin is clean, and `git diff --check` passes. No work remains.

Obstacles encountered: unrelated untracked
`.github/workflows/__pycache__/` was preserved.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->
