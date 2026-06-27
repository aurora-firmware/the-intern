---
id: T-109
title: Implement admitted periodic request dispatch to pi-agent
status: pending
priority: high
assigned-role: developer
created: '2026-06-27'
spec: S-009
---

# Implement admitted periodic request dispatch to pi-agent

## Description

S-009's steady-state workflow requires an admitted scheduled request to reach
pi-agent and execute the prompt verbatim. The current `bob serve` wiring starts
the scheduler and runs pre-flight admission, but the allow path only enqueues the
`InternalEvent` into persistence; no production task drains that queue and calls
`pi_agent_supervisor::Handle::send_prompt`.

Add a supervised dispatcher in `bob/src/serve.rs` that drains admitted
`DeliveryKind::Periodic` events from persistence, acquires a pi-agent session,
and sends the event payload as the prompt. The dispatcher must run only while
`bob serve` is running, shut down with the existing six-phase protocol, and keep
processing later events after per-event failures.

## Acceptance Criteria

AC-1: The system shall start a supervised periodic request dispatcher during
      `bob serve` startup and await it during graceful shutdown.

AC-2: WHEN the dispatcher dequeues an admitted `DeliveryKind::Periodic`
      `InternalEvent` from persistence THE SYSTEM SHALL acquire a pi-agent
      session and send `event.payload` verbatim via
      `pi_agent_supervisor::Handle::send_prompt`.

AC-3: IF persistence dequeue, pi-agent session acquisition, or prompt sending
      returns an error THEN THE SYSTEM SHALL log a warning and continue
      processing subsequent periodic events without crashing `bob serve`.

AC-4: WHILE no admitted periodic event is available THE SYSTEM SHALL wait
      without busy-spinning and without preventing shutdown.

AC-5: The system shall pass the focused `bob serve` tests covering periodic
      dispatch startup, prompt forwarding, and failure resilience.

## Dependencies

- `T-095` — scheduler adapter submits periodic events to requests-handler.
- `T-097` — schedule mutations reload the live scheduler job table.

## Files to Touch

- `the-intern/service/crates/bob/src/serve.rs` — add dispatcher startup,
  shutdown ownership, and focused tests.

## Verification

```bash
cd the-intern/service
cargo test -p bob serve::tests::periodic
```

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

### Session 1 — 2026-06-27

Implemented the admitted periodic request dispatcher as specified in T-109, completing all five acceptance criteria in a single TDD cycle.

**What was done.** Added `start_periodic_dispatcher` to `bob/src/serve.rs`. The function spawns a Tokio task that loops over `persistence.dequeue_next()`. Periodic events are forwarded to pi-agent via `acquire_session` + `send_prompt`. Non-Periodic events are re-enqueued and backed off. Empty queue or dequeue errors trigger a 100 ms `tokio::select!` sleep that also watches the shutdown receiver, satisfying the no-busy-spin and no-shutdown-blocking requirements. Two new fields were added to `Runtime` (`dispatcher_cancel_tx: watch::Sender<bool>` and `dispatcher_join: JoinHandle<()>`); the existing `joins` vec remained at six entries so the `runtime_holds_six_non_supervisor_join_handles` test continued to pass. Phase 1 of `run_shutdown_protocol` sends `true` on `dispatcher_cancel_tx`; phase 3 appends `dispatcher_join` to `all_joins` alongside `scheduler_adapter_join`. Five tests in a `pub mod periodic` submodule cover startup (AC-1), prompt forwarding end-to-end with a sh RPC worker (AC-2), error resilience using a `exit 0` worker (AC-3), and idle back-off / shutdown responsiveness (AC-4/AC-5).

**What was tried and rejected.** Considered dropping non-Periodic events silently (simpler, but breaks existing serve tests that enqueue Sync events and then dequeue them). Considered requiring a separate notification channel from the scheduler-adapter so the dispatcher only wakes when work is available (cleaner, but would require modifying a crate outside the `Files to Touch` list). Settled on re-enqueue + 100 ms back-off as the minimal change that preserves correctness and keeps existing tests deterministically passing.

**What remains.** Nothing for this task. All five ACs are covered by passing tests. The branch is ready for review and integration.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->
