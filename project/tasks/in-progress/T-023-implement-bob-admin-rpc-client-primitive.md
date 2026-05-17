---
id: T-023
title: Implement bob admin-rpc client primitive
status: pending
priority: high
assigned-role: unassigned
created: '2026-05-16'
spec: S-001
---

# Implement bob admin-rpc client primitive

## Description

Implement the client-side counterpart to T-019/T-020 inside the `bob` binary
crate. The `AdminClient` connects to `admin.sock` (path from `BobConfig`),
performs newline-delimited JSON-RPC 2.0 framing, and exposes two methods:

- `call<P, R>(method, params) -> ServiceResult<R>` — single request/response.
- `subscribe<P, N>(method, params) -> ServiceResult<Subscription<N>>` —
  returns a `Subscription` value that yields deserialized notifications until
  the client unsubscribes or the connection closes.

`Subscription` is a small async type with `recv()` and `close()` methods.
Connection errors map to `ServiceError::ServiceDown`; mid-flight protocol
errors map to `ServiceError::InvalidRequest`. The client never panics on
malformed server output.

## Acceptance Criteria

AC-1: The system shall provide `bob::client::AdminClient::connect(cfg: &BobConfig)` that opens a Unix-socket connection to `cfg.admin_sock_path` and returns an `AdminClient` value.
AC-2: WHEN `AdminClient::call(method, params)` is invoked against a server speaking JSON-RPC 2.0 THE SYSTEM SHALL send a request frame and return the deserialized result or a typed `ServiceError`.
AC-3: WHEN `AdminClient::subscribe(method, params)` is invoked THE SYSTEM SHALL return a `Subscription` that yields deserialized notifications via `recv()` until unsubscribed or the connection closes.
AC-4: IF the admin socket is absent, unreadable, or refuses the connection THEN `AdminClient::connect` SHALL return `Err(ServiceError::ServiceDown)` without panicking.

## Dependencies

- `T-014` — binary skeleton
- `T-015` — `BobConfig` populated
- `T-019` — server protocol contract (request/response framing)
- `T-020` — server subscription contract (notifications)

## Files to Touch

- `the-intern/service/crates/bob/src/client/mod.rs` — new; module entry
- `the-intern/service/crates/bob/src/client/admin_rpc.rs` — new; `AdminClient`, `Subscription`

## Verification

```bash
cd the-intern/service && cargo test -p bob client::admin_rpc
```

## Work Log

## Review
