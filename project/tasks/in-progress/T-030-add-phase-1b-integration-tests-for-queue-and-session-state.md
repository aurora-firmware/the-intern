---
id: T-030
title: Add Phase 1b integration tests for queue and session state
status: pending
priority: medium
assigned-role: unassigned
created: '2026-05-16'
spec: S-001
---

# Add Phase 1b integration tests for queue and session state

## Description

Add two integration tests under `the-intern/service/tests/` exercising the
working Phase 1b behaviour end to end. Both spawn the relevant actors
in-process (no `bob serve` child).

**queue_load.rs** — overflows the requests-handler queue: submits
`request_queue_capacity * 10` events as fast as possible against a configured
small capacity. Asserts the first `request_queue_capacity` events are
admitted, the rest return `ServiceError::Timeout { operation:
"requests-handler.submit" }`, and the admitted events appear in the
persistence handle in submission order.

**session_state_roundtrip.rs** — calls `put_session_state(id, state)` for
several distinct session ids, then `get_session_state(id)` for each and
asserts equality. Also asserts `get_session_state` on an unknown id returns
`Ok(None)`.

## Acceptance Criteria

AC-1: WHEN the queue-load test submits events at a rate that overflows capacity THE SYSTEM SHALL admit exactly `request_queue_capacity` events successfully and return `ServiceError::Timeout` for every subsequent submission.
AC-2: WHEN the queue-load test dequeues all admitted events from the wired persistence handle THE SYSTEM SHALL return them in the order they were submitted.
AC-3: WHEN the session-state test calls `put_session_state(id, state)` followed by `get_session_state(id)` THE SYSTEM SHALL return a value equal to the one stored.
AC-4: WHEN the session-state test calls `get_session_state(id)` for an id that was never `put` THE SYSTEM SHALL return `Ok(None)`.

## Dependencies

- `T-026` — queue
- `T-027` — handler pre-flight
- `T-028` — persistence

## Files to Touch

- `the-intern/service/tests/queue_load.rs` — new
- `the-intern/service/tests/session_state_roundtrip.rs` — new

## Verification

```bash
cd the-intern/service && cargo test --test queue_load
cd the-intern/service && cargo test --test session_state_roundtrip
```

## Work Log

### Session 1 — 2026-05-18

Implemented T-030 with two red→green→refactor cycles. First, I added `queue_load.rs` as an integration test in `the-intern/service/crates/bob/tests/` (crate-local path chosen because `the-intern/service/tests/` does not exist in this workspace and Cargo test targets are currently crate-scoped here). I initially tried a direct flood where all submissions were expected to overflow, but that admitted all events because the actor drained concurrently. I rejected that approach and switched to a deterministic harness: a warm-up event blocks downstream processing, then the test submits `request_queue_capacity * 10` events quickly while the actor is blocked. This made backpressure deterministic and validated AC-1 (`ServiceError::Timeout { operation: "requests-handler.submit" }` for all overflowed submissions) and AC-2 (admitted events dequeue from persistence in submission order).

Second, I added `session_state_roundtrip.rs` with integration tests that store/retrieve multiple distinct `SessionId` values and assert equality (AC-3), plus unknown id returning `Ok(None)` (AC-4).

Both required verification commands pass. Nothing remains on this task branch besides reviewer/integration flow.

Obstacles Encountered:
- `git add/commit` initially failed in sandbox with `.git/index.lock: Read-only file system`; resolved by rerunning git commands with escalated permissions.
- No product-code blockers.

## Review

### Review Verdict — 2026-05-18

PASS

Stage 1 (acceptance criteria):
- AC-1 met: `queue_load` submits `request_queue_capacity * 10` events under deterministic backpressure and asserts exactly `request_queue_capacity` admissions with overflow errors matching `ServiceError::Timeout { operation: "requests-handler.submit" }`.
- AC-2 met: admitted events are dequeued from persistence and asserted in the same submission order.
- AC-3 met: `session_state_roundtrip` stores and retrieves multiple distinct `SessionId` values and asserts equality.
- AC-4 met: unknown `SessionId` lookup asserts `Ok(None)` (`is_none()` after successful call).
- Scope check: implementation changes are limited to the two new integration test files in `the-intern/service/crates/bob/tests/`.

Stage 2 (code quality):
- Correctness, test independence, readability, and performance are acceptable for integration-test scope.
- Verification commands executed and passed:
  - `cd the-intern/service && cargo test --test queue_load`
  - `cd the-intern/service && cargo test --test session_state_roundtrip`
