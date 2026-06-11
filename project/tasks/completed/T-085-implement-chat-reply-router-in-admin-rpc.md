---
id: T-085
title: Implement chat reply router in admin-rpc
status: completed
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

### Session 1 — 2026-06-11

Implemented Component 1 of S-008 (the chat reply router) in a single red→green→refactor→commit cycle.

**What was done**

Created `the-intern/service/crates/admin-rpc/src/chat_router.rs` with the full `ChatReplyRouter` + `DeliveryHandle` implementation, and added `pub mod chat_router;` to `lib.rs`. The module provides:

- `ChatReplyRouter::new()` / `Default` — creates an empty service-scoped registry backed by an `Arc<Mutex<RouterState>>`.
- `register(id)` → `ChatReplyReceiver` — allocates a bounded (`REPLY_QUEUE_CAPACITY = 64`) per-subscription mpsc channel, stores the sender, returns the receiver (AC-1, AC-5).
- `deregister(id)` → `bool` — removes and drops the sender, causing the receiver to observe end-of-stream (AC-5).
- `delivery_handle()` → `DeliveryHandle` — cheaply cloneable (`Clone`), `Send + Sync` handle sharing the same `Arc<Mutex<RouterState>>`.
- `DeliveryHandle::deliver(id, payload)` — synchronous `try_send`: on unknown/deregistered id emits a WARN tracing entry and returns normally (AC-2); on full queue evicts the subscription immediately (AC-3); on success places the payload in order (AC-1).

Eight unit tests cover all five acceptance criteria, including a 4-sender concurrent delivery test (AC-4) that runs on a multi-thread Tokio executor. The `delivery_handle_is_clone_send_sync` test is a compile-time proof that the type bounds hold.

**What was tried and rejected**

Considered adding a `slow_since` timestamp map (mirroring `SubscriptionBus`'s deadline-based eviction) to give slow chat consumers a grace window before eviction. Rejected: the task says "evict rather than block or fail the producer" and the spec says eviction is "immediate" — the deadline-based approach would require spawning a timer or a second publish call, which adds complexity that AC-3 does not ask for.

**Decisions**

- Used `Arc<Mutex<RouterState>>` (sync mutex) rather than `Arc<tokio::sync::Mutex<...>>` so `deliver` stays synchronous: there is no `await` point inside the lock, so a sync mutex is cheaper and avoids holding the lock across awaits.
- `ChatReplyReceiver` is a type alias for `mpsc::Receiver<serde_json::Value>`; the payload is a raw JSON `Value` so the router has no coupling to higher-level frame types (T-086 wires the framing).
- Capacity constant `REPLY_QUEUE_CAPACITY = 64` matches the `SUBSCRIBER_CAPACITY` in `subscriptions.rs` for consistency.

**What remains**

Nothing for this task. T-086 wires `chat.open` to call `register` and spawns the chat forwarder; T-087 and later tasks handle frame framing, CLI changes, and end-to-end tests.

Evidence: `cargo test -p admin-rpc chat_router` — 8 tests pass; `cargo test -p admin-rpc` — 102 tests pass; `cargo fmt --all -- --check` clean. Commit `5f02ad4` on `task/T-085-implement-chat-reply-router-in-admin-rpc`.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->

### Review Verdict — 2026-06-11

PASS

Stage 1 (acceptance criteria): all five ACs confirmed against the implementation and tests.

- AC-1: `deliver` places payloads in FIFO order on the per-subscription `mpsc` channel; test `deliver_makes_payload_available_on_registered_receiver_in_order` asserts two payloads arrive in the delivered sequence.
- AC-2: `deliver` emits `tracing::warn!` for both unknown ids and deregistered ids and returns normally without error; two dedicated tests cover each case.
- AC-3: `deliver` uses `try_send` and removes the sender on `TrySendError::Full`; test `deliver_evicts_slow_subscriber_when_queue_is_full` fills the queue to capacity, sends one overflow message, and asserts the subscription is absent from the registry.
- AC-4: test `concurrent_delivery_from_multiple_handles_delivers_all_payloads` runs four tasks each delivering eight payloads on a `multi_thread` Tokio executor with four workers, and asserts all 32 arrive without loss.
- AC-5: `deregister` drops the sender, closing the channel; test `deregister_closes_receiver_so_consumer_observes_end_of_stream` asserts `recv().await` returns `None` immediately after deregistration.

Only the two specified files were modified (`chat_router.rs` new, `lib.rs` module declaration added).

Stage 2 (code quality): no issues found.

- Correctness: the sender is cloned out of the lock before calling `try_send`, so the lock is not held across any blocking call. The eviction re-lock on `TrySendError::Full` is correct and the absence of the key on a second concurrent eviction is a harmless no-op.
- Tests: eight independent unit tests with descriptive names; each constructs its own fixtures; no shared mutable state.
- Security: no hardcoded secrets; payload type is `serde_json::Value` (already validated upstream at the wire boundary).
- Readability: module-level doc covers design, registration lifecycle, and delivery semantics; all public items are documented with AC cross-references; naming follows project conventions.
- Performance: sync `Mutex` is appropriate (no `await` inside the lock); `try_send` is non-blocking; `REPLY_QUEUE_CAPACITY = 64` matches `SUBSCRIBER_CAPACITY` in `subscriptions.rs`.
- Format: `cargo fmt --all -- --check` clean.
