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

## Review

<!-- Reviewer: append verdict here after each review cycle. -->
