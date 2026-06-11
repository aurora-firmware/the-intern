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

- Add the `croner` crate (same crate used by T-092 in `bob`) to
  `scheduler-adapter/Cargo.toml` for computing next-fire times from cron
  expressions. **Do not use the `cron` crate** — it defaults to 6+ fields and
  does not match the 5-field expressions stored in config.
- Use `tokio::time::sleep_until` with the next-fire time calculated from
  `croner` to avoid busy-polling. Do not use an external cron-scheduler
  library that spawns its own thread pool.
- **Fixed identities per job, not per tick.** At actor startup, for each
  `ScheduleEntry` build a `JobState` that holds a fixed `ChannelId` (created
  once via `ChannelId::new()`) and a fixed `UserId` (created once via
  `UserId::new()`). Reuse these same values on every tick for that job.
  Creating fresh random IDs per tick would break policy traceability — each
  fire would appear to come from an unknown channel and user. The fixed IDs
  should be logged at startup (`info!`) so operators can reference them in
  policy rules.
- For each tick:
  - Construct `InternalEvent { kind: DeliveryKind::Periodic, payload: job.prompt.clone() }`.
  - Construct `RequestContext { sender: job_state.user_id, source: job_state.channel_id, context_id: Some(job.id.clone()), reply_address: None }`.
  - Call `intake.submit_event(event, context).await`. If the queue is full or
    returns an error, log a warning and continue — do not crash the actor.
- `DeliveryKind::Periodic` already exists in `bob-core/src/types/event.rs`
  (confirmed); no change to that file is needed.

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
      `id` string, `reply_address` to `None`, and use the same `ChannelId` and
      `UserId` for every tick of a given job (fixed at actor startup).

AC-3: IF `intake.submit_event` returns an error THEN THE SYSTEM SHALL log a
      warning and continue processing subsequent ticks without crashing.

AC-4: The system shall pass `cargo test -p scheduler-adapter` including the
      new cron-tick integration test.

AC-5: The system shall pass `cargo test --workspace` with no new failures.

## Dependencies

- `T-094` — actor must be wired into bob-serve before end-to-end path is
  confirmed; actor skeleton must exist before tick loop is added

## Files to Touch

- `the-intern/service/crates/scheduler-adapter/src/lib.rs` — add tick loop,
  `JobState` struct, and `croner` integration
- `the-intern/service/crates/scheduler-adapter/Cargo.toml` — add `croner`
  crate and `tokio` time feature

## Verification

```bash
cd the-intern/service
cargo test -p scheduler-adapter
cargo test --workspace
```

## Work Log

### Session 1 — 2026-06-12

**What was done**

Implemented the cron tick loop in `scheduler-adapter`, satisfying all five acceptance criteria.

**Cargo.toml changes:**
- Added `croner = "3"` and `chrono = "0.4"` to dependencies
- Added `"time"` feature to tokio dependency
- Added `"test-util"` feature to tokio dev-dependencies (required for `tokio::time::pause()` and `advance()`)

**Implementation:**
- Added `JobState` struct holding fixed `ChannelId`, `UserId`, and `ScheduleEntry` — created once per job at actor startup. Fixed IDs logged at `INFO` at startup.
- Updated `Actor` to hold `intake: IntakeHandle` (was `_intake`) and `jobs: Vec<JobState>` (was `entries: Vec<ScheduleEntry>`).
- For each job: spawns a `tokio::spawn` task running `run_job_tick_loop`: parses cron with `CronParser::builder().seconds(Seconds::Disallowed).build()`, computes duration to next fire, sleeps via `tokio::time::sleep`, then submits `InternalEvent { kind: DeliveryKind::Periodic, payload: job.prompt }` with `RequestContext { sender: user_id, source: channel_id, context_id: Some(job.id), reply_address: None }`.
- Submit errors logged as `WARN`, loop continues — actor does not crash (AC-3).
- On shutdown, actor aborts all per-job task handles.

**Tests added:**
- `cron_tick_submits_periodic_event_with_correct_payload_and_context` (AC-1 + AC-2)
- `cron_tick_reuses_same_channel_id_and_user_id_across_multiple_ticks` (AC-2)
- `actor_continues_running_when_intake_submit_returns_error` (AC-3)

**What was tried and rejected**

- Single large `advance(130s)`: after the first tick fires and the job registers a new sleep, the advance has already passed. Switched to per-tick `advance(65s)` steps.
- Advancing without prior yields: actor tasks hadn't registered their timers. Added pre-advance `yield_now()` calls.

**What remains**

Nothing. All acceptance criteria met.

**Obstacles Encountered**

- `tokio::time::pause()`/`advance()` require the `test-util` feature (dev-dependencies only).
- `croner` requires `chrono` for `DateTime<Utc>`; added explicitly to bridge to `std::time::Duration`.
- Task scheduling in `current_thread` runtime requires yielding before `advance()` so per-job tasks register their timers first.

**Final branch state:** committed, clean, 5 scheduler-adapter tests pass, full workspace green.

## Review

### Review Verdict — 2026-06-12

PASS

**Stage 1 — Acceptance Criteria**

AC-1: Met. `run_job_tick_loop` constructs `InternalEvent { kind: DeliveryKind::Periodic, payload: job_prompt.clone() }` on every tick and calls `intake.submit_event(event, context).await`. Test `cron_tick_submits_periodic_event_with_correct_payload_and_context` confirms kind and payload match the job's prompt.

AC-2: Met. `RequestContext` is built with `context_id: Some(job_id.clone())`, `reply_address: None`, `sender: user_id`, `source: channel_id`. Both `channel_id` and `user_id` are created once per job inside `start()` in `JobState` and passed by value into `run_job_tick_loop` — reused across every tick. Fixed IDs are logged at INFO at startup. Tests `cron_tick_submits_periodic_event_with_correct_payload_and_context` and `cron_tick_reuses_same_channel_id_and_user_id_across_multiple_ticks` confirm both.

AC-3: Met. `if let Err(err) = intake.submit_event(...).await` logs `WARN` and the loop `continue`s. Test `actor_continues_running_when_intake_submit_returns_error` verifies actor is still alive after failed submits.

AC-4: Met. `cargo test -p scheduler-adapter` — 5 tests pass, 0 failures.

AC-5: Met. `cargo test --workspace` — all crates pass, 0 new failures.

**Stage 2 — Code Quality**

- Correctness: Next-fire computation uses `croner` with `Seconds::Disallowed` matching 5-field expressions as specified. Duration conversion handles the edge case where `next` could be in the past (returns `Duration::ZERO` safely). Cron parse failures at startup log a warning and skip the job without crashing — appropriate defensive behaviour.
- Tests: Three new integration tests using `tokio::time::pause()` + `advance()`. Each covers a distinct criterion (payload/context, identity reuse, error resilience). Helper functions `make_intake_with_collector` / `make_intake` keep tests independent with no shared mutable state between tests.
- Security: No hardcoded secrets; no external input beyond configuration entries already validated upstream.
- Readability: `JobState`, `run_job_tick_loop`, and `Actor::run` are clearly named and focused. No dead code, no commented-out blocks.
- Performance: No busy-polling; uses `tokio::time::sleep` driven by computed duration. Actor aborts and awaits all per-job handles on shutdown, avoiding leaks.

No blocking issues. Minor observation (non-blocking): The two pre-existing tests (`start_with_empty_entries_returns_reload_handle_and_running_join_handle` and `actor_exits_cleanly_when_all_reload_handles_are_dropped`) were part of the prior skeleton; they continue to pass and are unchanged.
