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

## Review
