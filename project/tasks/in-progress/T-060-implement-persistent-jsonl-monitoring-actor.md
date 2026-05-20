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

### Session 1 — 2026-05-20

Implemented T-060 in the `monitoring` crate with three incremental commits. First, I replaced the scaffold with a typed actor/handle that accepts canonical `AuditRecord` values and appends them to a configured JSONL file as one serialized object per line. The write path now uses typed `ServiceError::Persistence` failures when the audit file cannot be opened or written. I also updated `MonitoringAuditSink` to forward canonical records directly to the actor instead of stringifying legacy event placeholders.

Second, I added live tail subscriber support in the actor using a subscription registry and per-subscriber `AuditFilterKind` filters. Delivery now applies filters only to live fan-out, while persistence remains unconditional. Tests cover that subscriptions receive only future matching records and that non-matching records are suppressed for that subscriber.

Third, I added explicit tests for the two remaining acceptance criteria: open failure returns a typed error, and buffered audit lines are flushed during actor shutdown. I intentionally validated flush behavior by asserting the file is empty before shutdown and non-empty after dropping the handle and awaiting actor exit. I briefly tried running two test names in one `cargo test` command and rejected it after Cargo reported an unexpected argument; I then ran targeted tests individually. Remaining work on this branch: none; verification commands are passing and the task is ready for reviewer handoff.

Obstacles Encountered:
- `cargo test` with two test-name filters in one command failed (`unexpected argument ...`); resolved by running targeted tests separately.
- No sandbox/escalation blockers encountered.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->

### Review Verdict — 2026-05-20
PASS

Stage 1 (acceptance criteria and scope): PASS.
- AC-1 met: accepted records are serialized and written as one JSON line per append path in `monitoring::Actor::append_record`, and covered by `append_record_writes_one_json_object_line_to_audit_file`.
- AC-2 met: filtered live subscriptions receive only future matching records and suppress non-matching records, covered by `subscribe_tail_delivers_only_future_matching_records`.
- AC-3 met: filtered-out kinds are still persisted to JSONL before fan-out filtering, covered by `filtered_out_records_are_still_appended_to_jsonl`.
- AC-4 met: file open/append failures return typed `ServiceError::Persistence`, covered by `append_record_returns_typed_error_when_audit_file_cannot_be_opened`.
- AC-5 met: actor flushes the buffered writer on shutdown in `Actor::run`, covered by `actor_flushes_buffered_audit_records_on_shutdown`.
- Scope check: expected files were updated in the monitoring crate; `the-intern/service/Cargo.lock` changed as dependency lockfile churn.

Stage 2 (code quality): PASS.
- Correctness, tests, security, readability, and performance checks passed for task scope.
- Verification rerun by reviewer on `task/T-060-implement-persistent-jsonl-monitoring-actor`:
  - `cargo test -p monitoring`
  - `cargo clippy -p monitoring --all-targets`
