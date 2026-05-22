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

### Session 1 — 2026-05-22

**What was done**

Implemented all four acceptance criteria for T-068 in three red→green→refactor→commit TDD cycles.

**Cycle 1 — AC-1 (bob-core port trait).** Added `RequestContext` as a second parameter to `RequestsHandler::submit`. Wrote a failing test in `ports.rs` proving the old single-argument call site would not compile, updated the trait definition, updated the `StubRequestsHandler` in the test module, and ensured all 80 bob-core tests continued to pass.

**Cycle 2 — AC-2 (requests-handler queue payload).** Changed the `mpsc` channel payload from `InternalEvent` to `(InternalEvent, RequestContext)` throughout `queue.rs`. Updated `Handle` (field type), `submit_event` (signature), the `RequestsHandler` trait impl, and the `Actor` generic bounds. Wrote a new test (`submit_event_with_context_delivers_both_event_and_context_to_downstream`) that verified the downstream closure receives both the event and the context with the correct sender. Updated the four pre-existing queue tests to supply a context on every `submit`/`submit_event` call and to use `|_pair|` / `|(ev, _ctx)|` closures. All 15 requests-handler tests pass.

**Cycle 3+4 — AC-3/AC-4 (serve.rs wiring and placeholder removal).** Removed the `default_context` block from `try_start_subsystems` that constructed a synthetic `RequestContext` from the first admitted user. Changed the `start_with` downstream closure to destructure `(event, context)` and pass the per-request `context` as `Some(&context)` to `run_preflight`. Updated the existing `permitted_event_is_persisted` integration test to supply an explicit context carrying the admitted user's ID. Added two new tests: `deny_all_policy_snapshot_causes_all_events_to_be_denied_and_not_persisted` (updated to pass an explicit context) and `preflight_uses_per_request_context_not_shared_startup_context` (submits one event with an admitted user's context and one with a non-admitted user's context; verifies only the former is persisted, proving per-request dispatch). Also updated `queue_load.rs` integration test to match the new `submit` signature. All 75+ bob tests pass.

**Workspace result.** `cargo test --workspace` passes with 0 failures across all crates.

**Nothing rejected or deferred.** The implementation followed the task description exactly. The two pre-existing `unused import: DeliveryKind` warnings in the `persistence` crate were present before this task and were left untouched.

**What remains.** Nothing for this task. The task branch is ready for review.

Three implementation commits on `task/T-068-carry-requestcontext-through-intake-path`: `8e7f64b`, `b9ed729`, `505d2e2`.

## Review

<!-- Reviewer: append verdict here after each review cycle. -->

### Review Verdict — 2026-05-22

PASS

Both stages passed.

**Stage 1 — Spec compliance**

- AC-1: `RequestsHandler::submit` in `bob-core/src/ports.rs` now accepts `(InternalEvent, RequestContext)`. `StubRequestsHandler` and the compilation test updated accordingly. Confirmed in diff. PASS.
- AC-2: `Handle::submit_event` in `requests-handler/src/queue.rs` accepts `(InternalEvent, RequestContext)` and the `RequestsHandler` trait impl delegates to it. The `mpsc` channel payload is `(InternalEvent, RequestContext)`. Backpressure and timeout logic are unchanged. PASS.
- AC-3: The `start_with` downstream closure in `serve.rs` destructures `(event, context)` and passes `Some(&context)` to `run_preflight`, so each dequeued event is pre-flighted against the context that travelled with it. New integration test `preflight_uses_per_request_context_not_shared_startup_context` directly proves per-request dispatch. PASS.
- AC-4: The `default_context` block that constructed a synthetic `RequestContext` from the first admitted user has been removed from `try_start_subsystems`. No shared startup context exists. PASS.
- AC-5: `cargo test --workspace` run on the task branch. All tests pass — 0 failures across all crates (95 + 75 + 15 + 80 + others). PASS.
- Scope: Only the four files named in the task (plus the `queue_load.rs` integration test, which is a direct call-site update required by the signature change) were modified. `handler.rs` was not modified; its existing `run_preflight(context: Option<&RequestContext>)` signature was already correct and required no change — the dispatch-path adjustment was entirely in `serve.rs`. PASS.

**Stage 2 — Code quality**

- Correctness: Logic is correct for all paths. The downstream closure always receives a real `RequestContext` from the submitter. The pre-flight denial path (missing context, non-admitted user) is unchanged. No off-by-one or null-reference issues.
- Tests: New unit test in `queue.rs` covers the pair delivery. New integration test in `serve.rs` covers per-request vs. shared-context discrimination. Existing tests updated to the new signature. All tests are independent and construct their own fixtures.
- Security: No hardcoded credentials. Raw event payload is not logged or included in audit reasons (existing constraint preserved). No new permissions.
- Readability: Names are descriptive and follow project conventions. The `(event, context)` destructuring pattern is idiomatic. No dead code or debugging artifacts.
- Performance: No unnecessary work introduced. The pair is moved through the bounded channel as before.

**Minor observation (non-blocking):** The pre-existing `unused import: DeliveryKind` warnings in the `persistence` crate were noted in the Work Log and intentionally left — they predate this task and are out of scope.
