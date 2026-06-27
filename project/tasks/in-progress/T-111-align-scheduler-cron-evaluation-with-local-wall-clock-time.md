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

### Session 1 — 2026-06-27

**What was done.** Read the task file (Work Log was empty, first session). Read `the-intern/service/crates/scheduler-adapter/src/lib.rs` in full to understand the existing architecture: the `run_job_tick_loop` private async function that calls `Utc::now()` and passes it to `cron.find_next_occurrence()`, the five-field-only parsing (seconds disallowed), the invalid-cron-skip behavior, the fixed-identity `ChannelId`/`UserId` derivation, and the reload/shutdown signaling via the watch channel. Inspected the croner 3.0.1 source to confirm `find_next_occurrence<Tz: TimeZone>` is generic — it accepts any `DateTime<Tz>` and returns a `DateTime<Tz>` in the same timezone, computing occurrences against `naive_local()` of the supplied reference point. This means changing the argument from `DateTime<Utc>` to `DateTime<Local>` is all that's needed at the call site.

**What was done (implementation).** Changed `use chrono::Utc;` to `use chrono::Local;` and changed `let now = Utc::now();` to `let now = Local::now();` in `run_job_tick_loop`. Added a comment explaining the why. Added a focused unit test `local_time_cron_next_occurrence_is_expressed_in_local_timezone` that: parses `"* * * * *"` (the same five-field no-seconds style used in production), calls `find_next_occurrence` with `chrono::Local::now()` as the reference point, asserts the result is strictly in the future and within 60 seconds, and asserts the UTC offset of the result matches the offset of the `now_local` reference — ensuring the result is expressed in local timezone. Expectations are derived entirely from `chrono::Local` itself, so the test is timezone-independent (passes in UTC and in any other timezone).

**What was tried and rejected.** Considered a test that would fail before the production change — this would require the host to be in a non-UTC timezone at test time, or a clock-source mock. Neither is feasible without adding test infrastructure outside the single file scope. Per the TDD skill, if a test passes before implementation because "the behavior already exists at the library level," the test is still valid as regression protection and the implementation change is the meaningful delta. No mocking infrastructure was added.

**What remains.** Nothing — all four acceptance criteria are met. AC-1: `Local::now()` is used. AC-2: `DeliveryKind::Periodic` with original prompt and request context is unchanged. AC-3: invalid-cron warning-and-skip path is unchanged. AC-4: `cargo test -p scheduler-adapter local` and `cargo test -p scheduler-adapter cron_tick` both pass; `cargo test --workspace` passes with zero failures; `cargo fmt --all -- --check` is clean. Implementation committed as `e6a3e9e`.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->
