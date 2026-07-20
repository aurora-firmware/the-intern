---
id: T-096
title: Expose scheduler ReloadHandle and wire into admin-RPC dispatcher
status: completed
priority: high
assigned-role: developer
created: '2026-06-12'
spec: S-009
---

# Expose scheduler ReloadHandle and wire into admin-RPC dispatcher

## Description

The admin-RPC `schedule.*` methods (T-097) need a way to signal the scheduler
actor to reload its job table. This task threads the `ReloadHandle` (defined
in T-093) from `serve.rs` into the `Dispatcher` struct in `admin-rpc`, following
the same pattern used by `policy_control::Handle`.

**Changes:**

1. `crates/admin-rpc/src/lib.rs` — two additions:
   - Add `pub scheduler: Option<scheduler_adapter::ReloadHandle>` to the
     `admin_rpc::Config` struct (alongside the existing `supervisor`, `policy`,
     `monitoring`, `chat_adapter` fields). Without this field there is no path
     to pass the handle from `serve.rs` into `start()`.
   - Add `scheduler: Option<scheduler_adapter::ReloadHandle>` to the
     `Dispatcher` struct and a `with_scheduler_handle(self, h) -> Self` builder
     method, following the `with_chat_handle` pattern. Wire it in `start()`:
     `if let Some(h) = cfg.scheduler { dispatcher = dispatcher.with_scheduler_handle(h); }`.
   - Add `admin-rpc` crate dependency on `scheduler-adapter`.

2. `crates/bob/src/serve.rs` — store the `ReloadHandle` returned by
   `scheduler_adapter::start()`, clone it into `admin_rpc::Config::scheduler`,
   and retain the original for the shutdown drain sequence. The handle passed
   to the dispatcher is a clone; the one held by `ServeRuntime` is the primary.

3. `crates/admin-rpc/src/dispatch.rs` — add a placeholder arm matching
   `"schedule.add" | "schedule.remove" | "schedule.list" | "schedule.reload"`
   that returns `-32601 Method not found`, so the namespace is reserved and
   tests can assert the correct error before T-097 implements the real handlers.

**Reload design (commit to this):** The `ReloadHandle` carries a
`watch::Sender<Vec<ScheduleEntry>>`. When the admin-RPC layer needs to trigger
a reload (after writing to `bob.toml`), it sends the updated
`Vec<ScheduleEntry>` directly over the channel — the actor replaces its live
job table from the received value without re-reading disk. This avoids giving
the actor a `config_path` dependency and keeps the reload path fully in-process.
T-097 relies on this design when calling `handle.reload(new_entries)`.

This task does NOT implement the schedule RPC methods — only the plumbing that
makes them possible.

## Acceptance Criteria

AC-1: The system shall compile `cargo build -p admin-rpc` and `cargo build -p bob`
      with no errors after the Dispatcher gains the scheduler field.

AC-2: WHEN `admin_rpc::start()` is called with `cfg.scheduler = Some(handle)`
      THE SYSTEM SHALL pass the handle into the Dispatcher via
      `with_scheduler_handle` without panicking or dropping it prematurely.

AC-3: WHEN a `schedule.add` JSON-RPC request is sent to a running `bob serve`
      THE SYSTEM SHALL return a `-32601 Method not found` error (the placeholder),
      not a panic or connection drop.

AC-4: The system shall pass `cargo test --workspace` with no new failures.

## Dependencies

- `T-095` — `ReloadHandle` and the full actor must be in place before threading
  the handle through serve
- `T-094` — `serve.rs` already stores the scheduler handles; this task extends
  that wiring

## Files to Touch

- `the-intern/service/crates/admin-rpc/Cargo.toml` — add `scheduler-adapter`
  dependency
- `the-intern/service/crates/admin-rpc/src/lib.rs` — add `scheduler` field to
  Dispatcher
- `the-intern/service/crates/admin-rpc/src/dispatch.rs` — add placeholder
  `schedule.*` routing arm
- `the-intern/service/crates/bob/src/serve.rs` — pass `ReloadHandle` clone
  into Dispatcher constructor

## Verification

```bash
cd the-intern/service
cargo build -p admin-rpc
cargo build -p bob
cargo test --workspace
```

## Work Log

### Session 1 — 2026-06-12

**What was done**

Three connected changes: redesign `ReloadHandle` in `scheduler-adapter`, add scheduler plumbing to `admin-rpc`, and clone the handle into `serve.rs`.

1. **`scheduler-adapter/src/lib.rs`** — Changed `ReloadHandle` from `watch::Sender<()>` to `watch::Sender<Vec<ScheduleEntry>>`. Added `pub fn reload(&self, entries: Vec<ScheduleEntry>) -> Result<...>`. Refactored actor `run()` to `loop { spawn_job_tasks → wait_for_changed → rebuild }`, handling both reload and shutdown in both empty-job and non-empty-job cases. Added one new test (`reload_handle_reload_sends_new_entries_without_dropping_actor`). All 5 original tests still pass (6 total).

2. **`admin-rpc/Cargo.toml`** — Added `scheduler-adapter = { path = "../scheduler-adapter" }`.

3. **`admin-rpc/src/dispatch.rs`** — Added `scheduler: Option<scheduler_adapter::ReloadHandle>` field to `Dispatcher`, `with_scheduler_handle` builder, placeholder arm matching `"schedule.add" | "schedule.remove" | "schedule.list" | "schedule.reload"` returning `-32601 Method not found`. Added 3 tests.

4. **`admin-rpc/src/lib.rs`** — Added `pub scheduler: Option<scheduler_adapter::ReloadHandle>` to `Config`, wired in `start()`.

5. **`bob/src/serve.rs`** — Cloned `ReloadHandle` into `admin_rpc::Config::scheduler`; primary handle retained in `Runtime` for shutdown ordering.

**What was tried and rejected**

Initial `TODO(T-096+)` stub in actor reload loop discarded — task requires actor to replace job table on reload. Refactored to `loop { spawn → wait → rebuild }` to avoid duplicating reload/shutdown logic.

**What remains**

Nothing. T-097 will implement real `schedule.add/remove/list/reload` handlers using `ReloadHandle::reload`.

**Obstacles Encountered**

None.

**Final branch state:** 3 commits above dev-agent. `cargo test --workspace` passes with zero failures (scheduler-adapter: 6, admin-rpc: 111, bob: 104).

## Review

### Review Verdict — 2026-06-12

PASS

**Stage 1 — Acceptance Criteria**

- AC-1: `cargo build -p admin-rpc` and `cargo build -p bob` both compile cleanly with no errors or warnings. PASS.
- AC-2: `with_scheduler_handle` builder tested in `dispatcher_with_scheduler_handle_does_not_panic`; `start()` wires it via `if let Some(h) = cfg.scheduler.clone() { dispatcher = dispatcher.with_scheduler_handle(h); }`, consistent with the `chat_adapter` pattern. PASS.
- AC-3: Placeholder arm `"schedule.add" | "schedule.remove" | "schedule.list" | "schedule.reload"` returns `CODE_METHOD_NOT_FOUND` (-32601). Covered by two tests (`dispatch_schedule_add_returns_method_not_found`, `dispatch_schedule_namespace_methods_all_return_method_not_found`). PASS.
- AC-4: `cargo test --workspace` — all suites pass: admin-rpc 111, bob 104, scheduler-adapter 6. Zero failures. PASS.

**Stage 2 — Code Quality**

- **Correctness:** `ReloadHandle` redesign is coherent. The actor loop uses `borrow_and_update()` correctly to consume the value and prevent re-triggering on the same message. `continue` in the empty-jobs branch re-enters the outer loop cleanly. Shutdown-via-drop is preserved in both branches via `Err(_) => break`. Task abort-before-rebuild is correct in both the reload and shutdown paths.
- **Tests:** New test in `scheduler-adapter` covers reload without dropping the actor. Three new tests in `admin-rpc` cover AC-2 and AC-3. All tests are independent with no shared mutable state.
- **Security:** No hardcoded secrets; no external input in scope for this task.
- **Readability:** Names are descriptive; `build_job_states` and `spawn_job_tasks` helpers are focused single-purpose functions. No dead code or commented-out blocks.
- **Performance:** No unnecessary allocations; `borrow_and_update().clone()` is the minimal copy needed. Task abort loops are correctly structured.
- **Files touched:** Only the four files listed in the task spec (`admin-rpc/Cargo.toml`, `admin-rpc/src/lib.rs`, `admin-rpc/src/dispatch.rs`, `bob/src/serve.rs`) plus `scheduler-adapter/src/lib.rs` for the `ReloadHandle` type change described in the task description. No unexpected files modified.

Minor observation (non-blocking): `cfg.scheduler.clone()` in `admin-rpc/src/lib.rs` follows the pre-existing `cfg.chat_adapter.clone()` style immediately above it; a direct move would suffice but this is consistent with the surrounding code.
