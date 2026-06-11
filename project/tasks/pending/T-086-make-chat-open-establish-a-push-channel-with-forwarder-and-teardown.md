---
id: T-086
title: Make chat.open establish a push channel with forwarder and teardown
status: pending
priority: high
assigned-role: developer
created: '2026-06-11'
spec: S-008
---

# Make chat.open establish a push channel with forwarder and teardown

## Description

Wire `chat.open` to the reply router from T-085 so chat subscriptions get
a real push channel, following the proven `audit.tail.subscribe` pattern
(Component 2 of S-008).

`handle_chat_open` in `crates/admin-rpc/src/dispatch.rs` currently calls
`registry.open_chat()` (which drops the bus receiver) and returns
`DispatchOutcome::Ok`. Change it to register the new subscription id with
the reply router and return `DispatchOutcome::Subscribed` with the
router-backed receiver, so the connection loop in
`crates/admin-rpc/src/lib.rs` spawns a forwarder for it. The chat
forwarder writes notification frames with method `chat.message` and params
`{subscription, data}` (S-008 wire contract; the audit forwarder at
`lib.rs:271` shows the frame construction pattern). `chat.close` and
connection drop must deregister the id from the router and cancel the
forwarder. The per-connection authorization for `chat.send`
(`is_open_chat_subscription`) keeps working exactly as today; the old
per-connection bus path for chat in `subscriptions.rs` is removed or
bypassed in favour of the router-backed channel.

Architect preflight guidance: expose the reply router through
`admin_rpc::Config` (mirroring the existing `audit_bus` / `chat_adapter`
fields, auto-created internally when absent) so T-090's in-process test
can retain a delivery-handle clone for injection; production `serve.rs`
then needs no change.

## Acceptance Criteria

AC-1: WHEN a client sends `chat.open` THE SYSTEM SHALL return `result.id`
and subsequently deliver replies injected at the reply router for that id
to the same connection as notifications with method `chat.message` and
`params.subscription` equal to that id.

AC-2: WHEN a client sends `chat.close` for its open subscription THE
SYSTEM SHALL deregister it from the reply router and stop its forwarder,
so later injected replies are dropped and logged.

AC-3: WHEN a connection closes while a chat subscription is open THE
SYSTEM SHALL deregister that subscription and stop its forwarder without
affecting subscriptions on other connections.

AC-4: The system shall continue rejecting `chat.send` whose `params.id`
does not reference an open chat subscription on the same connection.

AC-5: WHILE a `chat.send` response is pending on a connection THE SYSTEM
SHALL deliver any queued reply notifications as whole, well-formed frames
(no interleaving inside a frame).

## Dependencies

- `T-085` — the reply router provides the registration interface and
  receivers this task consumes.

## Files to Touch

- `the-intern/service/crates/admin-rpc/src/dispatch.rs` — `chat.open` /
  `chat.close` outcomes; router registration.
- `the-intern/service/crates/admin-rpc/src/lib.rs` — chat forwarder and
  connection-loop wiring; teardown on disconnect.
- `the-intern/service/crates/admin-rpc/src/subscriptions.rs` — retire the
  dead per-connection chat bus path.

## Verification

```bash
cd the-intern/service && cargo test -p admin-rpc && cargo fmt --all -- --check
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
