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

### Session 1 — 2026-05-17

Implemented all four acceptance criteria for T-026 in a single TDD session. The implementation lives entirely in the new `queue.rs` file; `lib.rs` is now a thin re-export shim.

**What was done:**

Wrote six tests covering all four ACs before any production code: AC-1 (happy-path `submit` returns `Ok(())`), AC-1 again via the trait object surface, AC-2 (full queue times out), AC-3 (drain on cancellation), AC-3 again (new submits rejected after drain), and AC-4 (compile-time trait bound check). Then implemented `Config`, `Handle`, `Actor`, and `start_with` in that order.

`Handle::submit_event` wraps `mpsc::Sender::send` in `tokio::time::timeout`. On expiry it returns `ServiceError::Timeout { operation: "requests-handler.submit" }`. When the channel closes it returns `ServiceError::Shutdown`. A watch channel (`shutdown_rx`) lets `Handle` fast-reject submits after the actor finishes draining.

`Actor::run` uses a biased `tokio::select!` that monitors `cancel_rx.changed()` with priority over `rx.recv()`. When cancellation fires it breaks the processing loop, calls `rx.close()` to prevent new sends, and drains whatever is buffered before sending `true` on `shutdown_tx`.

**What was tried and rejected:**

Initially `start_with` accepted both `cancel_tx` and `cancel_rx`. The function dropped `cancel_tx` internally with `let _ = cancel_tx`, which is incorrect — the caller needs the sender. Redesigned to accept only `cancel_rx`; callers keep their own `cancel_tx` (the pair is created by the caller with `watch::channel(false)`).

The AC-2 test first used `tokio::time::sleep(60s)` in the downstream to block processing. On a `current_thread` runtime the single `.await` in the first `submit` yields to the actor, which consumes the event and enters the sleep — freeing the queue slot before the second submit. Replaced the sleep with a `tokio::sync::Notify` gate that the test controls, plus an explicit `yield_now()` to ensure the actor enters the gate-wait before the test re-fills the slot.

**`serve.rs` update (out-of-scope but necessary):**

The `bob` crate's `serve.rs` referenced the old `requests_handler::start()` / `Config { command_buffer }` scaffold API. Removing the scaffold broke workspace compilation. Updated `serve.rs` to create a `watch::channel` pair, pass `cancel_rx` to `start_with`, store `cancel_tx` in `Runtime`, and send `true` on it early in `run_shutdown_protocol`. A placeholder `|_event| async {}` closure is used until T-027 supplies the real downstream.

**What remains:**

T-027 supplies the downstream closure that replaces the placeholder in `serve.rs`. No further work on `queue.rs` or `lib.rs` is expected for this task.

## Review

### Review Verdict — 2026-05-17

PASS

Both review stages pass.

**Stage 1 — Spec compliance**

AC-1: `Handle::submit_event` sends to the bounded `mpsc::Sender` and returns `Ok(())` on success. Verified by tests `submit_with_capacity_enqueues_and_returns_ok` and `requests_handler_trait_submit_with_capacity_returns_ok`. PASS.

AC-2: `submit_event` wraps the send in `tokio::time::timeout(self.submit_timeout, …)`. On `Err(_elapsed)` it returns `ServiceError::Timeout { operation: "requests-handler.submit" }` exactly as specified. Test `submit_when_queue_full_beyond_timeout_returns_timeout_error` exercises this path using a `Notify`-gated downstream. PASS.

AC-3: `Actor::run` uses a biased `tokio::select!` that checks `cancel_rx.changed()` first. On cancellation it breaks the loop, calls `rx.close()`, and drains remaining events before sending `true` on `shutdown_tx`. Tests `on_cancellation_drains_remaining_queued_events` and `after_cancellation_new_submissions_are_rejected` cover both facets. PASS.

AC-4: `Handle` carries `#[async_trait] impl RequestsHandler for Handle` delegating to `submit_event`. Compile-time check in `handle_implements_requests_handler_trait`. PASS.

File-scope note: `the-intern/service/crates/bob/src/serve.rs` is outside the stated "Files to Touch". Its modification is justified in the Work Log: removing the old scaffold API broke workspace compilation, making this change necessary to keep the workspace buildable. The work log explanation is clear and the change is minimal and scoped to wiring the new `start_with` API into `serve.rs`. ACCEPTED.

**Stage 2 — Code quality**

Correctness: Logic is correct. `Handle::submit_event` checks `shutdown_rx` for fast-rejection before attempting to send; both the timeout path and the channel-closed path map to appropriate `ServiceError` variants. The biased `select!` in `Actor::run` correctly prioritises the cancellation signal over new events, preventing livelock on a continuously-arriving stream. `rx.close()` prevents new sends while still allowing buffered events to be drained. `capacity.max(1)` in `start_with` prevents a zero-capacity channel, which would deadlock. No off-by-one or unhandled state issues observed.

Tests: Six unit tests; each maps directly to an AC. Tests cover the happy path (AC-1), trait delegation (AC-1), full-queue timeout (AC-2), drain-on-cancellation (AC-3), post-drain rejection (AC-3), and the compile-time trait bound (AC-4). Tests are independent (each creates its own channel pair). All 6 passed locally (`cargo test -p requests-handler queue`).

Security: No hardcoded credentials or secrets. External input (`InternalEvent`) is passed through without inspection, consistent with the requests-handler's role as a queue. No parameterized queries (N/A). No new permissions.

Readability: Names are descriptive and follow `snake_case`/`UpperCamelCase` project conventions. Functions have focused responsibilities. Doc-comments explain the `# Errors` contract on `submit_event` and the caller's responsibility for the `cancel_rx` watch channel. No dead code or commented-out blocks. `lib.rs` correctly serves as a thin re-export shim.

Performance: The biased `select!` avoids polling overhead. `rx.close()` is called once on the drain path. No unnecessary allocations or loops over large data sets. No blocking operations in async hot paths.

Minor observation (non-blocking): `Cargo.toml` includes the `net` and `signal` Tokio features, which are not used by `queue.rs` itself. These are presumably pulled in for the broader workspace or future tasks and do not affect correctness.
