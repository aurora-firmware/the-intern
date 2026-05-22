---
id: T-068
title: Carry RequestContext through the requests-handler intake path
status: pending
priority: high
assigned-role: unassigned
created: '2026-05-21'
---

# Carry RequestContext through the requests-handler intake path

## Description

Implements **Component 1 (Channel intake handle)** of S-006
(`project/specs/channel-adapter-framework-and-interactive-chat-adapter.md`),
Phase 1.

Today the requests-handler submission path carries only an `InternalEvent`:
`requests-handler::Handle::submit_event` takes `InternalEvent`, the queue's
`mpsc` channel is `Sender<InternalEvent>`, and `bob serve` builds a single
placeholder `RequestContext` at startup (`serve.rs`, the block commented
"Channel adapters will supply real RequestContexts once they are wired in")
which `run_preflight` reuses for every event. ADR-004 and S-006 require each
request to carry its **own** `RequestContext` (sender, source channel, context
id) so the pre-flight identity/access check runs against the real per-request
identity.

Rework the submission path so a submission carries `(InternalEvent,
RequestContext)` end to end:

- The `RequestsHandler` port trait's submit method takes both values.
- The queue actor's `mpsc` payload becomes the pair.
- `Handle::submit_event` accepts an `InternalEvent` and its `RequestContext`.
- The `run_preflight` dispatch closure receives the context that travelled
  with the event and passes it to the existing pre-flight check.
- Remove the startup placeholder `RequestContext` in `serve.rs`.

The existing submission result is the acceptance/rejection **receipt** S-006
refers to — `Ok` means accepted, `Err` (`Timeout` on a full queue, `Shutdown`)
means rejected. Do not introduce a new receipt type. Keep `submit_event`'s
backpressure/timeout behaviour unchanged.

## Acceptance Criteria

AC-1: The `RequestsHandler` port trait in `bob-core` shall define a submit
      operation that accepts both an `InternalEvent` and a `RequestContext`.

AC-2: `requests-handler::Handle` shall expose a submission operation that
      accepts an `InternalEvent` together with its `RequestContext` and returns
      a result that is `Ok` on acceptance and `Err` on rejection (queue full or
      shutdown).

AC-3: WHEN a submitted request is dequeued THE SYSTEM SHALL run the pre-flight
      check against the `RequestContext` submitted with that request, not a
      shared startup-time context.

AC-4: IF `bob serve` still constructs a single fixed `RequestContext` reused
      across all requests THEN the task shall be considered incomplete — the
      startup placeholder must be removed.

AC-5: The full Rust workspace shall build and all tests shall pass under
      `cargo test --workspace`.

## Dependencies

- None — builds on the Phase 1b queue and the ADR-004/T-067 core types, both
  complete and integrated.

## Files to Touch

- `the-intern/service/crates/bob-core/src/ports.rs` — change the
  `RequestsHandler` submit signature to take `InternalEvent` + `RequestContext`;
  update the stub/test implementations.
- `the-intern/service/crates/requests-handler/src/queue.rs` — change the `mpsc`
  payload to the pair; update `Handle::submit_event` and the trait impl.
- `the-intern/service/crates/requests-handler/src/handler.rs` — adjust the
  dequeue/dispatch path so `run_preflight` receives the per-request context.
- `the-intern/service/crates/bob/src/serve.rs` — remove the startup placeholder
  `RequestContext`; wire the per-request context into the dispatch closure.

## Verification

```bash
cd the-intern/service
cargo test --workspace
```

## Work Log

<!-- Mandatory. Append one entry per session boundary. -->

## Review

<!-- Reviewer: append verdict here after each review cycle. -->
