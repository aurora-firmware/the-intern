---
id: T-093
title: Create scheduler-adapter crate with actor scaffold
status: completed
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
  - `start(intake: IntakeHandle, entries: Vec<ScheduleEntry>) -> (ReloadHandle, JoinHandle<()>)`
  - Internal actor loop: initialises job table from `ScheduleConfig`, waits for
    reload signal or shutdown (all handles dropped), logs start and stop.

`ScheduleEntry` is defined in `bob-core::types` (placed there by T-092).
`scheduler-adapter` imports it directly from `bob-core` — do not add a
dependency on `bob`. `ScheduleConfig` is `bob`-crate-only; pass a
`Vec<bob_core::types::ScheduleEntry>` into `start()` rather than the full
`ScheduleConfig`, so the adapter crate does not need any `bob`-crate types.

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

- `T-092` — `ScheduleEntry` must be defined in `bob-core::types` before the
  actor crate can import it

## Files to Touch

- `the-intern/service/Cargo.toml` — add `scheduler-adapter` to workspace members
- `the-intern/service/crates/scheduler-adapter/Cargo.toml` — new file
- `the-intern/service/crates/scheduler-adapter/src/lib.rs` — new file

## Verification

```bash
cd the-intern/service
cargo build -p scheduler-adapter
cargo test -p scheduler-adapter
cargo test --workspace
```

## Work Log

### Session 1 — 2026-06-12

**What was done**

Created the `scheduler-adapter` crate from scratch following the `chat-adapter` pattern:

- `ReloadHandle` — a `#[derive(Clone)]` struct wrapping a `watch::Sender<()>`. Drop sentinel: when all clones are dropped, the receiver sees the channel closed and the actor exits.
- `start(intake: IntakeHandle, entries: Vec<ScheduleEntry>) -> (ReloadHandle, JoinHandle<()>)` — spawns the actor and returns the handle pair.
- Internal `Actor` struct holding `_intake` (for T-095), `entries` (job table), and `reload_rx`. Actor loops on `reload_rx.changed()`, logging at DEBUG on reload and breaking on `Err` (channel closed). Logs "scheduler-adapter actor started" at INFO on entry and "scheduler-adapter actor stopped" at INFO on exit.
- Two tests: `start_with_empty_entries_returns_reload_handle_and_running_join_handle` (AC-2 + AC-4) and `actor_exits_cleanly_when_all_reload_handles_are_dropped` (AC-3 + AC-4).

TDD cycle: wrote failing tests first, added implementation, confirmed green, refactored (used `_intake` field name instead of `let _ = &self.intake`), applied `cargo fmt`.

**What was tried and rejected**

- `let _ = &self.intake` to suppress dead_code warning — rejected in favour of `_intake` field name (idiomatic Rust).
- Separate `tokio::select!` branch watching a `CancellationToken` — rejected as over-engineering; drop-sentinel on `watch::Sender<()>` exactly matches the spec.

**What remains**

Nothing. All acceptance criteria met. T-095 will add cron tick firing using `_intake`.

**Obstacles Encountered**

- Workspace `members = ["crates/*"]` glob picks up the new crate automatically; no edit to `service/Cargo.toml` was needed.
- `rustfmt` reformatted multi-line `start()` signature; applied with `cargo fmt --all`.

**Final branch state:** committed, clean, all tests passing (2 scheduler-adapter tests, full workspace green)

## Review

### Review Verdict — 2026-06-12

PASS

**Stage 1 — Acceptance Criteria**

- AC-1: `cargo build -p scheduler-adapter` completed with no errors or warnings. PASS.
- AC-2: `start()` with empty entries returns `(ReloadHandle, JoinHandle<()>)`; actor logs
  "scheduler-adapter actor started" at INFO. Confirmed by code reading and passing tests. PASS.
- AC-3: Drop sentinel on `watch::Sender<()>` correctly closes the channel, causing
  `reload_rx.changed()` to return `Err`, breaking the loop and exiting cleanly. PASS.
- AC-4: Two tests present and passing: `start_with_empty_entries_returns_reload_handle_and_running_join_handle`
  (AC-2) and `actor_exits_cleanly_when_all_reload_handles_are_dropped` (AC-3). PASS.
- AC-5: `cargo test --workspace` — all tests pass, no new failures. PASS.

No dependency on `bob` crate confirmed: `Cargo.toml` depends only on `bob-core`, `requests-handler`,
`tokio`, and `tracing`. Circular-dependency constraint satisfied.

Workspace membership via `members = ["crates/*"]` glob is sufficient; the `service/Cargo.toml`
edit listed in "Files to Touch" was not required and the developer's note explains this correctly.

**Stage 2 — Code Quality**

- Correctness: Actor loop handles the reload signal (`Ok`) and shutdown (`Err`) paths correctly.
  `_intake` field held for T-095 without triggering dead_code warnings (underscore prefix idiom).
- Tests: Two independent tests; each creates its own runtime resources via `make_intake()`.
  Success and stop-path both covered. Timeout guard (`Duration::from_secs(2)`) in the shutdown test
  prevents hangs.
- Security: No external input, no secrets, no unsafe code (`#![forbid(unsafe_code)]`).
- Readability: Names are descriptive, doc-comments explain the drop-sentinel mechanism, dead-code
  field naming follows idiomatic Rust convention.
- Performance: No blocking calls in the async loop; no resource leaks.
