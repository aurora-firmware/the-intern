---
id: T-023
title: Implement bob admin-rpc client primitive
status: completed
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

### Session 1 — 2026-05-17

Implemented the new `bob::client` module and the `AdminClient` primitive in `client/admin_rpc.rs` using TDD cycles. First cycle covered connect and call basics: connecting via `BobConfig.admin_sock_path`, emitting newline-delimited JSON-RPC 2.0 requests, and decoding typed results. Second cycle added protocol-failure coverage and handling for malformed server frames and response-id mismatches, ensuring these map to `ServiceError::InvalidRequest` without panics. Third cycle implemented subscriptions: `subscribe` sends a JSON-RPC request, captures server `result.id`, returns a `Subscription`, `recv()` decodes pushed notification payloads, and `close()` sends the derived unsubscribe method (`*.subscribe -> *.unsubscribe`, `*.open -> *.close`) and validates its response.

During testing, I initially used long socket paths and saw `SUN_LEN` path-length failures; I shortened and stabilized socket path generation. I also tried running tests inside sandbox first, but Unix socket bind/connect was blocked there, so verification was rerun unsandboxed.

Nothing remains for T-023 acceptance in this branch; all required client behaviors and target tests are implemented and passing.

Obstacles Encountered:
- Sandbox execution blocked Unix domain socket bind/connect for these tests; verification required unsandboxed test runs.
- Initial generated Unix socket paths exceeded `SUN_LEN`; fixed by shortening/stabilizing test socket path generation.

## Review

### Review Verdict — 2026-05-17
PASS

Stage 1 (acceptance criteria and scope): pass.
- AC-1 met: `AdminClient::connect(cfg: &BobConfig)` connects via `cfg.admin_sock_path` and returns `ServiceDown` on connect failure (`the-intern/service/crates/bob/src/client/admin_rpc.rs`).
- AC-2 met: `call()` emits newline-delimited JSON-RPC 2.0 request frames and returns typed `result` or `ServiceError` mapping (`ServiceDown` on I/O failure, `InvalidRequest` on protocol/error frames).
- AC-3 met: `subscribe()` returns `Subscription`; `recv()` deserializes notifications and validates subscription id; `close()` sends derived unsubscribe/close method and validates close response.
- AC-4 met: absent/refused socket path is mapped to `Err(ServiceError::ServiceDown)` without panics.
- Branch-scope verification passed: `git diff --name-status dev-agent..task/T-023-implement-bob-admin-rpc-client-primitive` only includes service crate files, no `project/tasks/...` lifecycle files.

Stage 2 (code quality): pass.
- Correctness/readability/security/performance checks found no blocking issues in task scope.
- Verification executed: `cd the-intern/service && cargo test -p bob client::admin_rpc` (7 tests passed).
