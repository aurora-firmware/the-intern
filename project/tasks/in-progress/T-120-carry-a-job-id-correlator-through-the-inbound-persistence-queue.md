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

### Review Verdict — 2026-07-05

PASS

**Stage 1 — Acceptance Criteria**

- AC-1 (enqueue with optional job-id correlator, return it on dequeue) — met.
  `PersistenceStore::enqueue_with_job_id`/`dequeue_next_with_job_id` added as
  default-implemented trait methods (`crates/bob-core/src/ports.rs`), overridden
  on `Handle` (`crates/persistence/src/lib.rs`) to thread the correlator through
  `Command::Enqueue`/`Command::DequeueNext`, and carried in
  `InboundQueue`'s `VecDeque<(InternalEvent, Option<String>)>`
  (`crates/persistence/src/inbound.rs`).
- AC-2 (same correlator round-trips) — met. Verified at all three layers:
  `inbound::tests::dequeue_next_returns_the_job_id_correlator_it_was_enqueued_with`,
  `tests::dequeue_next_with_job_id_returns_the_correlator_it_was_enqueued_with`
  (persistence `lib.rs`), plus the `ports.rs` default-delegation tests.
- AC-3 (absent correlator on plain enqueue; existing impls/call sites compile
  unchanged) — met.
  `git diff dev-agent task/T-120... --stat -- the-intern/service/crates/bob/src/serve.rs the-intern/service/crates/requests-handler/src/handler.rs`
  is empty — confirmed independently by this review, not just asserted in the
  work log. `RecordingStore` (`requests-handler/src/handler.rs`) and
  `serve.rs`'s plain `enqueue`/`dequeue_next` call sites are untouched and
  still compile against the trait defaults (`persistence_store_enqueue_with_job_id_default_delegates_to_plain_enqueue`,
  `persistence_store_dequeue_next_with_job_id_default_returns_absent_correlator`
  in `ports.rs`). `InternalEvent`/`types.rs` are untouched (no diff), consistent
  with ADR-013 and the task description.
- AC-4 (capacity + FIFO preserved) — met. Dedicated tests at both the
  `inbound.rs` level (`dequeue_next_returns_job_id_correlators_in_fifo_order`,
  `enqueue_with_job_id_at_capacity_returns_persistence_error`) and the `lib.rs`
  `Handle` level (`dequeue_next_with_job_id_returns_entries_in_fifo_order`,
  `enqueue_with_job_id_at_capacity_returns_persistence_error`).

No unspecified behavior added. Files touched match the task's "Files to
Touch" list exactly (`ports.rs`, `persistence/src/lib.rs`,
`persistence/src/inbound.rs`), plus the canonical task file itself — no
stray edits elsewhere.

**Stage 2 — Code Quality**

- Correctness: default methods delegate correctly (`let _ = job_id;` discards
  the correlator on the default `enqueue_with_job_id`; `dequeue_next_with_job_id`
  default maps to `(event, None)`); `Handle`'s overrides thread the real job id
  through the actor's command channel without altering the actor's
  infallible-dequeue behavior.
- Tests: independent, cover round-trip, absent-correlator, FIFO-with-mixed-correlators,
  and capacity-with-correlator paths at every layer touched. Re-ran
  `cargo test --workspace` from a clean checkout of the task branch — 17
  binaries, all green, 0 failed (matches the work log's own numbers,
  including `bob`: 128 passed, `requests-handler`: 15 passed).
- Security: no external input, no secrets, nothing parameterized-query
  relevant here.
- Readability: `enqueue_with_job_id`/`dequeue_next_with_job_id` naming is
  self-documenting and matches the existing `context_id: Option<String>`
  typing convention already used in `RequestContext`. No dead code.
- Performance: no new loops/blocking calls; same `VecDeque` structure, same
  capacity check.
- `cargo fmt --all -- --check` clean; `cargo build -p bob` succeeds;
  `cargo clippy -p bob-core -p persistence --all-targets` surfaces only
  pre-existing pedantic warnings in unrelated code (none in `ports.rs` or
  `inbound.rs`).

**Minor, non-blocking observation:** all three commits on the task branch
exceed the git-conventions 72-character subject-line limit (78, 80, and 85
chars respectively, e.g. `feat(bob-core): add default-implemented job-id
correlator methods to PersistenceStore`). Not blocking this review — the
branch has not been pushed to `origin`, so a future amend to shorten these is
still cheap if desired before integration.

Next owner: Development Loop (task ready to proceed to integration).
