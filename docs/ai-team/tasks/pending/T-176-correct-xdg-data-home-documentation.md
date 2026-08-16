---
id: T-176
title: Correct XDG data-home documentation
status: pending
priority: medium
assigned-role: developer
created: '2026-08-16'
spec: S-013
---

# Correct XDG data-home documentation

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

Correct the XDG data-home resolution wording left stale after CR-008/S-013.
The extension resolver in `config.rs` and `install.sh` treats an unset or empty
`XDG_DATA_HOME` as the platform default, honors a non-empty absolute value, and
rejects a non-empty relative value. Document those cases in the operator and
extension-author guides.

The shared skill resolver intentionally differs under ADR-014/S-002: it falls
back to the platform default for unset, empty, or relative values, and honors
only a non-empty absolute value. The operator guide must describe that behavior
without claiming it resolves identically to `extension_path`.

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

AC-1: THE SYSTEM SHALL document the extension path's unset-or-empty default,
      non-empty absolute override, and non-empty relative-value rejection in
      both the operator guide and extension-author guide.
AC-2: THE SYSTEM SHALL document the skill install path's deliberate fallback for
      unset, empty, or relative `XDG_DATA_HOME`, and its non-empty absolute override.
AC-3: THE SYSTEM SHALL not state that `skill_install_path` resolves identically to
      `extension_path` for all `XDG_DATA_HOME` values.

## Dependencies

- None

## Files to Touch

- `the-intern/docs/src/operator-guide/index.md` — correct extension and skill XDG wording
- `the-intern/docs/src/extension-author-guide/index.md` — correct extension XDG wording

## Verification

```bash
cd the-intern/docs && mdbook build
rg -n "unset|empty|absolute|relative" src/operator-guide/index.md src/extension-author-guide/index.md
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
