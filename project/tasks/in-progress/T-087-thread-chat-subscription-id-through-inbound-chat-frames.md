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

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->
