---
id: T-094
title: Wire scheduler adapter into bob-serve supervision tree
status: pending
priority: high
assigned-role: developer
created: '2026-06-12'
spec: S-009
---

# Wire scheduler adapter into bob-serve supervision tree

## Description

The scheduler adapter actor created in T-093 must be started at `bob serve`
startup and stopped cleanly at shutdown, exactly as `chat-adapter` is today.

Changes to `crates/bob/src/serve.rs`:
- Add `scheduler_adapter` crate as a dependency in `crates/bob/Cargo.toml`.
- In `start_subsystems` (or equivalent), call
  `scheduler_adapter::start(intake, cfg.schedule.clone())` unconditionally
  (the scheduler starts even with zero jobs — it simply idles).
- Store the returned `ReloadHandle` and `JoinHandle` in the `ServeRuntime`
  struct (or equivalent).
- In the shutdown sequence, drop the `ReloadHandle` and await the `JoinHandle`
  after the queue drains, in the same position as `chat_adapter_join`.

The scheduler does not need an enable/disable flag in config — it is always
started (an empty job table is a valid running state).

## Acceptance Criteria

AC-1: WHEN `bob serve` starts THE SYSTEM SHALL log
      "scheduler-adapter actor started" before accepting any requests.

AC-2: WHEN `bob serve` receives SIGTERM THE SYSTEM SHALL await the scheduler
      actor's `JoinHandle` during the shutdown drain phase and log
      "scheduler-adapter actor stopped".

AC-3: The system shall pass `cargo test -p bob serve::tests` (or the equivalent
      serve-layer test module) with no new failures.

AC-4: The system shall pass `cargo test --workspace` with no new failures.

## Dependencies

- `T-093` — scheduler-adapter crate and `start()` function must exist

## Files to Touch

- `the-intern/service/crates/bob/Cargo.toml` — add `scheduler-adapter` dependency
- `the-intern/service/crates/bob/src/serve.rs` — start actor, store handles,
  await on shutdown

## Verification

```bash
cd the-intern/service
cargo test -p bob serve::tests
cargo test --workspace
```

## Work Log

### Session 1 — 2026-06-12

**What was done**

Wired the `scheduler-adapter` actor into the `bob serve` startup and shutdown sequence, mirroring the pattern used for `chat-adapter`.

1. Added `scheduler-adapter = { path = "../scheduler-adapter" }` to `crates/bob/Cargo.toml`.
2. Added `_scheduler_adapter: scheduler_adapter::ReloadHandle` and `scheduler_adapter_join: JoinHandle<()>` fields to the `Runtime` struct in `serve.rs`. The scheduler join handle is non-Optional since the actor is unconditionally started.
3. Added startup call `scheduler_adapter::start(requests_handler_handle.clone(), cfg.schedule.entries.clone())` in `try_start_subsystems`, between the chat-adapter block and admin-rpc start.
4. In `run_shutdown_protocol`, destructured and dropped `_scheduler_adapter` (closing the watch channel → actor exits), then pushed `scheduler_adapter_join` into `all_joins` for phase-3 drain.
5. Added two new tests: `start_subsystems_always_creates_scheduler_adapter_join_handle` and `shutdown_protocol_awaits_scheduler_adapter_and_completes_without_hanging` (5-second deadline).

**What was tried and rejected**

- Initially typed `scheduler_adapter_join` as `Option<JoinHandle<()>>` for structural symmetry with `chat_adapter_join`, then refactored to `JoinHandle<()>` (non-optional) since the scheduler has no enable/disable flag.

**What remains**

Nothing. All four acceptance criteria satisfied.

**Obstacles Encountered**

None. The scheduler-adapter crate API from T-093 was straightforward to consume.

**Final branch state:** committed, clean, 26 serve-layer tests pass, full workspace green.

## Review
