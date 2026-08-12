---
id: T-169
title: Verify initialized workspace skill discovery end to end
status: pending
priority: high
assigned-role: unassigned
created: '2026-08-12'
---

# Verify initialized workspace skill discovery end to end

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

Add an isolated integration test for the delivered `bob init` path. It must
exercise the command with isolated XDG paths, prove the shared skill package is
installed and absent from the workspace, then start bob and demonstrate that a
session in the initialized workspace discovers the shared supplied skills.
Use the existing real-pi prerequisite and established shell/E2E harnesses; do
not introduce a fake process runner or bypass pi when it is unavailable.

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

AC-1: WHEN the E2E test runs with isolated XDG directories THE SYSTEM SHALL
run `bob init` and assert the shared install path exists while the workspace
has no `.pi/skills` directory.
AC-2: WHEN the test starts bob and opens a session in the initialized workspace
THE SYSTEM SHALL verify that the shared `himalaya`, `email-triage`, and
`worklog` skills are discoverable.
AC-3: The system shall verify that the generated config admits exactly the four
bootstrap tools and keeps an unsupported tool denied.
AC-4: IF the real `pi` prerequisite is unavailable THEN THE SYSTEM SHALL stop
and report the prerequisite failure rather than substitute a mock runner.

## Dependencies

- `T-167` — CLI command and filesystem-only dispatch.

## Files to Touch

- `the-intern/service/crates/bob/tests/init_e2e.rs` — isolated-XDG init and live skill-discovery coverage.
- `the-intern/service/crates/bob/tests/shell_e2e.rs` — shared test-harness support if required.

## Verification

```bash
cargo test -p bob --test init_e2e -- --nocapture
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
