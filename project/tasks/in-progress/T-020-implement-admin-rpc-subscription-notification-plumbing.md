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

### Session 1 — 2026-05-17

Resumed T-020 from existing in-branch edits in `admin-rpc` and reviewed all pre-existing changes before modifying anything. Ran the scoped verification first, then identified an AC-4 gap: `SubscriptionBus::new` accepted `slow_subscriber_deadline` but `publish` dropped full subscribers immediately. Wrote a new failing test (`publish_drops_subscriber_when_queue_stays_full_past_deadline`) to enforce deadline-based eviction, confirmed it failed, then implemented minimal deadline tracking in `SubscriptionBus` via a `slow_since` map keyed by subscription id. Kept the synchronous bus API by using `try_send` plus elapsed-time checks, clearing slow state on recovery, and removing stale slow markers on unsubscribe/removal. Re-ran targeted tests (`subscriptions`, `run_connection_audit*`, `dispatch_audit_tail*`) to confirm behavior. Rejected converting `publish` to async/`send_timeout` in this cycle to avoid broader API churn and because elapsed-full-time tracking satisfies AC-4 with smaller surface-area change. Remaining: lifecycle/work-log append on canonical `dev-agent` branch by the loop owner.

Evidence:
- Red test (expected failure): `cd the-intern/service && cargo test -p admin-rpc publish_drops_subscriber_when_queue_stays_full_past_deadline` failed before implementation with the subscriber dropped before the deadline elapsed.
- Green tests after implementation: `cd the-intern/service && cargo test -p admin-rpc publish_drops_subscriber_when_queue_stays_full_past_deadline`, `cd the-intern/service && cargo test -p admin-rpc subscriptions`, `cd the-intern/service && cargo test -p admin-rpc run_connection_audit`, and `cd the-intern/service && cargo test -p admin-rpc dispatch_audit_tail`.
- Broader suite note: `cd the-intern/service && cargo test -p admin-rpc` still has environment-permission failures in listener/peer-cred socket-binding tests (`Operation not permitted`), unrelated to T-020 logic and reproducible in this sandbox.

Obstacles Encountered:
- Running the full `admin-rpc` suite in this sandbox hits pre-existing Unix socket bind permission failures for listener/peer-cred tests.
- One mistyped `cargo test` invocation used two filters at once; reran with separate filters.

### Session 2 — 2026-05-17

Continued from Review Cycle 1 FAIL and reproduced the defect with a new red integration test (`run_connection_audit_unsubscribe_keeps_connection_open`) showing that after `audit.tail.unsubscribe`, the next `service.status` request hit EOF because the connection was being closed via the generic `rx.recv()==None` path. Implemented a minimal fix by adding explicit slow-eviction tracking in `SubscriptionBus` (`slow_evicted` + `take_slow_evicted`) and wiring `audit_forwarder` to emit `NotifMsg::Dropped` only when that marker is present. Normal unsubscribe/connection cleanup now closes the receiver without forcing AC-4 close/warn behavior. Rejected a broader async redesign (`send_timeout`/API shape changes) to keep scope minimal and aligned with reviewer feedback. Re-ran required verification and focused unsubscribe/slow-eviction/connection tests; all passed. Remaining: reviewer re-check and loop-owned lifecycle update on canonical `dev-agent` task file.

Evidence:
- Red (expected fail before fix): `cd the-intern/service && cargo test -p admin-rpc run_connection_audit_unsubscribe_keeps_connection_open` failed with EOF parsing status response after unsubscribe.
- Green after fix: `cd the-intern/service && cargo test -p admin-rpc run_connection_audit_unsubscribe_keeps_connection_open`, `cd the-intern/service && cargo test -p admin-rpc subscriptions`, `cd the-intern/service && cargo test -p admin-rpc run_connection_audit_unsubscribe`, `cd the-intern/service && cargo test -p admin-rpc publish_drops_subscriber_when_queue_stays_full_past_deadline`, and `cd the-intern/service && cargo test -p admin-rpc run_connection_close_removes_all_subscriptions`.
- Lifecycle-file check: `git diff --name-only dev-agent...HEAD` excluded `project/tasks/...` lifecycle files.

Obstacles Encountered:
- One intermediate compile error (`use of moved value: bus`) after threading `SubscriptionBus` through `read_loop`; resolved with `bus.clone()` when constructing `ConnectionRegistry`.
- Temporary cargo build-dir lock wait while running parallel test commands.

## Review

### Review Verdict — 2026-05-17
FAIL

- **File and location**: `the-intern/service/crates/admin-rpc/src/lib.rs:288`, `the-intern/service/crates/admin-rpc/src/lib.rs:344`
  **What is wrong**: `audit_forwarder` sends `NotifMsg::Dropped` whenever `rx.recv()` returns `None`, and `write_loop` closes the connection for every `Dropped`. `rx.recv()==None` also happens on normal `audit.tail.unsubscribe` (`bus.remove`) and connection teardown, so the implementation closes the connection and logs a slow-subscriber warning even when AC-4’s slow-queue condition did not occur.
  **What should change**: Differentiate "evicted for slow queue past deadline" from ordinary unsubscribe/cleanup. Only trigger connection close + AC-4 warning for the slow-eviction path; normal unsubscribe must not force connection closure.

- **File and location**: `task/T-020-implement-admin-rpc-subscription-notification-plumbing` branch diff vs `dev-agent` (`project/tasks/in-progress/T-020-implement-admin-rpc-subscription-notification-plumbing.md`)
  **What is wrong**: The task branch currently carries a lifecycle-file delta relative to `dev-agent`. Task branches should contain source/test implementation changes only; lifecycle state must stay canonical on `dev-agent`.
  **What should change**: Rebase/cherry-pick the implementation so the task branch diff excludes lifecycle files, then resubmit for review.
