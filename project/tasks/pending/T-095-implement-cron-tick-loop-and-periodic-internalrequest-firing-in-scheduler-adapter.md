---
id: T-095
title: Implement cron tick loop and periodic InternalRequest firing in scheduler-adapter
status: pending
priority: high
assigned-role: developer
created: '2026-06-12'
spec: S-009
---

# Implement cron tick loop and periodic InternalRequest firing in scheduler-adapter

## Description

S-009 Phase 2: the scheduler actor must evaluate cron expressions against
wall-clock time and, on each tick, submit a `periodic` `InternalEvent` carrying
the job's prompt to the internal queue via the `IntakeHandle`.

**Implementation notes:**

- Add the `cron` crate (already added to `bob` in T-092) to
  `scheduler-adapter/Cargo.toml` as well, for cron-expression scheduling.
- Use `tokio::time::sleep_until` with the next-fire time calculated from the
  cron expression to avoid busy-polling. Do not use an external cron-scheduler
  library that spawns its own thread pool.
- For each tick:
  - Construct `InternalEvent { kind: DeliveryKind::Periodic, payload: job.prompt.clone() }`.
  - Construct `RequestContext { sender: UserId::scheduler_sentinel(), source: ChannelId::new(), context_id: Some(job.id.clone()), reply_address: None }`.
  - Call `intake.submit_event(event, context).await`. If the queue is full or
    returns an error, log a warning and continue — do not crash the actor.
- `DeliveryKind::Periodic` must exist in `bob-core`. If it does not, add it
  (check first; ADR-004 already defines it as a valid kind).
- A `UserId` sentinel for the scheduler (e.g. `UserId::scheduler()`) should
  be defined or used — check what convention the codebase uses for
  system-originated requests.

**Testing:** Add an integration test in `scheduler-adapter/src/lib.rs` (or
`tests/`) that:
1. Configures a single job with a cron expression that fires every second.
2. Uses `tokio::time::pause()` + `tokio::time::advance()` to drive the clock.
3. Asserts that at least one `periodic` `InternalEvent` with the correct
   payload reaches the mock intake handle within the advanced time.

## Acceptance Criteria

AC-1: WHEN a scheduled job's cron expression matches the current time THE
      SYSTEM SHALL submit one `InternalEvent` with `kind = DeliveryKind::Periodic`
      and `payload` equal to the job's `prompt` to the intake handle.

AC-2: The system shall set `context_id` on the `RequestContext` to the job's
      `id` string, and `reply_address` to `None`.

AC-3: IF `intake.submit_event` returns an error THEN THE SYSTEM SHALL log a
      warning and continue processing subsequent ticks without crashing.

AC-4: The system shall pass `cargo test -p scheduler-adapter` including the
      new cron-tick integration test.

AC-5: The system shall pass `cargo test --workspace` with no new failures.

## Dependencies

- `T-094` — actor must be wired into bob-serve before end-to-end path is
  confirmed; actor skeleton must exist before tick loop is added

## Files to Touch

- `the-intern/service/crates/scheduler-adapter/src/lib.rs` — add tick loop
  and `cron` integration
- `the-intern/service/crates/scheduler-adapter/Cargo.toml` — add `cron` crate,
  `tokio` time feature
- `the-intern/service/crates/bob-core/src/types.rs` — confirm or add
  `DeliveryKind::Periodic`

## Verification

```bash
cd the-intern/service
cargo test -p scheduler-adapter
cargo test --workspace
```

## Work Log

## Review
