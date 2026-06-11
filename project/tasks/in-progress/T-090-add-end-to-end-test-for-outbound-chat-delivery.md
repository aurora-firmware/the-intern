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

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->
