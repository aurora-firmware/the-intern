---
id: T-072
title: Wire the chat adapter into bob serve with supervision and shutdown
status: pending
priority: high
assigned-role: unassigned
created: '2026-05-21'
---

# Wire the chat adapter into bob serve with supervision and shutdown

## Description

Implements **Component 3 (Adapter supervision wiring)** of S-006
(`project/specs/channel-adapter-framework-and-interactive-chat-adapter.md`),
Phase 2 — and closes the end-to-end inbound path.

`bob serve` (`crates/bob/src/serve.rs`) currently constructs every subsystem
actor and tears them down in its graceful-shutdown sequence, but nothing
constructs a channel adapter. Wire the interactive-chat adapter into that
sequence:

- read the channels configuration (T-069); WHILE the chat channel is enabled,
  start the chat adapter (T-070), passing it the requests-handler intake
  handle;
- inject the adapter's frame-delivery handle into the Admin-RPC `Dispatcher`
  (the optional chat-adapter handle from T-071);
- WHILE the chat channel is disabled, construct neither the adapter nor the
  handle — the `Dispatcher` receives `None` and `chat.send` reports chat
  unavailable;
- include the chat adapter in the existing graceful-shutdown sequence so it
  stops cleanly with the other actors (drop its handle / signal cancellation,
  await its join handle).

This task is wiring only — it adds no new behaviour beyond construction,
injection, and shutdown ordering. It is the last task of S-006: after it, a
`bob chat` message travels through admin-RPC, the chat adapter, the intake
handle, and the Requests Handler pre-flight.

## Acceptance Criteria

AC-1: WHILE the chat channel is enabled in configuration THE SYSTEM SHALL, at
      `bob serve` startup, construct the chat adapter and inject its
      frame-delivery handle into the Admin-RPC `Dispatcher`.

AC-2: WHILE the chat channel is disabled in configuration THE SYSTEM SHALL
      construct neither the chat adapter nor its handle, and the Admin-RPC
      `Dispatcher` shall receive no chat-adapter handle.

AC-3: WHEN `bob serve` performs graceful shutdown THE SYSTEM SHALL stop the
      chat adapter cleanly as part of the existing shutdown sequence, with no
      hang or panic.

AC-4: The full Rust workspace shall build and all tests shall pass under
      `cargo test --workspace`, including the existing `shell_e2e` test.

## Dependencies

- `T-068` — `bob serve` per-request-context wiring (same file, `serve.rs`).
- `T-069` — the channels configuration the wiring reads.
- `T-070` — the `chat-adapter` crate being constructed.
- `T-071` — the Admin-RPC `Dispatcher` accepting the optional chat-adapter
  handle.

## Files to Touch

- `the-intern/service/crates/bob/src/serve.rs` — construct and supervise the
  chat adapter; inject its handle into the `Dispatcher`; extend the
  graceful-shutdown sequence.
- `the-intern/service/crates/bob/Cargo.toml` — add a path dependency on the
  `chat-adapter` crate.

## Verification

```bash
cd the-intern/service
cargo test --workspace
cargo test --test shell_e2e -- --nocapture
```

## Work Log

<!-- Mandatory. Append one entry per session boundary. -->

## Review

<!-- Reviewer: append verdict here after each review cycle. -->
