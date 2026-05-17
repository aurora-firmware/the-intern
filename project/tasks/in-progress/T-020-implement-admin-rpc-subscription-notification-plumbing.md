---
id: T-020
title: Implement admin-rpc subscription notification plumbing
status: pending
priority: high
assigned-role: unassigned
created: '2026-05-16'
spec: S-001
---

# Implement admin-rpc subscription notification plumbing

## Description

Extend T-019's dispatcher with subscription support per S-002 §Component 4
("Subscriptions"). New methods:

- `audit.tail.subscribe` → returns a fresh `SubscriptionId`; server later
  emits JSON-RPC notifications with method `audit.event` and
  `params.subscription = <id>` whenever Monitoring publishes a record.
- `audit.tail.unsubscribe` → removes the subscription.
- `chat.open` → returns a `SubscriptionId`; server emits `chat.message`
  notifications. The connection also accepts `chat.send` calls on the same
  socket to forward user input into the chat channel adapter.
- `chat.close` → ends the chat subscription.

A per-connection subscription registry tracks open ids; an internal
`SubscriptionBus` fans out events from producer handles to subscribers via
bounded mpsc. If a subscriber's outbound queue stays full beyond a configured
deadline, the subscription is dropped and the connection closed with a
`tracing::warn!`.

## Acceptance Criteria

AC-1: WHEN an admin client sends `audit.tail.subscribe` THE SYSTEM SHALL respond with a JSON-RPC result containing a fresh subscription id and register the subscription.
AC-2: WHEN the monitoring actor publishes an audit record while a subscription is open THE SYSTEM SHALL emit a JSON-RPC 2.0 notification with method `audit.event` whose `params.subscription` equals the registered id.
AC-3: WHEN a client sends `audit.tail.unsubscribe` with a valid subscription id THE SYSTEM SHALL remove the subscription and respond with `{"ok": true}`.
AC-4: IF a subscriber's outbound queue stays full beyond the configured deadline THEN THE SYSTEM SHALL drop the subscription, close the connection, and emit a `tracing::warn!` event identifying the subscription id.
AC-5: WHEN the connection holding a subscription is closed THE SYSTEM SHALL remove every subscription registered on that connection without leaking entries.

## Dependencies

- `T-019` — JSON-RPC dispatcher to extend

## Files to Touch

- `the-intern/service/crates/admin-rpc/src/subscriptions.rs` — new; registry + fan-out
- `the-intern/service/crates/admin-rpc/src/dispatch.rs` — touch; register subscription methods
- `the-intern/service/crates/admin-rpc/src/lib.rs` — touch; expose subscription bus to consumers

## Verification

```bash
cd the-intern/service && cargo test -p admin-rpc subscriptions
```

## Work Log

## Review
