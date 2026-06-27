---
id: T-111
title: Align scheduler cron evaluation with local wall-clock time
status: pending
priority: medium
assigned-role: developer
created: '2026-06-27'
spec: S-009
---

# Align scheduler cron evaluation with local wall-clock time

## Description

S-009 describes cron evaluation against wall-clock time, and the operator-facing
CLI accepts standard five-field cron expressions. The current scheduler uses
`chrono::Utc::now()`, so an operator in a non-UTC timezone who schedules `12:02`
gets `12:02 UTC` instead of local wall-clock `12:02`.

Update `scheduler-adapter` so cron next-fire calculations use the host's local
wall clock. Keep five-field expressions with seconds disallowed, and keep the
existing reload, fixed-identity, and missed-submit behavior unchanged.

## Acceptance Criteria

AC-1: WHEN a cron expression names a local wall-clock minute THE SYSTEM SHALL
      compute the next occurrence using `chrono::Local`, not UTC.

AC-2: WHEN the scheduler fires a job after the local-time change THE SYSTEM
      SHALL still submit `DeliveryKind::Periodic` with the original prompt and
      request context fields.

AC-3: IF a cron expression is invalid THEN THE SYSTEM SHALL keep the existing
      behavior of logging a warning and skipping that job.

AC-4: The system shall pass the scheduler-adapter tests covering local-time cron
      calculation and the existing tick-loop behavior.

## Dependencies

- None.

## Files to Touch

- `the-intern/service/crates/scheduler-adapter/src/lib.rs` — switch next-fire
  calculation to local wall-clock time and add focused coverage.

## Verification

```bash
cd the-intern/service
cargo test -p scheduler-adapter local
cargo test -p scheduler-adapter cron_tick
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
