---
id: T-093
title: Create scheduler-adapter crate with actor scaffold
status: pending
priority: high
assigned-role: developer
created: '2026-06-12'
spec: S-009
---

# Create scheduler-adapter crate with actor scaffold

## Description

S-009 Component 1 is a scheduler adapter actor that lives in its own crate,
matching the pattern of `crates/chat-adapter`. This task creates the
`scheduler-adapter` crate with the actor scaffold: the actor starts, reads
`ScheduleConfig`, holds a live job table, accepts a reload signal, and shuts
down cleanly. No cron ticks fire yet — that is T-095.

**Crate skeleton:**
- `crates/scheduler-adapter/Cargo.toml` — depends on `bob-core`,
  `requests-handler`, `tokio` (rt, sync, macros), `tracing`.
- `crates/scheduler-adapter/src/lib.rs` — public API:
  - `ReloadHandle` — cheaply cloneable; wraps a `watch::Sender<()>` (or
    equivalent) that the admin-RPC layer uses to signal a config reload.
  - `start(intake: IntakeHandle, config: ScheduleConfig) -> (ReloadHandle, JoinHandle<()>)`
  - Internal actor loop: initialises job table from `ScheduleConfig`, waits for
    reload signal or shutdown (all handles dropped), logs start and stop.

`ScheduleConfig` / `ScheduleEntry` were defined in T-092 inside the `bob`
crate. Because `scheduler-adapter` must not depend on `bob`, mirror the minimal
needed types (`ScheduleEntry { id, cron, prompt }`) into `bob-core` and re-use
them from both `bob` and `scheduler-adapter`. Record the decision in the Work Log.

Register the new crate in `the-intern/service/Cargo.toml`.

## Acceptance Criteria

AC-1: The system shall compile `cargo build -p scheduler-adapter` with no
      errors or warnings.

AC-2: WHEN `start()` is called with an empty `ScheduleConfig` THE SYSTEM SHALL
      return a `(ReloadHandle, JoinHandle<()>)` and the actor shall log
      "scheduler-adapter actor started".

AC-3: WHEN all `ReloadHandle` clones are dropped THE SYSTEM SHALL cause the
      actor to exit and its `JoinHandle` to resolve cleanly.

AC-4: The system shall pass `cargo test -p scheduler-adapter` with at least
      one test confirming start-and-stop behaviour (AC-2 and AC-3).

AC-5: The system shall pass `cargo test --workspace` with no new failures.

## Dependencies

- `T-092` — `ScheduleConfig` / `ScheduleEntry` types must exist before the
  actor can consume them

## Files to Touch

- `the-intern/service/Cargo.toml` — add `scheduler-adapter` to workspace members
- `the-intern/service/crates/scheduler-adapter/Cargo.toml` — new file
- `the-intern/service/crates/scheduler-adapter/src/lib.rs` — new file
- `the-intern/service/crates/bob-core/src/types.rs` — add `ScheduleEntry` mirror
  (if the decision is to define it in bob-core)
- `the-intern/service/crates/bob/src/config.rs` — update to re-use `bob-core::ScheduleEntry`
  instead of a local definition (if applicable)

## Verification

```bash
cd the-intern/service
cargo build -p scheduler-adapter
cargo test -p scheduler-adapter
cargo test --workspace
```

## Work Log

## Review
