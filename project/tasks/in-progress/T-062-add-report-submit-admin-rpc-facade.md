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

### Session 1 — 2026-05-20

Implemented the `report.submit` Admin-RPC facade in a single TDD cycle covering all four acceptance criteria.

Added `monitoring` (plus `chrono` and `uuid`) as dependencies of `admin-rpc`. Extended `Dispatcher` with an optional `monitoring::Handle` field and updated its constructor signature; all existing call sites updated. Added `handle_report_submit` which enforces the `ExternalReportAuditPayload` shape via `deny_unknown_fields`, generates a UUID record-id and RFC 3339 timestamp, and delegates to `monitoring::Handle::append_record`. Added the `report.submit` dispatch arm. Extended the module-level method table with an "Auth gate" column noting all methods use the existing admin socket peer gate (AC-4). Added `monitoring: Option<monitoring::Handle>` to `admin_rpc::Config` and threaded the monitoring handle from `bob::serve::try_start_subsystems` into the config.

Five new tests cover: valid report with handle returns `{ ok: true }` (AC-1); unknown field, missing required field, and absent params each return -32602 (AC-2); absent handle returns -32601 (AC-3). All 87 admin-rpc tests and all 18 bob serve tests pass; clippy is clean.

One naming collision resolved: `bob_core::types::AuditRecord` clashes with `crate::subscriptions::AuditRecord`; resolved by aliasing the bob_core import as `MonitoringAuditRecord` at the import site in `dispatch.rs`. Using `chrono` for timestamps was chosen over `SystemTime` to stay consistent with the existing pattern in `requests-handler`.

Verification (run from `the-intern/service`):
- `cargo test -p admin-rpc report_submit` — 5 passed, 0 failed.
- `cargo test -p bob serve::tests` — 18 passed, 0 failed.
- `cargo clippy -p admin-rpc --all-targets` — clean, no warnings.
- Git evidence: `010052a feat(admin-rpc): add report.submit facade over monitoring handle`.

Nothing remains; all ACs are covered.

Obstacles Encountered:
- `bob_core::types::AuditRecord` and `crate::subscriptions::AuditRecord` share the same name. Resolved by aliasing the bob_core type as `MonitoringAuditRecord` in the import statement — no functional change required.
- `ExternalReportAuditPayload` has `session_id` at both the payload level and the `AuditRecord` envelope level. The facade promotes the caller-supplied `session_id` to the envelope and sets the inner payload's `session_id` to `None`, matching the conventions visible in existing test fixtures.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->
