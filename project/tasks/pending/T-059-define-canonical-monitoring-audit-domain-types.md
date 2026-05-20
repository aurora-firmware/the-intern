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

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->
