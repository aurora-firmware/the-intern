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

### Review Verdict — 2026-06-12

PASS

**Stage 1 — Acceptance Criteria**

- AC-1: Met. `serve.rs` emits `info!("scheduler-adapter actor started")` at line 217, inside `try_start_subsystems` before the admin socket is bound and before the extension socket is bound — i.e., before any request-accepting socket exists. The log message matches the criterion exactly.
- AC-2: Met. The "scheduler-adapter actor stopped" log is emitted by the actor itself (`scheduler-adapter/src/lib.rs:62`) when its watch-channel receiver closes. The `ReloadHandle` is dropped explicitly in `run_shutdown_protocol` (phase 1), and `scheduler_adapter_join` is pushed into `all_joins` and awaited in phase 3 under `shutdown_drain_deadline`. Both the log and the JoinHandle await are confirmed present.
- AC-3: Met. `cargo test -p bob serve::tests` — 26 tests passed, 0 failed. Both new tests (`start_subsystems_always_creates_scheduler_adapter_join_handle`, `shutdown_protocol_awaits_scheduler_adapter_and_completes_without_hanging`) pass.
- AC-4: Met. `cargo test --workspace` — all test binaries green, 0 failures.

**Stage 2 — Code Quality**

- Correctness: The scheduler actor is unconditionally started; `JoinHandle<()>` is non-Optional (correct per spec). Drop ordering in `run_shutdown_protocol` follows the established pattern for `chat-adapter`. No logic errors observed.
- Tests: Two new tests cover AC-1 (handle present and actor running after startup) and AC-2 (shutdown completes within a 5-second deadline). Both success paths are exercised. Tests use isolated temp dirs and do not share mutable state.
- Security: No new external input surface, no secrets.
- Readability: Code follows the existing `chat-adapter` pattern exactly; comments are accurate and aligned with the implementation.
- Performance: No unnecessary allocations or blocking calls. `entries.clone()` passes an owned `Vec` to the actor, consistent with the T-093 API.
- Scope: Only the three files specified in the task (`Cargo.toml`, `Cargo.lock`, `serve.rs`) were modified. No unrelated changes bundled.
