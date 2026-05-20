---
id: T-062
title: Add report.submit admin-RPC facade
status: pending
priority: high
assigned-role: unassigned
created: '2026-05-20'
spec: S-005
---

# Add report.submit admin-RPC facade

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

Phase 3 of S-005, report half. Add the `report.submit` Admin-RPC method as a
thin facade over the Monitoring handle.

`report.submit` is served over the existing `admin.sock`, so it relies on the
existing filesystem permission and peer-credential gate for authentication. The
method must accept only the bob-defined external report shape from T-059,
delegate validation and append to Monitoring, and return a success response only
after Monitoring accepts the report. Wire the Monitoring handle from
`bob::serve` into Admin-RPC so the method is reachable end to end. Do not
introduce `report.sock` and do not accept free-form metadata.

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

AC-1: WHEN `report.submit` is dispatched with a valid report and a Monitoring handle is configured THE SYSTEM SHALL delegate the report to Monitoring and return a JSON-RPC success response.
AC-2: IF `report.submit` contains malformed params or unknown report fields THEN THE SYSTEM SHALL return a JSON-RPC invalid-request error and not append a record.
AC-3: WHERE no Monitoring handle is configured THE SYSTEM SHALL return the existing `NotImplemented` style JSON-RPC error.
AC-4: The system shall document in the admin-rpc method table that `report.submit` uses the existing admin socket peer gate.

## Dependencies

- `T-060` — provides the Monitoring handle method used to submit reports.
- `T-061` — wires the real Monitoring actor into `bob serve`.

## Files to Touch

- `the-intern/service/crates/admin-rpc/src/dispatch.rs` — add the `report.submit` method arm, params parsing, response/error mapping, and unit tests.
- `the-intern/service/crates/admin-rpc/src/lib.rs` — add an optional Monitoring handle to `Config` and wire it into `Dispatcher`.
- `the-intern/service/crates/admin-rpc/Cargo.toml` — add the `monitoring` crate dependency if needed for the handle type.
- `the-intern/service/crates/bob/src/serve.rs` — pass the Monitoring handle into the Admin-RPC config at startup.

## Verification

```bash
cd the-intern/service
cargo test -p admin-rpc report_submit
cargo test -p bob serve::tests
cargo clippy -p admin-rpc --all-targets
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
