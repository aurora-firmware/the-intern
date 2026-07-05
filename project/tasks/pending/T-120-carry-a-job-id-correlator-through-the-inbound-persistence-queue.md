---
id: T-120
title: Carry a job-id correlator through the inbound persistence queue
status: pending
priority: high
assigned-role: developer
created: '2026-07-05'
spec: S-002
---

# Carry a job-id correlator through the inbound persistence queue

## Description

Implements ADR-013. The periodic dispatcher needs the firing entry's job id, but
the inbound path drops it today: `PersistenceStore::enqueue` persists only the
event. Extend the `PersistenceStore` port (`crates/bob-core/src/ports.rs`,
including the in-file fake), the concrete store (`crates/persistence/src/lib.rs`),
and the inner queue (`crates/persistence/src/inbound.rs`) to carry an **optional
job-id correlator** alongside the event and return it on dequeue.

Add the correlator-carrying methods as **additive trait methods with default
implementations** that delegate to the plain `enqueue`/`dequeue_next` (absent
correlator). A third implementor exists outside this task's file list —
`RecordingStore` in the `#[cfg(test)]` module at
`crates/requests-handler/src/handler.rs` (~line 120) — plus any future impl; the
default methods keep them (and the untouched `serve.rs` call sites) compiling
unchanged. Do **not** modify `serve.rs` call sites here — that is T-126.
`InternalEvent` is unchanged (execution context never enters the delivery type).
Preserve the queue's capacity and FIFO semantics. Verify with `cargo test
--workspace` so the `#[cfg(test)]` `RecordingStore` impl is actually compiled (a
plain `cargo build` skips test modules).

## Acceptance Criteria

AC-1: The system shall allow enqueuing an inbound event together with an optional
      job-id correlator and returning that correlator on dequeue.
AC-2: WHEN an event is enqueued with a job-id correlator THE SYSTEM SHALL yield
      the same correlator when that event is dequeued.
AC-3: WHILE an event is enqueued without a correlator THE SYSTEM SHALL dequeue it
      with an absent correlator and keep every existing impl (including
      `RecordingStore`) and non-periodic call site compiling unchanged.
AC-4: The system shall preserve the inbound queue's existing capacity limit and
      FIFO ordering after the correlator is added.

## Dependencies

- None

## Files to Touch

- `crates/bob-core/src/ports.rs` — extend the `PersistenceStore` trait with
  default-implemented correlator methods (and update the in-file fake if needed)
- `crates/persistence/src/lib.rs` — thread the correlator through the store impl
- `crates/persistence/src/inbound.rs` — carry the correlator in the inner queue

## Verification

```bash
cd the-intern/service && cargo test --workspace
```

## Work Log

## Review
