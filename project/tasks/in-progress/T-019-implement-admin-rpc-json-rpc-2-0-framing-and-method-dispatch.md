---
id: T-019
title: Implement admin-rpc JSON-RPC 2.0 framing and method dispatch
status: pending
priority: high
assigned-role: unassigned
created: '2026-05-16'
spec: S-001
---

# Implement admin-rpc JSON-RPC 2.0 framing and method dispatch

## Description

Build the per-connection JSON-RPC 2.0 handler that runs on every connection
accepted by T-018's listener. Frames are newline-delimited UTF-8 JSON. Each
connection is a persistent bidirectional channel.

Method registry (day-one set):

- `service.status` — returns `{ ok: true, version, uptime_seconds }`.
- `sessions.list` — invokes `pi_agent_supervisor::Handle::list_sessions`.
- `sessions.kill` — invokes the supervisor's `kill` (currently
  `NotImplemented` until Phase 2).
- `policy.reload` — invokes `policy_control::Handle::reload` (`NotImplemented`).
- `audit.tail.subscribe` / `audit.tail.unsubscribe` — deferred to T-020.
- `chat.open` / `chat.send` / `chat.close` — deferred to T-020.

Errors map from `ServiceError` to JSON-RPC error objects via a stable
code table (e.g. `NotImplemented` → -32601 method-not-found-or-not-implemented,
`InvalidRequest` → -32602 invalid params, `Timeout` → -32099 timeout). The
`data` field carries only non-sensitive metadata (operation names, identifiers
— never user content).

## Acceptance Criteria

AC-1: WHEN an admin client sends a JSON-RPC 2.0 request for `service.status` THE SYSTEM SHALL respond with a JSON-RPC 2.0 response carrying a structured status object.
AC-2: WHEN an admin client sends a JSON-RPC 2.0 request for `sessions.list` THE SYSTEM SHALL invoke `pi_agent_supervisor::Handle::list_sessions` and return its result as the response result field.
AC-3: IF a request frame fails to parse as JSON-RPC 2.0 THEN THE SYSTEM SHALL respond with a JSON-RPC error object using code -32700 and close the connection.
AC-4: IF a method handler returns `ServiceError` THEN THE SYSTEM SHALL map it to a JSON-RPC error object whose `data` field contains only non-sensitive identifiers and metadata.
AC-5: WHEN the same connection receives multiple sequential requests with distinct `id` values THE SYSTEM SHALL respond to each with a matching `id`.

## Dependencies

- `T-018` — UDS listener and per-connection task entry point
- `T-013` — supervisor's `list_sessions`
- `T-012` — `policy-control` scaffold (Handle::reload target invoked by the `policy.reload` method)
- `T-010` — port traits

## Files to Touch

- `the-intern/service/crates/admin-rpc/src/protocol.rs` — new; JSON-RPC 2.0 request/response/error types and frame codec
- `the-intern/service/crates/admin-rpc/src/dispatch.rs` — new; method registry
- `the-intern/service/crates/admin-rpc/src/lib.rs` — touch; wire dispatcher into per-connection task

## Verification

```bash
cd the-intern/service && cargo test -p admin-rpc protocol
cd the-intern/service && cargo test -p admin-rpc dispatch
```

## Work Log

## Review
