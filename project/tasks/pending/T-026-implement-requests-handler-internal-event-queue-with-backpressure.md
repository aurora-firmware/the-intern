---
id: T-026
title: Implement requests-handler internal event queue with backpressure
status: pending
priority: high
assigned-role: unassigned
created: '2026-05-16'
spec: S-001
---

# Implement requests-handler internal event queue with backpressure

## Description

Replace the requests-handler scaffold's `NotImplemented` body (T-012) with the
real internal event queue described in S-001 Implementation Order Phase 1b.
The queue is a bounded `tokio::sync::mpsc` channel sized by
`cfg.request_queue_capacity`. The `Handle::submit(event)` method tries to send
with a timeout of `cfg.request_submit_timeout`; if the channel remains full
beyond that deadline, it returns `Err(ServiceError::Timeout { operation:
"requests-handler.submit" })`. The actor task drains the channel and forwards
each event to a downstream handler closure (T-027 supplies the closure).

On shutdown (the actor receives a cancellation token), the actor stops
accepting new submissions and drains remaining queued events before
terminating.

## Acceptance Criteria

AC-1: WHEN `requests_handler::Handle::submit(event)` is called and the queue has available capacity THE SYSTEM SHALL enqueue the event and return `Ok(())`.
AC-2: IF the queue is full and remains full beyond `cfg.request_submit_timeout` THEN `Handle::submit` SHALL return `Err(ServiceError::Timeout { operation: "requests-handler.submit" })`.
AC-3: WHEN the requests-handler actor receives a cancellation signal THE SYSTEM SHALL stop accepting new submissions and drain remaining queued events before terminating.
AC-4: The system shall implement `bob_core::ports::RequestsHandler` for the requests-handler's `Handle`.

## Dependencies

- `T-012` — requests-handler scaffold
- `T-010` — `RequestsHandler` port trait
- `T-015` — `BobConfig.request_queue_capacity`, `request_submit_timeout`

## Files to Touch

- `the-intern/service/crates/requests-handler/src/queue.rs` — new; bounded channel + submit
- `the-intern/service/crates/requests-handler/src/lib.rs` — touch; replace `NotImplemented` body of `Handle::submit`, expose `start_with(cfg, downstream)` entry

## Verification

```bash
cd the-intern/service && cargo test -p requests-handler queue
```

## Work Log

## Review
