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

### Session 1 — 2026-07-05

Implemented ADR-013's job-id correlator across the three files named in the task, following red→green→refactor for each acceptance criterion, three commits total.

**Cycle 1 (`crates/bob-core/src/ports.rs`):** Added `enqueue_with_job_id(event, job_id: Option<String>)` and `dequeue_next_with_job_id() -> ServiceResult<Option<(InternalEvent, Option<String>)>>` to `PersistenceStore` as default-implemented methods that delegate to the existing `enqueue`/`dequeue_next`, discarding/absent-ing the correlator. Added a `RecordingPersistenceStore` test double (deliberately *not* overriding the new methods) to pin down the default-delegation contract: enqueuing with a correlator via the default still calls through to plain `enqueue` (correlator ignored), and dequeuing via the default always reports an absent correlator. This is the mechanism that keeps `RecordingStore` (`requests-handler`) and `serve.rs` compiling with zero changes — confirmed later with a `git diff dev-agent --stat` showing no diff on those files.

**Cycle 2 (`crates/persistence/src/inbound.rs`):** Changed the inner `VecDeque<InternalEvent>` to `VecDeque<(InternalEvent, Option<String>)>`; `enqueue` takes an extra `job_id: Option<String>` and `dequeue_next` returns the tuple. Updated all pre-existing tests to the new two-argument/tuple-return shape (no behavior change intended there) and added new tests for correlator round-trip, absent-correlator dequeue, FIFO-with-correlators, and capacity-with-a-correlator. This also required a same-cycle wiring fix in `lib.rs` (the actor's `Command::Enqueue`/`Command::DequeueNext` shapes and the `Handle`'s plain `enqueue`/`dequeue_next` impl) purely to keep the crate compiling against the new `InboundQueue` signature — done with `job_id: None` on the plain path, no new externally-visible behavior yet.

**Cycle 3 (`crates/persistence/src/lib.rs`):** Overrode `enqueue_with_job_id`/`dequeue_next_with_job_id` on `Handle` to thread the real job id through `Command::Enqueue`/`Command::DequeueNext` instead of falling through to the trait default (which would silently drop it). Wrote failing tests first (they failed at the assertion level, correlator coming back `None` instead of `Some("job-1")`, confirming the default's limitation), then added the overrides to make them pass. Added FIFO- and capacity-preservation tests specifically exercising the correlator-carrying path.

Nothing was tried and rejected — the design tracked ADR-013 and the task's stated approach (additive default methods) directly, so there wasn't a competing alternative worth exploring. One judgment call: extended the trait method names to `enqueue_with_job_id`/`dequeue_next_with_job_id` (not specified verbatim in the task) since the task only said "correlator-carrying methods" — this seemed the most self-documenting choice consistent with `job_id: Option<String>` already used as `RequestContext::context_id`'s underlying type in the codebase.

Verification: `cargo test -p bob-core --lib ports::tests`, `cargo test -p persistence --lib inbound`, and `cargo test -p persistence --lib tests::` all confirmed red→green per cycle. Final `cargo test --workspace` — all 17 test binaries `ok`, 0 failed. `cargo build -p bob` succeeds. `cargo fmt --all -- --check` clean. `git diff dev-agent --stat -- crates/bob/src/serve.rs crates/requests-handler/src/handler.rs` is empty, confirming AC-3's "compiling unchanged" claim; both crates' existing test suites still pass (`bob`: 128 passed, `requests-handler`: 15 passed).

What remains: nothing within this task's scope. The periodic dispatcher's actual consumption of the correlator (resolving `cwd` from the live schedule table, per ADR-013) and updating the `serve.rs` call sites are explicitly deferred to T-126, as stated in the task description.

**Obstacles Encountered:** None. Sandbox and toolchain worked as expected for these crates (no Unix-domain-socket tests were touched by this task).

## Review
