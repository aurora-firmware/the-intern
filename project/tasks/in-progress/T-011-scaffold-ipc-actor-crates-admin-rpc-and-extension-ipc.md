---
id: T-011
title: Scaffold IPC actor crates admin-rpc and extension-ipc
status: pending
priority: high
assigned-role: unassigned
created: '2026-05-16'
spec: S-001
---

# Scaffold IPC actor crates admin-rpc and extension-ipc

## Description

Create the two IPC actor crates named in S-002 §Components 4 and 5:
`admin-rpc` (owns `admin.sock` — the operator/GUI/API surface) and
`extension-ipc` (owns `extension.sock` — the JS-extension channel from S-001,
unchanged). They are picked up automatically by the workspace's `crates/*`
glob from T-007.

Each crate's `src/lib.rs` exports a clonable `Handle` struct (wraps a Tokio
mpsc `Sender` of a typed command enum), an `Actor` struct, and a public
`start(cfg) -> (Handle, JoinHandle<()>)` function. Every command method on
`Handle` returns `Err(ServiceError::NotImplemented)` for now; later tasks
(T-018–T-022) replace those bodies.

Dependencies per crate: `tokio` (rt, sync, net, signal, macros features),
`bob-core`, `tracing`, `serde`, `serde_json`, `async-trait`. Both crates
forbid unsafe code.

## Acceptance Criteria

AC-1: The system shall provide a library crate `admin-rpc` under `the-intern/service/crates/admin-rpc/` exposing public `Handle` and `start`.
AC-2: The system shall provide a library crate `extension-ipc` under `the-intern/service/crates/extension-ipc/` exposing public `Handle` and `start`.
AC-3: WHEN any `Handle` command method on `admin-rpc` or `extension-ipc` is called THE SYSTEM SHALL return `Err(ServiceError::NotImplemented)`.
AC-4: WHEN `cargo check --workspace --manifest-path the-intern/service/Cargo.toml` is run THE SYSTEM SHALL exit with code 0.
AC-5: The system shall declare `#![forbid(unsafe_code)]` in both crates' `lib.rs`.

## Dependencies

- `T-007` — workspace and `bob-core` skeleton
- `T-009` — `ServiceError` referenced by every `Handle` method

## Files to Touch

- `the-intern/service/crates/admin-rpc/Cargo.toml` — new
- `the-intern/service/crates/admin-rpc/src/lib.rs` — new; `Handle`, `Actor`, `start`
- `the-intern/service/crates/extension-ipc/Cargo.toml` — new
- `the-intern/service/crates/extension-ipc/src/lib.rs` — new; same scaffold

## Verification

```bash
cd the-intern/service && cargo check --workspace
test -f the-intern/service/crates/admin-rpc/Cargo.toml
test -f the-intern/service/crates/extension-ipc/Cargo.toml
grep -q 'forbid(unsafe_code)' the-intern/service/crates/admin-rpc/src/lib.rs
grep -q 'forbid(unsafe_code)' the-intern/service/crates/extension-ipc/src/lib.rs
```

## Work Log

## Review
