---
id: T-059
title: Define canonical monitoring audit domain types
status: pending
priority: high
assigned-role: unassigned
created: '2026-05-20'
spec: S-005
---

# Define canonical monitoring audit domain types

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

Phase 1 of S-005. Replace the old generic audit/report placeholders in
`bob-core` with the canonical Monitoring audit model.

Define a shared `AuditRecord` envelope with a stable id, timestamp, `kind`,
optional `SessionId`, and a kind-specific payload. The initial record kinds are
`event`, `report`, and `verdict`; CLI/config filters use the plural spellings
`events`, `reports`, and `verdicts`. External reports must use only
bob-defined structured fields: tool/action name, outcome status, optional
session id, and optional summary. Do not add arbitrary metadata. Preserve serde
round-trip tests and keep the domain types runtime-agnostic.

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

AC-1: The system shall define a serde-serializable `AuditRecord` envelope that carries a stable id, timestamp, `AuditRecordKind`, optional session id, and kind-specific payload.
AC-2: The system shall define audit payloads for extension events, policy verdicts, and external reports using only bob-defined structured fields.
AC-3: WHEN an audit filter is parsed from CLI/config text THE SYSTEM SHALL accept `events`, `reports`, and `verdicts` and reject unknown values.
AC-4: IF an external report payload contains arbitrary metadata outside the bob-defined report shape THEN THE SYSTEM SHALL fail deserialization or validation.
AC-5: The system shall preserve serde JSON round-trip coverage for every audit record kind and filter kind.

## Dependencies

- None.

## Files to Touch

- `the-intern/service/crates/bob-core/src/types/records.rs` — replace the old audit/report placeholders with the S-005 audit envelope, payload, report, and filter types.
- `the-intern/service/crates/bob-core/src/types/mod.rs` — re-export any new audit domain types.
- `the-intern/service/crates/bob-core/src/ports.rs` — update test/stub imports only if the renamed audit types require it.

## Verification

```bash
cd the-intern/service
cargo test -p bob-core
```

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

### Session 1 — 2026-05-20

Implemented Phase 1 canonical monitoring audit domain types in `bob-core` using TDD in two red→green→refactor cycles. First cycle replaced the legacy audit placeholders with a canonical `AuditRecord` envelope (`id`, `timestamp`, `kind`, optional envelope `session_id`, and typed payload) plus structured payload types for extension events, policy verdicts, and external reports. I kept `PolicyVerdict` for existing policy interfaces and updated the `ports.rs` test fixture to the new `AuditRecord` shape. Second cycle added `AuditFilterKind` parsing for CLI/config values (`events`, `reports`, `verdicts`) with a typed parse error, added tests for unknown filter rejection, and added a deserialization test ensuring arbitrary report metadata is rejected. I considered leaving report payloads open for future metadata, but rejected that because S-005 and AC-4 explicitly require rejecting unstructured metadata now. Remaining work: none in this task branch; ready for reviewer handoff.

Evidence:
- Red step (cycle 1) failing test run:
  - `cargo test -p bob-core types::records::tests::audit_record_envelope_supports_kind_specific_payloads` (failed with missing canonical types/fields)
- Green/refactor checks (cycle 1):
  - `cargo test -p bob-core types::records::tests::audit_record_envelope_supports_kind_specific_payloads`
  - `cargo test -p bob-core types::records`
  - `cargo fmt -p bob-core`
- Red step (cycle 2) failing test run:
  - `cargo test -p bob-core types::records::tests::audit_filter_kind_from_str_accepts_plural_cli_values` (failed with missing `AuditFilterKind`)
- Green/refactor checks (cycle 2):
  - `cargo test -p bob-core types::records::tests::`
  - `cargo test -p bob-core ports::tests::audit_sink_append_returns_service_result`
  - `cargo fmt -p bob-core`
- Task verification:
  - `cd the-intern/service && cargo test -p bob-core` (pass, run with escalation due sandbox socket permission behavior)

Obstacles Encountered:
- `cargo test -p bob-core` fails inside sandbox on `peer_cred_from_fd_returns_current_process_uid_on_real_socket` (`Operation not permitted` on socket bind); resolved by rerunning verification with escalated permissions.
- Initial `git add`/`git commit` failed in sandbox due `.git/index.lock` read-only restriction; resolved via escalated git commands.

### Session 2 — 2026-05-20

Implemented the reviewer-requested AC-5 fix by adding explicit full `AuditRecord` serde JSON round-trip tests for both `AuditRecordPayload::Event` and `AuditRecordPayload::Verdict`, while preserving and renaming the existing `Report` round-trip test. I refactored these into a shared `assert_audit_record_round_trip` helper that validates envelope fields (`id`, `timestamp`, `kind`, `session_id`) and payload equality end-to-end so each record kind is now covered as a full record, not only as enum/value-level serialization.

I initially tried invoking `cargo test` with two separate test-name arguments, but rejected that approach after Cargo reported an unexpected extra argument; I switched to a single filter (`audit_record_`) for targeted validation. I also considered adding only payload-level round-trip assertions, but rejected that because the reviewer finding explicitly requires full `AuditRecord` envelope round-trip coverage by record kind.

What remains: nothing for this reviewer finding; task branch is ready for reviewer re-check.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->

### Review Verdict — 2026-05-20
FAIL

- **File and location**: `the-intern/service/crates/bob-core/src/types/records.rs` (tests around `audit_record_envelope_supports_kind_specific_payloads`, lines 157-187 on the task branch).
  **What is wrong**: AC-5 requires serde JSON round-trip coverage for every audit record kind and filter kind. Current tests only round-trip a full `AuditRecord` for the `report` payload path; `event` and `verdict` payload record variants are not round-tripped as records.
  **What should change**: Add serde round-trip tests that build and round-trip full `AuditRecord` values for `AuditRecordPayload::Event` and `AuditRecordPayload::Verdict` (in addition to existing `Report`) so every record kind is covered end-to-end.
