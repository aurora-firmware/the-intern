---
id: T-061
title: Add monitoring configuration and startup wiring
status: pending
priority: high
assigned-role: unassigned
created: '2026-05-20'
spec: S-005
---

# Add monitoring configuration and startup wiring

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

Phase 2 support for S-005. Add Monitoring configuration to bob's TOML-backed
configuration and use it when `bob serve` starts the Monitoring actor.

The config must include the JSONL audit log path and default tail visibility
kinds. If the path is omitted, bob should resolve an OS-appropriate application
state path. If the path is configured but unusable, startup must fail rather
than running without durable audit. Parent directories for the audit file must
be created with owner-only permissions where applicable. Wire
`monitoring::start` from `bob::serve` with the loaded config and preserve
existing shutdown behaviour.

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

AC-1: The system shall load a Monitoring config section containing an audit JSONL path and default tail filters from bob's layered TOML configuration.
AC-2: WHEN no audit log path is configured THE SYSTEM SHALL resolve a non-empty OS-appropriate default path.
AC-3: IF the configured audit log path cannot be opened for append THEN THE SYSTEM SHALL fail `bob serve` startup.
AC-4: WHEN `bob serve` starts subsystems THE SYSTEM SHALL pass the loaded Monitoring config into `monitoring::start`.
AC-5: WHEN Monitoring opens an audit log path with missing parent directories THE SYSTEM SHALL create the parent directories with owner-only permissions where applicable.

## Dependencies

- `T-060` — provides the Monitoring config and startup contract consumed by `bob serve`.

## Files to Touch

- `the-intern/service/crates/bob/src/config.rs` — load and validate the monitoring section and default audit log path.
- `the-intern/service/crates/bob/src/serve.rs` — start Monitoring with the loaded config and preserve shutdown flushing.
- `the-intern/service/crates/bob/tests/shell_e2e.rs` — extend startup coverage only if config/startup behaviour is not fully covered by unit tests.

## Verification

```bash
cd the-intern/service
cargo test -p bob config::tests
cargo test -p bob serve::tests
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
