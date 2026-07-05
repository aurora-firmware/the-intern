---
id: T-126
title: Wire pi_agent_cwd to the supervisor and carry the job id from periodic 
  enqueue to dispatch
status: pending
priority: high
assigned-role: developer
created: '2026-07-05'
spec: S-009
---

# Wire pi_agent_cwd to the supervisor and carry the job id from periodic enqueue to dispatch

## Description

Startup + queue wiring in `crates/bob/src/serve.rs`. (a) Map
`BobConfig.pi_agent_cwd` (T-119) into the supervisor `Config` worker cwd (T-121)
so warm-pool workers run in the service-wide cwd; unset → inherit launch cwd.
(b) On the periodic branch (`serve.rs` ~line 190, `if event.kind ==
DeliveryKind::Periodic`) enqueue the event together with its job id
(`context.context_id`) using the correlator-carrying API from T-120, and have the
periodic dispatcher's `dequeue_next` read that job id back. Non-periodic paths
keep using the plain `enqueue` and are unchanged. This task does **not** resolve
cwd or acquire the worker (that is T-127); it only ensures `pi_agent_cwd` reaches
the pool and the job id reaches the dispatcher.

## Acceptance Criteria

AC-1: WHEN the service starts with `pi_agent_cwd` set THE SYSTEM SHALL configure
      the supervisor so warm-pool workers run in that directory.
AC-2: WHILE `pi_agent_cwd` is unset THE SYSTEM SHALL leave warm-pool workers
      inheriting the launch cwd.
AC-3: WHEN a `periodic` event is enqueued THE SYSTEM SHALL carry the firing
      entry's job id through the inbound queue to the dispatcher.
AC-4: WHILE dispatching non-periodic deliveries THE SYSTEM SHALL require no
      job-id correlator and keep existing behaviour unchanged.

## Dependencies

- `T-119` — `pi_agent_cwd` config field
- `T-120` — inbound-queue job-id correlator API
- `T-121` — supervisor `Config` worker cwd
- `T-123` — ordering-only: both edit `crates/bob/src/serve.rs`; T-123's audit
  field lands before this serve.rs wiring (no logical dependency)

## Files to Touch

- `crates/bob/src/serve.rs` — supervisor config mapping + periodic enqueue/dequeue
  job-id wiring

## Verification

```bash
cd the-intern/service && cargo build -p bob && cargo test -p bob serve
```

## Work Log

## Review
