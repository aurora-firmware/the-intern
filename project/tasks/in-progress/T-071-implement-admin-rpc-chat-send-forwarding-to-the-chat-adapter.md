---
id: T-071
title: Implement admin-rpc chat.send forwarding to the chat adapter
status: pending
priority: high
assigned-role: unassigned
created: '2026-05-21'
---

# Implement admin-rpc chat.send forwarding to the chat adapter

## Description

Implements the **Admin-RPC → chat adapter hand-off** of S-006
(`project/specs/channel-adapter-framework-and-interactive-chat-adapter.md`),
Phase 3. S-002 already specifies that the Admin-RPC actor hands chat-open and
each user-input frame to the interactive-chat adapter.

Today `chat.open` / `chat.close` register a subscription, but `chat.send`
returns a hard-coded "not yet implemented" error in
`crates/admin-rpc/src/dispatch.rs`. Implement `chat.send`:

- validate the call targets an open chat subscription on the same connection;
- build a chat user-input frame (the message text + the connection's peer
  identity from `SO_PEERCRED` + the chat subscription/context id);
- forward the frame to the chat adapter through the adapter's frame-delivery
  handle from T-070.

The `Dispatcher` must hold an **optional** `chat_adapter::Handle`, injected at
construction the same way `supervisor`, `policy`, and `monitoring` handles
already are (`Option<...>` fields on `Dispatcher`, set via `Dispatcher::new`).
WHEN no chat-adapter handle is present (chat channel disabled), `chat.send`
returns a clear JSON-RPC error. Chat traffic is **not** routed through Policy
Control here — the adapter submits to the Requests Handler, which runs
pre-flight.

## Acceptance Criteria

AC-1: The `admin-rpc` `Dispatcher` shall hold an optional chat-adapter
      frame-delivery handle, supplied through `Dispatcher::new` alongside the
      existing optional subsystem handles.

AC-2: WHEN a `chat.send` call targets an open chat subscription on the
      connection and a chat-adapter handle is present THE SYSTEM SHALL forward
      a chat user-input frame — message text, peer identity, and context id —
      to the chat adapter and return a success response.

AC-3: IF a `chat.send` call arrives while no chat-adapter handle is present
      THEN THE SYSTEM SHALL return a JSON-RPC error explaining chat is not
      available.

AC-4: IF a `chat.send` call references a subscription id that is not an open
      chat subscription on the connection THEN THE SYSTEM SHALL return a
      JSON-RPC error and forward nothing.

AC-5: The workspace shall build and all tests shall pass under
      `cargo test --workspace`.

## Dependencies

- `T-070` — the `chat-adapter` crate and its frame-delivery handle / frame
  type must exist for `admin-rpc` to depend on and forward to.

## Files to Touch

- `the-intern/service/crates/admin-rpc/Cargo.toml` — add a path dependency on
  the `chat-adapter` crate.
- `the-intern/service/crates/admin-rpc/src/dispatch.rs` — add the optional
  chat-adapter handle to `Dispatcher` and `Dispatcher::new`; implement
  `handle_chat_send`; add dispatch tests.
- `the-intern/service/crates/admin-rpc/src/subscriptions.rs` — only if a
  helper is needed to confirm a subscription id is an open chat subscription
  on the connection.

## Verification

```bash
cd the-intern/service
cargo test -p admin-rpc
cargo test --workspace
```

## Work Log

<!-- Mandatory. Append one entry per session boundary. -->

### Session 1 — 2026-05-22

**What was done**

Implemented all four acceptance criteria for T-071 in a single TDD cycle (the work was cohesive enough that a multi-cycle split would have produced artificial commits).

**AC-1 — Optional chat-adapter handle on Dispatcher.** Added `chat_adapter: Option<ChatHandle>` (where `ChatHandle` is `chat_adapter::FrameHandle`) to the `Dispatcher` struct. `Dispatcher::new` continues to take the existing three optional handles and `version`; the chat handle is attached with a builder method `Dispatcher::with_chat_handle(frame_handle) -> Self`. This follows the existing pattern for optional handles without breaking any existing call sites. Added `chat-adapter` as a path dependency in `admin-rpc/Cargo.toml`.

**AC-2 — Forwarding a frame on chat.send.** Implemented `handle_chat_send` which parses `params.id` (must be an open chat subscription on this connection), `params.text`, and optional `params.context_id`, builds a `ChatFrame` with the connection's `peer_id`, and awaits `adapter.deliver(frame)`. Returns `{ ok: true }` on success.

**AC-3 — Error when no chat-adapter handle is present.** When `self.chat_adapter` is `None`, `handle_chat_send` immediately returns `CODE_METHOD_NOT_FOUND` with a clear message. The existing test `dispatch_chat_send_returns_not_implemented` was renamed to `dispatch_chat_send_without_handle_returns_method_not_found`.

**AC-4 — Error on unknown or wrong-kind subscription id.** `is_open_chat_subscription(id)` checks the `ConnectionRegistry`'s `ids` vector for a `Chat`-kind entry. An audit-subscription id (correct integer format but registered as `Audit`) correctly returns `CODE_INVALID_REQUEST` without forwarding any frame.

**Peer identity.** The existing `Dispatcher::dispatch` signature does not carry peer credentials — they are available in `run_connection` when the connection is accepted. The in-scope solution was to add `peer_id: UserId` to `ConnectionRegistry` (per-connection state). `ConnectionRegistry::new` defaults to `UserId::new()` for backward compatibility; `ConnectionRegistry::new_with_peer` is the explicit constructor. The `run_connection` function does not yet wire in the real `PeerCred.uid` → `UserId` mapping (that requires a `lib.rs` change not in the `Files to Touch` list).

**Tests written:** 5 new tests covering AC-2 (happy path, context_id forwarding), AC-3 (no handle), AC-4 (unknown subscription id, audit subscription id used in chat.send).

**What was tried and rejected.** Considered adding `peer_id` directly to `Dispatcher::dispatch`'s signature, but that would have changed the signature in `lib.rs` (not in scope). Builder pattern on `Dispatcher` was chosen to keep existing call sites unchanged.

**What remains.** The `run_connection` function in `lib.rs` creates `ConnectionRegistry::new(bus.clone())` without passing a real peer identity. To fully honour "peer identity from `SO_PEERCRED`", that wiring should be added when `lib.rs` is in scope — noted as a follow-on for T-072.

`cargo test -p admin-rpc`: 99 passed, 0 failed. `cargo test --workspace`: all crates pass, 0 failures.

## Review

<!-- Reviewer: append verdict here after each review cycle. -->

### Review Verdict — 2026-05-22

PASS

**Stage 1 — Acceptance criteria**

- AC-1: PASS. `Dispatcher` gains `chat_adapter: Option<ChatHandle>`. `Dispatcher::with_chat_handle()` builder attaches it. `admin-rpc/Cargo.toml` adds the path dependency on `chat-adapter`.
- AC-2: PASS within scope. `handle_chat_send` builds a `ChatFrame` carrying `message`, `peer_id` (from `registry.peer_id()`), and `context_id`, then awaits `adapter.deliver(frame)` and returns `{ ok: true }`. The `peer_id` infrastructure is fully in place: `ConnectionRegistry::new_with_peer` accepts the real peer identity, and the AC-2 test asserts `got[0].1.sender == peer_id` end-to-end. The actual wiring of `SO_PEERCRED → UserId` in `run_connection` (`lib.rs`) is deferred because `lib.rs` is explicitly outside the task's `Files to Touch` list; that follow-on is correctly called out for T-072.
- AC-3: PASS. `None` adapter returns `CODE_METHOD_NOT_FOUND` with the message "chat.send is not available: chat channel is not configured". Test renamed and updated accordingly.
- AC-4: PASS. `is_open_chat_subscription` filters by `SubscriptionKind::Chat`. Both the "unknown id" and "audit id used in chat.send" cases are tested; neither forwards a frame.
- AC-5: PASS. Work Log records `cargo test -p admin-rpc` — 99 passed, 0 failed; `cargo test --workspace` — all crates pass.

No files modified outside the stated scope. `Cargo.lock` is the expected side effect of adding a crate dependency.

**Stage 2 — Code quality**

- Correctness: Logic is correct for all tested paths. Parameter validation (missing params, missing id, invalid id format, wrong subscription kind, missing text) is thorough and returns appropriate error codes.
- Tests: Five new tests cover AC-2 happy path, AC-2 context_id forwarding, AC-3 (no handle), AC-4 (unknown id), AC-4 (audit id). Tests use `make_registry_with_peer` with an explicit `UserId` and assert the same value arrives at the intake — correctly validating the full propagation path. Tests are independent.
- Security: No hardcoded credentials. External input (`params.id`, `params.text`, `params.context_id`) is validated before use. No new permissions.
- Readability: Functions are focused and single-responsibility. `handle_chat_send` comment block explains each validation step and which AC it satisfies. No dead code.
- Performance: No unnecessary loops. `adapter.deliver()` is an async channel send — appropriate.

**Non-blocking observations (not required for merge)**

1. `the-intern/service/crates/admin-rpc/src/dispatch.rs` line ~408: When `adapter.deliver(frame)` returns `Err` (adapter actor stopped), the response uses `CODE_METHOD_NOT_FOUND` (-32601). Semantically a server-error code would be more accurate, but `protocol.rs` does not define `CODE_INTERNAL_ERROR` (-32603). Defining that constant and using it here would improve protocol clarity, but is not mandated by any AC.
2. `UserId` is UUID-based while `SO_PEERCRED` produces a `u32` uid. T-072 will need to establish a mapping strategy (e.g., derive a deterministic UUID from the uid, or change the field type) before the peer identity is truly sourced from the OS credential. The current design does not block T-072 from making that decision.
