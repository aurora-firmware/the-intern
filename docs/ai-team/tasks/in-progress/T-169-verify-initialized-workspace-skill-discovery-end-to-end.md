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

### Session 1 — 2026-08-12
Added `crates/bob/tests/init_e2e.rs`. The tests use isolated XDG/runtime paths, run real `bob init`, verify shared skills under `$XDG_DATA_HOME/bob/skills` and no workspace `.pi/skills`, parse the generated policy to verify exactly the four bootstrap tools and default-deny for an unsupported tool, then require real `pi`, start `bob serve` with the real extension fixture, and capture PTY-driven `bob chat` until its `[Skills]` banner proves all three shared skills are discovered.

Managed-sandbox socket binding is denied as documented, so the live test runs outside the sandbox. The final `cargo test -p bob --test init_e2e -- --nocapture` passed with two tests after correcting the PTY `script` invocation to capture and flush the transcript before timeout. No mock runner or workspace-local skill fixture was introduced.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->

### Review Verdict — 2026-08-12
PASS

Stage 1 passed. `the-intern/service/crates/bob/tests/init_e2e.rs` adds an isolated-XDG `bob init` E2E that asserts the shared skill install path is created, the workspace has no `.pi/skills` tree, the generated policy admits exactly `bash`, `read`, `write`, and `edit` while denying an unsupported tool, and the initialized workspace's live chat banner advertises the shared `email-triage`, `himalaya`, and `worklog` skills. The tests call the real `pi --version` prerequisite first and fail with a prerequisite message instead of substituting a mock runner.

Stage 2 passed. The change is scoped to the allowed test file, the assertions are aligned with the delivered `bob init` and skill-discovery behavior, and the task verification command `cargo test -p bob --test init_e2e -- --nocapture` passed on the submitted task branch outside the sandbox as required for the socket-based live test.
