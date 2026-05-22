---
id: T-019
title: Implement admin-rpc JSON-RPC 2.0 framing and method dispatch
status: completed
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

### Session 1 — 2026-05-17

Implemented all five acceptance criteria in two TDD cycles.

**Cycle 1 — `protocol.rs`**

Wrote and committed `Request`, `Response`, `ErrorResponse`, and `ErrorObject` types, the error-code constants (`CODE_PARSE_ERROR=-32700`, `CODE_METHOD_NOT_FOUND=-32601`, `CODE_INVALID_REQUEST=-32602`, `CODE_TIMEOUT=-32099`), and the `read_frame`/`write_frame` async helpers that use newline-delimited UTF-8 framing. The `id` field is `serde_json::Value` throughout so it can round-trip strings, numbers, and null without loss. Tests drive the codec with an in-process `tokio::io::duplex` pair; `tokio-test` was considered but not added since `duplex` is already available from the `io-util` feature.

**Cycle 2 — `dispatch.rs` + `lib.rs` wiring**

Wrote `Dispatcher` with `Option<pi_agent_supervisor::Handle>` and `Option<policy_control::Handle>` fields. When a handle is `None` the corresponding method returns `-32601`; this keeps `Config::default()` backward-compatible with `bob::serve`. Implemented `service.status` (returns `{ ok, version, uptime_seconds }`), `sessions.list` (delegates to supervisor), `sessions.kill` (NotImplemented placeholder), and `policy.reload` (NotImplemented placeholder). `map_service_error` maps every `ServiceError` variant to a JSON-RPC error object whose `data` field contains only safe metadata (category labels, operation names — no user content). Updated `run_listener` to spawn a `run_connection` task per accepted stream; `run_connection` loops reading frames, dispatching, and writing responses, terminating on EOF, I/O error, or parse error (which sends `-32700` first per AC-3).

**Design decisions**

- `Config` loses its `#[derive(Debug)]` because `pi_agent_supervisor::Handle` and `policy_control::Handle` do not implement `Debug`. The only alternative would be a manual `Debug` impl that elides the handle fields, which would be misleading; removing the derive is honest.
- `policy_control::Handle` has no `reload` method in the current crate — `policy.reload` returns NotImplemented regardless of whether the handle is `Some`. This matches the spec's stated intent ("NotImplemented until Phase 2").
- Connected-stream tests use `tokio::net::UnixStream::pair()` for integration-level coverage of AC-1, AC-3, and AC-5 end-to-end.

**Verification**

42 tests pass; `cargo build -p bob`, `cargo fmt -- --check`, and `cargo clippy -- -D warnings` are all clean. Two commits on the task branch.

**Nothing remains** for this task's scope. T-020 will wire `audit.tail.*` and `chat.*`.

## Review

### Review Verdict — 2026-05-17

PASS

Both stages passed.

**Stage 1 — Spec compliance**

- AC-1: `service.status` dispatches to `handle_service_status` and returns `{ ok: true, version, uptime_seconds }` in a JSON-RPC 2.0 response. Confirmed by `dispatch_service_status_returns_ok_with_status_object` and the end-to-end `run_connection_service_status_returns_ok_response` test. PASS.
- AC-2: `sessions.list` calls `pi_agent_supervisor::Handle::list_sessions()` (not stubbed in dispatch.rs — the call delegates to the supervisor handle). `dispatch_sessions_list_returns_empty_list_when_no_sessions` starts a real supervisor and verifies the round-trip. PASS.
- AC-3: `run_connection` sends `ErrorResponse::parse_error` (code -32700) then returns (closes) on `FrameRead::ParseError`. `run_connection_parse_error_sends_minus_32700_and_closes` verifies the -32700 code is sent and reads back EOF immediately after. PASS.
- AC-4: `map_service_error` is exhaustive over all `ServiceError` variants. Struct variants with user-supplied fields (`InvalidRequest { detail }`, `PolicyDenied { reason }`, `Persistence { detail }`, `ChildProcess { detail }`, `Configuration { detail }`) are all matched with `..` — none of those fields appear in the `data` JSON. `Timeout { operation }` includes only the `&'static str` operation name, which is compile-time only. `map_service_error_data_field_is_never_none` confirms `data` is always present for all variants. PASS.
- AC-5: `id` is `serde_json::Value` throughout; `run_connection_sequential_requests_get_matching_ids` sends three requests with ids 1, 2, 3 on the same connection and asserts each response `id` matches. Dispatcher unit tests also cover string ids. PASS.
- Files in scope: `protocol.rs` (new), `dispatch.rs` (new), `lib.rs` (modified), `Cargo.toml` (modified), `Cargo.lock` (committed alongside Cargo.toml — T-018's omission is not repeated). No unexpected files modified. PASS.

**Stage 2 — Code quality**

- Correctness: Logic is correct. Frame codec handles EOF, I/O errors, version mismatch, and malformed JSON distinctly. `DispatchOutcome` enum cleanly separates success from error paths without `unwrap`.
- Tests: 42 tests total; protocol and dispatch modules each have their own `#[cfg(test)]` block; lib.rs has end-to-end UnixStream pair tests covering AC-1, AC-3, and AC-5 at the connection level. Both success and failure paths are covered.
- Security: No hardcoded credentials. User-supplied error detail fields are stripped via `..` patterns in `map_service_error`. `Timeout::operation` is `&'static str` — cannot carry runtime user content.
- Readability: `FrameRead` enum variants are self-documenting. Functions are single-purpose. Comments reference the AC they implement (e.g. `// AC-3:`). No dead code or commented-out blocks.
- Performance: No unnecessary loops. Each frame is read and dispatched independently. Spawned tasks per connection via `tokio::spawn`. No resource leaks identified.
- rustfmt: clean (`cargo fmt -p admin-rpc -- --check` exited 0).
- clippy: clean (`cargo clippy -p admin-rpc -- -D warnings` exited 0).
- `cargo build -p bob`: clean — `Config` drops `#[derive(Debug)]` and no downstream call site formats it with `{:?}`.

**Non-blocking observations**

- `policy.reload` and `sessions.kill` return `-32601` (method not found) rather than a distinct "not yet implemented" code. This matches the spec's code table (`NotImplemented → -32601`) and is correct per the approved mapping.
- `Dispatcher::_policy` is prefixed with `_` to suppress the unused-field warning; this is idiomatic while the field is reserved for Phase 2.
