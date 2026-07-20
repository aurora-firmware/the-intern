---
id: T-086
title: Make chat.open establish a push channel with forwarder and teardown
status: completed
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

### Session 1 — 2026-06-11

**What was done:**

Implemented all five acceptance criteria for T-086, wiring `chat.open` to the reply router (T-085's `ChatReplyRouter`) and connecting the forwarder in the connection loop, following the `audit.tail.subscribe` pattern.

**Changes made:**

`dispatch.rs` — Added two new `DispatchOutcome` variants: `ChatSubscribed` (carries response, id, router receiver, cancel receiver) and `ChatUnsubscribed`. Added `chat_router: Option<Arc<ChatReplyRouter>>` field to `Dispatcher` with a `with_chat_router()` builder and a `chat_router()` accessor. Changed `handle_chat_open` to call `registry.open_chat()` (which now returns `(id, cancel_rx)`) and register with the router via `router.register(id)`, returning `ChatSubscribed`. Changed `handle_chat_close` to call `router.deregister(id)` before returning `ChatUnsubscribed`. Updated all tests that previously matched `DispatchOutcome::Ok` for chat.open/chat.close.

`lib.rs` — Added `chat_router: Option<Arc<ChatReplyRouter>>` field to `Config` (auto-created when absent so `serve.rs` requires no change). In `start()`, created or adopted the router and attached it to the dispatcher via `with_chat_router`. In `run_connection`, attached the router to the `ConnectionRegistry` via `with_chat_router` for teardown on drop. Added `chat_forwarder` function (mirrors `audit_forwarder`) that reads from the per-subscription reply queue and emits `chat.message` notifications with `{subscription, data}` params. Wired `ChatSubscribed`/`ChatUnsubscribed` in the `read_loop` match arm. Added integration tests for AC-1 through AC-5.

`subscriptions.rs` — Retired the old bus-based chat path. `open_chat()` now returns `(AdminSubscriptionId, oneshot::Receiver<()>)` using the same cancel-sender pattern as audit subscriptions. Added `chat_cancel_txs` and `next_chat_id` fields. `close_chat()` drops the cancel sender (signals forwarder to exit). Added `chat_router: Option<Arc<ChatReplyRouter>>` to the registry so `Drop` can deregister remaining chat subscriptions from the router on connection close. Removed `bus` field from `ConnectionRegistry` (old bus path fully retired); updated `new()` to take no arguments. Updated all affected tests.

**What was tried and rejected:**

Initially considered having the `Dispatcher` hold only a `DeliveryHandle` (the write-only side of the router), but realized `handle_chat_open` needs to call `router.register(id)` to get the per-subscription receiver. Changed the field to `Option<Arc<ChatReplyRouter>>` since `Arc` is `Clone` and the router struct wraps shared state. A method `with_chat_router(Arc<ChatReplyRouter>)` makes the injection point clear.

**Decisions:**

- The router is auto-created inside `start()` when `Config::chat_router` is `None`, so production code (`bob::serve`) needs no change.
- `ConnectionRegistry::new()` no longer takes a `SubscriptionBus` argument since chat subscriptions no longer use the bus. The bus infrastructure (`SubscriptionBus`, `Config::audit_bus`) is retained as a public API.
- Chat-close ordering: `registry.close_chat(id)` is called before `router.deregister(id)` in `handle_chat_close`. This means the cancel sender is dropped first, which signals the forwarder. The forwarder may race with one final delivery from the queue, but since the router deregistration also happens before the forwarder fully exits, the router's `senders` entry is removed before any new delivery arrives. This matches the audit forwarder's cancellation semantics.

**What remains:**

Nothing in task scope. AC-1 through AC-5 are all covered by tests. T-090 can inject a `ChatReplyRouter` via `Config::chat_router` to obtain a `DeliveryHandle` for in-process reply injection.

Evidence: `cargo test -p admin-rpc` — 107 passed, 0 failed; `cargo fmt --all -- --check` clean; `cargo test --workspace` all suites pass. Commit `9f24e46` on `task/T-086-make-chat-open-establish-a-push-channel-with-forwarder-and-teardown`.

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

Both stages passed.

**Stage 1 — Acceptance Criteria**

- AC-1: `chat.open` returns `result.id`; a reply injected via the router reaches the connection as a `chat.message` notification with `params.subscription` equal to that id. Covered end-to-end by `run_connection_chat_open_delivers_chat_message_notification`. PASS.
- AC-2: `chat.close` deregisters from the router and stops the forwarder; injected replies after close are dropped. Covered by `run_connection_chat_close_stops_forwarder_and_drops_later_replies`. PASS.
- AC-3: Connection close deregisters the subscription from the router and stops the forwarder without affecting other connections. Covered by `run_connection_drop_deregisters_chat_subscription_from_router`. PASS.
- AC-4: `chat.send` rejects subscription ids not open on the same connection. Covered by `run_connection_chat_send_with_no_open_subscription_returns_error` and existing dispatch-layer tests. PASS.
- AC-5: Concurrent reply notifications are delivered as whole, well-formed JSON-RPC frames. Covered by `run_connection_concurrent_chat_replies_are_well_formed_frames`. PASS.

Only the three files listed in "Files to Touch" were modified. No unspecified behaviour was added.

Verification: `cargo test -p admin-rpc` — 107 passed, 0 failed; `cargo fmt --all -- --check` — clean; `cargo test --workspace` — all suites pass.

**Stage 2 — Code Quality**

All five ACs have direct integration tests covering both the success path and teardown/error paths. Logic is correct. No hardcoded secrets. Names are descriptive and consistent with the existing audit pattern. No unnecessary loops or resource leaks detected.

**Non-blocking observations (no action required):**

1. `the-intern/service/crates/admin-rpc/src/lib.rs`, line 291: Stale comment — "removing all chat subscriptions from the bus" should say "deregistering all chat subscriptions from the reply router". The bus is no longer involved in chat teardown.
2. `the-intern/service/crates/admin-rpc/src/dispatch.rs`, lines 360–363: Misleading comment — it says `router.deregister` "must happen before the cancel sender is dropped (done inside registry.close_chat)" but the code calls `close_chat` (which drops the cancel sender) first, then `deregister`. The actual ordering is the opposite of what the comment describes. The work log acknowledges and accepts this ordering; the comment should be corrected to match it.
3. `the-intern/service/crates/admin-rpc/src/lib.rs`, line 160: `_bus: SubscriptionBus` parameter in `run_connection` is now unused. It is passed at the call site purely because the listener loop still constructs and clones the bus for audit subscriptions. Minor dead parameter; can be cleaned up if desired.
