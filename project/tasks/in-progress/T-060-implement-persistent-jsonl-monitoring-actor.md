---
id: T-060
title: Implement persistent JSONL monitoring actor
status: pending
priority: high
assigned-role: unassigned
created: '2026-05-20'
spec: S-005
---

# Implement persistent JSONL monitoring actor

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

Phase 2 of S-005. Turn the `monitoring` crate from a `NotImplemented`
scaffold into the subsystem owner for audit behaviour.

Implement a Monitoring actor/handle that accepts canonical audit inputs,
appends accepted `AuditRecord`s to a persistent JSONL file, flushes on shutdown,
and fans records out to live subscribers. Tail visibility filters affect only
subscriber delivery; every accepted record is still appended to disk. Keep the
storage intentionally simple: one serialized JSON object per line, no SQLite,
no point queries, no rotation.

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

AC-1: WHEN Monitoring accepts an audit record THE SYSTEM SHALL append exactly one JSON object line to the configured JSONL audit file.
AC-2: WHEN a live tail subscriber is registered with filters THE SYSTEM SHALL deliver future matching records to that subscriber and suppress non-matching records from that subscriber.
AC-3: WHEN a record kind is hidden by tail filters THE SYSTEM SHALL still append that record to the JSONL audit file.
AC-4: IF the audit file cannot be opened or appended THEN THE SYSTEM SHALL return a typed service error instead of acknowledging the record.
AC-5: WHEN the Monitoring actor shuts down after accepting records THE SYSTEM SHALL flush the JSONL writer before the actor exits.

## Dependencies

- `T-059` — provides the canonical audit record, report, and filter domain types.

## Files to Touch

- `the-intern/service/crates/monitoring/src/lib.rs` — implement the actor, handle methods, JSONL append store, tail subscription registry, and unit tests.
- `the-intern/service/crates/monitoring/Cargo.toml` — add any direct dependencies needed by the monitoring crate, such as `serde_json` or test-only helpers.

## Verification

```bash
cd the-intern/service
cargo test -p monitoring
cargo clippy -p monitoring --all-targets
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
