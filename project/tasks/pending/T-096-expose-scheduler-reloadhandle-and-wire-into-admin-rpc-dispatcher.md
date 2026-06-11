---
id: T-096
title: Expose scheduler ReloadHandle and wire into admin-RPC dispatcher
status: pending
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

## Review
