---
id: T-087
title: Thread chat subscription id through inbound chat frames
status: pending
priority: medium
assigned-role: developer
created: '2026-06-11'
spec: S-008
---

# Thread chat subscription id through inbound chat frames

## Description

Carry the reply address with each inbound chat message (Component 3 of
S-008) so the future Phase-2 reply producer can address replies without
consulting any other component.

`handle_chat_send` in `crates/admin-rpc/src/dispatch.rs` validates
`params.id` (the chat subscription id) and then builds a `ChatFrame`
(defined in `crates/chat-adapter/src/lib.rs`) that today carries only the
message, peer identity, and optional `context_id`. Extend the frame with
the originating subscription id (string form, so `chat-adapter` does not
depend on admin-rpc types), populate it in `handle_chat_send`, and
preserve it on the `RequestContext` (defined in
`crates/bob-core/src/types/event.rs`) as an optional reply-address field
when the chat-adapter actor submits the event to intake. Non-chat
construction sites of `RequestContext` leave the field absent. No consumer
reads the field yet; this task only guarantees it survives to the queued
event, proven by tests at the adapter boundary.

## Acceptance Criteria

AC-1: WHEN dispatch accepts a `chat.send` THE SYSTEM SHALL attach the
validated subscription id to the chat frame delivered to the chat-adapter.

AC-2: WHEN the chat-adapter submits the event to intake THE SYSTEM SHALL
preserve the subscription id on the submitted request context as an
optional reply address.

AC-3: The system shall leave the reply address absent for events that do
not originate from `chat.send`, without breaking existing
`RequestContext` construction sites or tests.

AC-4: The system shall not change which `chat.send` requests are accepted
or rejected.

## Dependencies

- `T-086` — modifies the same dispatch code paths; land the subscribed
  `chat.open` flow first to avoid conflicting edits.

## Files to Touch

- `the-intern/service/crates/chat-adapter/src/lib.rs` — `ChatFrame` field
  and actor pass-through, plus tests.
- `the-intern/service/crates/admin-rpc/src/dispatch.rs` — populate the
  address in `handle_chat_send`.
- `the-intern/service/crates/bob-core/src/types/event.rs` — optional
  reply-address field on `RequestContext`.

## Verification

```bash
cd the-intern/service && cargo test -p chat-adapter -p admin-rpc && cargo test --workspace && cargo fmt --all -- --check
```

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

### Session 1 — 2026-06-11

Implemented T-087 in two TDD cycles.

**Cycle 1 — `reply_address` on `RequestContext`:** Added an optional `reply_address: Option<String>` field to `RequestContext` in `bob-core/src/types/event.rs`. The field represents the reply address for chat events and is absent for all other event sources. Added two tests: one confirming the field is `None` on non-chat contexts, one confirming a `Some` value survives a serde JSON round-trip. All ten existing construction sites across `bob`, `bob-core`, `requests-handler`, and `bob/tests` were updated to supply `reply_address: None`.

**Cycle 2 — `subscription_id` on `ChatFrame` and end-to-end threading:** Added a required `subscription_id: String` field to `ChatFrame` in `chat-adapter/src/lib.rs`. The actor's receive loop was updated to set `reply_address: Some(frame.subscription_id)` on the `RequestContext` it builds. In `handle_chat_send` in `admin-rpc/src/dispatch.rs`, the already-validated `sub_id` is now passed as `subscription_id` when constructing the `ChatFrame`. All existing `ChatFrame` construction sites in tests were updated with representative subscription id strings.

Two new tests were added: `chat_frame_subscription_id_is_preserved_as_reply_address_on_request_context` in the chat-adapter (adapter boundary) and `dispatch_chat_send_attaches_subscription_id_as_reply_address_on_request_context` in admin-rpc (full path from dispatch through adapter to intake). Both pass. No acceptance or rejection logic changed.

**Considered but rejected:** Making `subscription_id` optional (`Option<String>`) on `ChatFrame`. This would have avoided updating construction sites, but would have required the actor to handle `None` and always produce `reply_address: None` for frames without it. Since every frame delivered via `chat.send` has a subscription id by construction, making it required is cleaner and eliminates a class of bugs.

**Note on files touched:** adding the required field to `RequestContext` (owned by `bob-core`, in scope) required updating 10 construction sites across 6 files; sites outside Files to Touch are tests and non-production helper code, all strictly additive (`reply_address: None`).

**Remains:** Nothing. All acceptance criteria are met; the full workspace test suite passes; formatting is clean.

Evidence: `cargo test -p bob-core` — 78 passed; `cargo test -p chat-adapter -p admin-rpc` — 108 + 9 passed; `cargo test --workspace` all pass; `cargo fmt --all -- --check` clean. Two commits on `task/T-087-thread-chat-subscription-id-through-inbound-chat-frames`.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->
