---
id: T-070
title: Create the chat-adapter crate with the chat-normalization actor
status: pending
priority: high
assigned-role: unassigned
created: '2026-05-21'
---

# Create the chat-adapter crate with the chat-normalization actor

## Description

Implements **Component 4 (Interactive-chat adapter)** of S-006
(`project/specs/channel-adapter-framework-and-interactive-chat-adapter.md`),
inbound half — Phase 3.

Create a new workspace crate, `chat-adapter`, holding the interactive-chat
adapter as a standard subsystem actor (S-006 Approach B: no shared adapter
trait — follow the existing actor pattern used by `requests-handler` and
`persistence`). The actor:

- receives **chat user-input frames** — each frame carries the message text,
  the originating peer identity (a `UserId`), and a conversation/context id;
- normalizes each frame into an `InternalEvent` with `kind:
  DeliveryKind::Sync` and `payload` set to the message text;
- builds the matching `RequestContext` (`sender` = peer `UserId`, `source` =
  the chat `ChannelId`, `context_id` = the conversation id);
- submits the `(InternalEvent, RequestContext)` pair through the
  requests-handler intake handle from T-068.

Define the chat-input-frame type and a cloneable **frame-delivery handle** in
this crate; the admin-RPC actor will hold that handle (T-071) and `bob serve`
will inject it (T-072). Expose a `start`-style function returning the
frame-delivery handle plus a join handle, mirroring the existing subsystems.
The adapter carries **no policy logic** and never bypasses the Requests
Handler. Register the crate in the workspace manifest.

## Acceptance Criteria

AC-1: The workspace shall contain a `chat-adapter` crate registered as a member
      in the workspace `Cargo.toml`.

AC-2: WHEN the chat adapter receives a chat user-input frame THE SYSTEM SHALL
      submit, through the requests-handler intake handle, an `InternalEvent`
      whose `kind` is `DeliveryKind::Sync` and whose `payload` is the frame's
      message text, paired with a `RequestContext` built from the frame's peer
      identity, the chat `ChannelId`, and the frame's context id.

AC-3: The `chat-adapter` crate shall expose a cloneable frame-delivery handle
      and a start function returning that handle together with a join handle,
      following the existing subsystem-actor pattern.

AC-4: IF the chat adapter performs any authorization or policy decision itself
      THEN the task shall be considered incomplete — it must only normalize and
      submit.

AC-5: The workspace shall build and `cargo test -p chat-adapter` shall pass.

## Dependencies

- `T-068` — the requests-handler intake handle must already accept an
  `InternalEvent` together with its `RequestContext`.

## Files to Touch

- `the-intern/service/Cargo.toml` — add `crates/chat-adapter` to workspace
  members.
- `the-intern/service/crates/chat-adapter/Cargo.toml` — new crate manifest
  (depends on `bob-core` and `requests-handler`).
- `the-intern/service/crates/chat-adapter/src/lib.rs` — new; the adapter
  actor, the chat-input-frame type, the frame-delivery handle, the start
  function, and unit tests.

## Verification

```bash
cd the-intern/service
cargo test -p chat-adapter
cargo build --workspace
```

## Work Log

<!-- Mandatory. Append one entry per session boundary. -->

## Review

<!-- Reviewer: append verdict here after each review cycle. -->
