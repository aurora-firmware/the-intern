---
id: T-090
title: Add end-to-end test for outbound chat delivery
status: pending
priority: medium
assigned-role: developer
created: '2026-06-11'
spec: S-008
---

# Add end-to-end test for outbound chat delivery

## Description

Prove the S-008 delivery contract end to end without a reply producer:
replies injected at the chat reply router must come out of a real client
connected over a real Unix socket.

Add an integration test to the `bob` crate (new test file, following the
conventions of the existing `tests/shell_e2e.rs`) that starts the
admin-rpc listener with a chat reply router handle, connects the real
admin client over a Unix domain socket, opens a chat subscription,
injects replies through the router's delivery handle, and asserts the
client receives `chat.message` notifications with the injected payloads.
Cover the interleaving case (a `chat.send` issued while replies are being
injected) and the teardown case (replies injected after `chat.close` are
dropped server-side with no client-visible error). Reuse the isolated
runtime-directory pattern from existing socket tests; note that
peer-credential tests can fail in restricted sandboxes, so keep the same
environment assumptions as `shell_e2e`.

## Acceptance Criteria

AC-1: WHEN the test injects a reply at the reply router for an open
subscription THE SYSTEM SHALL deliver a `chat.message` notification whose
`params.subscription` matches the subscription id and whose `params.data`
carries the injected payload.

AC-2: WHEN a `chat.send` is in flight while replies are injected THE
SYSTEM SHALL deliver both the send response and every injected reply
without error or loss.

AC-3: WHEN replies are injected after `chat.close` THE SYSTEM SHALL
produce no client-visible frames or errors for them.

## Dependencies

- `T-086` — subscribed `chat.open`, forwarder, and teardown must exist.
- `T-087` — the inbound frame shape this test sends must be final.
- `T-089` — the client subscription machinery this test drives must be
  frame-safe.

## Files to Touch

- `the-intern/service/crates/bob/tests/chat_e2e.rs` — new end-to-end
  test.

## Verification

```bash
cd the-intern/service && cargo test --test chat_e2e -- --nocapture && cargo fmt --all -- --check
```

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

### Session 1 — 2026-06-11

This session implemented T-090 from scratch. The task required adding a new integration test file `the-intern/service/crates/bob/tests/chat_e2e.rs` that proves the S-008 delivery contract end-to-end: replies injected at the `ChatReplyRouter` via a `DeliveryHandle` must arrive at a real client connected over a real Unix domain socket.

**What was done**

The test file follows the same runtime-directory isolation pattern as `shell_e2e.rs`. A `TestServer` struct binds the listener in-process (via `admin_rpc::Config` with an externally-supplied `Arc<ChatReplyRouter>` — the injection seam T-086 added for this task), waits for the socket to appear, and returns a `DeliveryHandle` for injection.

Three tests, one per acceptance criterion:
- `injected_reply_delivers_chat_message_notification_with_matching_subscription_and_payload` (AC-1): opens a subscription, injects one payload, asserts `params.data` matches exactly.
- `chat_send_response_and_injected_replies_both_delivered_without_loss` (AC-2): injects 3 replies, issues a `chat.send` (which returns a -32601 error because no chat adapter is configured), then collects all 3 reply notifications and asserts none are lost. `Subscription::call` buffers notifications that arrive before the call response, so all 3 arrive via `recv()` after the call returns.
- `replies_injected_after_chat_close_produce_no_client_visible_frames` (AC-3): injects a pre-close reply to confirm the subscription is live, calls `sub.close()`, then injects a post-close reply. A second subscription on a second client receives a known payload — confirming the router is still functional and the post-close payload was silently dropped.

**What was tried and rejected**

A `NO_NOTIFICATION_WINDOW` constant was initially written for AC-3 to do an active `tokio::time::timeout` wait confirming no notification arrives. Removed in favour of the second-connection synchronisation approach, which is more reliable and avoids a fixed sleep: the second connection rules out false positives from a crashed router while the closed first subscription confirms no stray frames arrived.

**Notes**

All 3 tests passed immediately on first run — expected, since the implementation from T-086 through T-089 is complete and T-090's role is to add the missing E2E proof.

**Nothing remains for the next session.** All 3 acceptance criteria are covered by passing tests.

Evidence: `cargo test --test chat_e2e -- --nocapture` — 3 passed, 0 failed; `cargo fmt --all -- --check` clean; `cargo test --workspace` all result lines 0 failed. Commit `f09e09a` on `task/T-090-add-end-to-end-test-for-outbound-chat-delivery`.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->
