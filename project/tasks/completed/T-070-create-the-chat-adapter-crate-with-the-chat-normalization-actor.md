---
id: T-070
title: Create the chat-adapter crate with the chat-normalization actor
status: completed
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

### Session 1 — 2026-05-22

Created the `chat-adapter` workspace crate from scratch following the existing actor pattern (matches `persistence` and `requests-handler`).

**What was done:**

AC-1 was satisfied automatically by the workspace's `members = ["crates/*"]` glob — creating the directory and `Cargo.toml` was all that was needed.

The crate defines three public items in a single `lib.rs` file (under 300 lines):
- `ChatFrame` — the inbound frame type carrying `message`, `peer_id`, and `context_id`.
- `FrameHandle` — a cheaply cloneable handle backed by an `mpsc::Sender<ChatFrame>`; exposes `deliver()` and `channel_id()`.
- `start(intake, channel_id, frame_buffer)` — spawns the actor and returns `(FrameHandle, JoinHandle<()>)`.

The `Actor` struct receives frames from the channel, constructs `InternalEvent { kind: DeliveryKind::Sync, payload: frame.message }` and `RequestContext { sender: frame.peer_id, source: channel_id, context_id: frame.context_id }`, then calls `intake.submit_event()`. No branching on peer identity or any other policy decision is present.

Eight tests cover: full normalisation round-trip (AC-2), `context_id: None` forwarding (AC-2), multiple frames in order (AC-2), `FrameHandle` clone (AC-3), two clones reaching the same actor (AC-3), `channel_id()` accessor (AC-3), all-peer-identities forwarded without filtering (AC-4), and `deliver()` returning an error after the actor stops (AC-3 shutdown path).

**What was tried and rejected:**

Considered placing the test helper `make_intake` outside the `#[cfg(test)]` block as a public test-helper module, but kept it inside the test module. Considered using `tokio::time::sleep` in tests to wait for the actor instead of `yield_now()`, but `yield_now()` is sufficient for `current_thread` flavour tests.

**What remains:**

Nothing — all five acceptance criteria are met. `cargo test -p chat-adapter` (8 passed) and `cargo build --workspace` both pass cleanly. Commit `6cd0bdb` on `task/T-070-create-chat-adapter-crate`.

## Review

<!-- Reviewer: append verdict here after each review cycle. -->

### Review Verdict — 2026-05-22

PASS

Both stages passed.

**Stage 1 — Spec compliance**

- AC-1: `chat-adapter` crate directory created under `crates/`; the workspace uses a `members = ["crates/*"]` glob so registration is automatic. Confirmed present in workspace build.
- AC-2: `Actor::run` constructs `InternalEvent { kind: DeliveryKind::Sync, payload: frame.message }` and `RequestContext { sender: frame.peer_id, source: channel_id, context_id: frame.context_id }` unconditionally for every received frame, then calls `intake.submit_event(event, context)`. All three frame fields map to exactly the fields specified.
- AC-3: `FrameHandle` derives `Clone`. `start()` returns `(FrameHandle, JoinHandle<()>)`. `deliver()` and `channel_id()` accessors are present and documented.
- AC-4: The actor loop contains no branching on peer identity, message content, or any policy-relevant field. Every frame is forwarded.
- AC-5: `cargo test -p chat-adapter` — 8 passed, 0 failed. `cargo build --workspace` — finished cleanly with no errors.

No files modified outside the stated scope. `Cargo.lock` is the only additional changed file (expected for a new crate).

**Stage 2 — Code quality**

- Correctness: `frame_buffer.max(1)` correctly guards against zero-capacity channels. Submit errors are logged at `WARN` and do not panic; appropriate for an adapter that must not crash the caller. No off-by-one or null-reference issues.
- Tests: 8 tests cover all five acceptance criteria — including the `None` context_id path, multi-frame ordering, cloned-handle delivery, and the post-shutdown error path. Tests are independent; each constructs its own fixtures.
- Security: `#![forbid(unsafe_code)]` present. No hardcoded secrets. The `WARN` log on submit failure records the error category only, not frame content.
- Readability: Names follow project conventions (`UpperCamelCase` types, `snake_case` functions). `Actor`, `FrameHandle`, and `ChatFrame` each have a single responsibility. Comments explain purpose. No dead code or commented-out blocks.
- Performance: Bounded `mpsc` channel; `ChannelId` is `Copy` so `channel_id()` is a register copy. No unnecessary allocations in the hot path.

Minor observation (non-blocking): `start` is annotated `#[must_use]` at the function level rather than on the return type. Both forms are accepted by the compiler and produce the same caller-side warning; this is idiomatic for functions where the entire return value should not be discarded.
