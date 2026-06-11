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

1. `crates/admin-rpc/src/lib.rs` — add `scheduler: Option<scheduler_adapter::ReloadHandle>`
   field to `Dispatcher` (or its builder). Add `admin-rpc` crate dependency on
   `scheduler-adapter`.

2. `crates/bob/src/serve.rs` — pass the `ReloadHandle` returned by
   `scheduler_adapter::start()` into the `Dispatcher` constructor. The handle
   stored in `ServeRuntime` (for shutdown) is separate from the clone passed to
   the dispatcher.

3. `crates/admin-rpc/src/dispatch.rs` — no new methods yet (those are T-097),
   but add a placeholder arm for `"schedule.*"` that returns `-32601 Method not
   found` so the method namespace is reserved and tests can assert on it.

This task does NOT implement the schedule RPC methods — only the plumbing that
makes them possible.

## Acceptance Criteria

AC-1: The system shall compile `cargo build -p admin-rpc` and `cargo build -p bob`
      with no errors after the Dispatcher gains the scheduler field.

AC-2: WHEN the Dispatcher is constructed with `scheduler: Some(handle)` THE
      SYSTEM SHALL store the handle without panicking or dropping it prematurely.

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
