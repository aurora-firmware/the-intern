---
id: B-023
title: periodic dispatcher re-enqueues non-periodic events, reordering the 
  shared inbound persistence queue
severity: high
status: open
created: '2026-07-17'
---

# periodic dispatcher re-enqueues non-periodic events, reordering the shared inbound persistence queue

## Summary

`start_periodic_dispatcher` in `the-intern/service/crates/bob/src/serve.rs`
became a competing consumer of the shared inbound persistence queue when
per-entry cwd resolution (T-118–T-130) landed. It dequeues the head item
unconditionally; when that item is not `DeliveryKind::Periodic` it pushes the
event back onto the queue with a plain `enqueue`. Because the persistence
queue is FIFO, re-enqueueing pulls every non-periodic item from the head and
re-appends it at the tail, turning the queue into a rotating buffer: sync/async
work gets reordered on every dispatcher tick, and under sustained non-periodic
traffic a periodic item sitting behind it can be pushed back indefinitely,
arbitrarily delaying a scheduled fire. This was flagged in the local PR #38
review (`pr-38-review.md`) and confirmed still present by direct code
inspection against the current `dev-agent` tip — it was not addressed by
commit `82302c2 fix(service): address pr review findings`, which touched
unrelated audit-ordering and cwd-validation code in the same file.

## Reproduction Status

Status: confirmed (static — deterministic behavior of the dequeue/re-enqueue
logic, further confirmed by an existing test that asserts the re-enqueue as
current behavior rather than treating it as a bug).

## Evidence

- `the-intern/service/crates/bob/src/serve.rs:826` (current `dev-agent` tip,
  `57f6506`):
  ```rust
  Ok(Some((event, _job_id))) if event.kind != DeliveryKind::Periodic => {
      // ...
      if let Err(e) = persistence.enqueue(event).await {
  ```
  The periodic dispatcher's poll loop dequeues the head of the shared queue
  via `persistence.dequeue_next_with_job_id()` (or equivalent), and for any
  non-`Periodic` event it calls `persistence.enqueue(event)` to push it back
  — at the tail, not the head, since the persistence queue has no
  head-reinsert operation.
- Existing test `dispatcher_re_enqueues_non_periodic_event_via_plain_enqueue`
  (same file, `mod tests`) exercises and asserts exactly this re-enqueue
  behavior — i.e. the current test suite documents the reordering as
  intentional rather than covering the fix.
- `pr-38-review.md` (local, uncommitted PR review report) finding: "\[warning\]
  Periodic dispatcher reorders the shared inbound queue and can starve
  scheduled fires behind steady sync/async traffic —
  `the-intern/service/crates/bob/src/serve.rs:826`".

## Reproduction Steps

1. Start `bob serve` with at least one periodic schedule entry and an active
   stream of non-periodic (sync/async) inbound events.
2. Enqueue several non-periodic events ahead of a periodic event's natural
   fire window.
3. Observe (via unit test or live queue inspection) that each non-periodic
   event dequeued by the periodic dispatcher is immediately re-appended to
   the tail of the same queue, changing its relative order versus any
   consumer that expects FIFO delivery, and that sustained non-periodic
   traffic can keep re-appending ahead of a periodic item, delaying it
   indefinitely.

## Expected Behavior

The periodic dispatcher should be able to identify and dispatch only
periodic work without mutating the position of unrelated (sync/async) events
in the shared queue — non-periodic events should retain their original FIFO
order and periodic fires should not be arbitrarily delayed by unrelated
traffic.

## Actual Behavior

The periodic dispatcher dequeues every head item regardless of kind and
re-enqueues non-periodic ones at the tail, reordering the queue and risking
unbounded delay of periodic dispatch under sustained non-periodic load.

## Environment

- OS / platform: Linux (not platform-specific — pure queue/control-flow
  logic).
- Language / runtime version: Rust workspace at `the-intern/service`.
- Relevant dependencies: the in-process persistence/inbound-event queue
  (`persistence::dequeue_next_with_job_id` / `persistence::enqueue`) shared
  between the periodic dispatcher and the sync/async connection-handling
  path.
- Branch / commit: `dev-agent` at `57f6506d60581da4c76a18d9a6aa84d6bdf59b4d`
  (PR #38 head); introduced by the per-entry cwd resolution work
  (T-118–T-130) that made the periodic dispatcher a queue consumer.

## Related

- PR: `#38` (`Promote dev-agent → main: scheduler JSON-state persistence,
  reliability fixes, per-entry cwd resolution`).
- Local review report: `pr-38-review.md` (uncommitted, working tree only) —
  originating finding.
- Tasks: T-118–T-130 (per-entry cwd resolution work that made the periodic
  dispatcher share the inbound queue).

## Suspected Area

`the-intern/service/crates/bob/src/serve.rs::start_periodic_dispatcher` and
the persistence-queue API it uses (`crates/bob/src/persistence.rs` or
equivalent) — the dispatcher needs either a way to peek/dequeue only
periodic-kind entries without disturbing others, or a separate queue for
periodic work.

## Fix Verification

```bash
# A regression test should assert that non-periodic events dequeued ahead of
# a periodic event retain their original relative order (e.g. are not moved
# to the tail behind later-arriving events), and/or that a periodic event is
# not starved by sustained non-periodic traffic:
cd the-intern/service && cargo test -p bob serve::tests
cd the-intern/service && cargo test --workspace
```

## Diagnosis Log

## Work Log

## Review
