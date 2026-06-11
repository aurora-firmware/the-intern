---
id: T-085
title: Implement chat reply router in admin-rpc
status: pending
priority: high
assigned-role: developer
created: '2026-06-11'
spec: S-008
---

# Implement chat reply router in admin-rpc

## Description

Create the service-scoped chat reply router defined as Component 1 of
S-008: the single entry point through which any producer delivers a reply
addressed to an open chat subscription.

Add a new module to the `admin-rpc` crate. It maintains a registry of open
chat subscription ids (`AdminSubscriptionId`), each with a bounded queue.
It exposes, at minimum:
- registration: register a subscription id, receiving the consume end of
  its queue; deregister it on close;
- a cheaply cloneable, `Send + Sync` delivery handle: deliver a reply
  payload (JSON value) addressed to a subscription id.

Replies addressed to unknown or deregistered ids are dropped with a
`tracing` log entry; delivery never returns an error for that case. A full
queue evicts the slow subscriber, mirroring the slow-consumer policy of the
existing `SubscriptionBus` in `crates/admin-rpc/src/subscriptions.rs`
(which is per-connection and stays untouched by this task). This task is
pure plumbing: nothing calls the router yet (T-086 wires `chat.open`).

## Acceptance Criteria

AC-1: WHEN a reply is delivered for a registered subscription id THE
SYSTEM SHALL make it available on that subscription's receiver in delivery
order.

AC-2: IF a reply is delivered for an unknown or deregistered subscription
id THEN THE SYSTEM SHALL drop it, emit a log entry, and report success to
the producer.

AC-3: IF a subscription's bounded queue is full THEN THE SYSTEM SHALL
evict that subscription rather than block or fail the producer.

AC-4: The system shall support concurrent delivery from multiple cloned
handles without loss of replies addressed to registered subscriptions.

AC-5: WHEN a subscription is deregistered THE SYSTEM SHALL close its
receiver so an awaiting consumer observes end-of-stream.

## Dependencies

- None

## Files to Touch

- `the-intern/service/crates/admin-rpc/src/chat_router.rs` — new module:
  registry, bounded queues, delivery handle, unit tests.
- `the-intern/service/crates/admin-rpc/src/lib.rs` — module declaration
  and public re-exports.

## Verification

```bash
cd the-intern/service && cargo test -p admin-rpc chat_router && cargo fmt --all -- --check
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
