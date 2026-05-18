---
id: T-036
title: Wire Phase 2 supervisor into bob serve and admin sessions
status: pending
priority: high
assigned-role: unassigned
created: '2026-05-18'
spec: S-001
---

# Wire Phase 2 supervisor into bob serve and admin sessions

<!--
Task Quality Rules (see the new-task skill for full details):
  - Atomic — one clear outcome.
  - One-shottable — ≤ 3–4 files touched, ≤ 5 ACs, Description ≈ 20 lines.
  - Verifiable — concrete Verification command or explicit manual steps.
  - Self-contained — Description is enough to start without follow-up questions.
  - EARS — every AC matches one of the five EARS patterns below.
  - Dependency-honest — list every prior task this one reads from or modifies.
-->

## Description

Wire the completed Phase 2 supervisor into the service surfaces that exercise
session lifecycle. `bob serve` already starts the supervisor and passes its
handle to admin-rpc; this task finishes the integration by exposing real
`sessions.kill` behavior and making shutdown phase 4 wait for supervisor child
cleanup.

Keep Phase 3 JS extension and Phase 4 policy authorization out of scope.
Keep `chat.send` out of scope as well; chat traffic must later follow the
approved channel-adapter to Requests Handler path rather than calling the
supervisor directly.

## Acceptance Criteria

<!-- EARS pattern reference. Every criterion must match one pattern:
  1. Ubiquitous            — The system shall [outcome]
  2. Event-driven          — WHEN [trigger] THE SYSTEM SHALL [outcome]
  3. Unwanted-behaviour    — IF [fault] THEN THE SYSTEM SHALL [outcome]
  4. State-driven          — WHILE [state] THE SYSTEM SHALL [outcome]
  5. Optional              — WHERE [feature included] THE SYSTEM SHALL [outcome]

Examples:
  AC-1: WHEN the user submits valid credentials THE SYSTEM SHALL
        redirect to /dashboard within 200ms.
  AC-2: IF the password is incorrect THEN THE SYSTEM SHALL return 401
        and display "Invalid credentials".
  AC-3: The system shall log every authentication attempt with user id
        and outcome.
-->

AC-1: WHEN `sessions.list` is called over admin RPC THE SYSTEM SHALL return the active session ids reported by the Phase 2 supervisor.
AC-2: WHEN `sessions.kill` is called over admin RPC with a valid active session id THE SYSTEM SHALL terminate that session through the supervisor and return success.
AC-3: IF `sessions.kill` is called over admin RPC with an unknown session id THEN THE SYSTEM SHALL return a JSON-RPC error mapped from `ServiceError::InvalidRequest`.
AC-4: WHEN `bob serve` shuts down THE SYSTEM SHALL wait for supervisor child reaping during shutdown phase 4 rather than treating it as a no-op.

## Dependencies

- `T-035` — idle reaping and session kill

## Files to Touch

- `the-intern/service/crates/admin-rpc/src/dispatch.rs` — implement `sessions.kill` against the supervisor handle
- `the-intern/service/crates/admin-rpc/src/lib.rs` — adjust dispatcher construction only if new supervisor calls require it
- `the-intern/service/crates/bob/src/serve.rs` — await supervisor child cleanup in shutdown phase 4

## Verification

```bash
cd the-intern/service && cargo test -p admin-rpc sessions
cd the-intern/service && cargo test -p bob serve::tests
```

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

### Session 1 — 2026-05-19

**What was done:**

This session implemented all four acceptance criteria for T-036.

**AC-1 (sessions.list returns supervisor session IDs):** The existing `handle_sessions_list` method already called `supervisor.list_sessions()` correctly. The only change needed was fixing the `make_dispatcher_with_supervisor()` test helper, which destructured the result of `pi_agent_supervisor::start` as a plain tuple when T-035 changed the return type to `ServiceResult<(Handle, JoinHandle<()>)>`. A new test (`dispatch_sessions_list_with_active_session_returns_that_session_id`) was added to confirm the method returns the actual session IDs reported by the supervisor.

**AC-2 & AC-3 (sessions.kill implementation):** The placeholder stub in the `dispatch` method was replaced with a call to a new `handle_sessions_kill` method. The method parses the session ID from `params.id` (returning `CODE_INVALID_REQUEST` if missing or unparseable), then calls `supervisor.kill_session(session_id)`. A successful kill returns `{ ok: true }`. An unknown session ID causes the supervisor to return `ServiceError::InvalidRequest`, which is mapped to `CODE_INVALID_REQUEST` by the existing `map_service_error` function. Four tests cover this: valid kill, unknown id, missing params, and no supervisor handle.

**AC-4 (shutdown phase 4 awaits supervisor cleanup):** The `Runtime` struct gained a dedicated `supervisor_join: JoinHandle<()>` field. The `pi_agent_supervisor_join` was removed from the `joins` vec (which went from 7 to 6 handles) and placed in `supervisor_join` instead. In `run_shutdown_protocol`, phase 4 now `await`s `supervisor_join` under the `shutdown_reap_deadline` timeout, replacing the previous `std::future::ready(())` no-op. This ensures `shutdown_all` (which terminates all active and warm pi-agent child processes) runs before the process exits. The `shell_e2e` integration test was updated to set `BOB_SHUTDOWN_REAP_DEADLINE=200ms` and include that duration in the exit deadline calculation; without this the test timed out because the default reap deadline is 10 seconds.

**Rejected approaches:** Considered adding a `shutdown` command to the supervisor `Handle` that would call `pool.shutdown_all()` explicitly and then await the join. Rejected this because the actor already calls `pool.shutdown_all()` when its channel closes (on handle drop), so simply awaiting the join is sufficient and avoids duplicating the cleanup logic.

**Evidence:**
- `cargo test -p admin-rpc sessions`: 8 passed, 0 failed
- `cargo test -p bob serve::tests`: 12 passed, 0 failed
- `cargo test -p admin-rpc`: 78 passed, 0 failed
- `cargo test -p bob` (full suite including shell_e2e): all passed

**Obstacles Encountered:**
- `pi_agent_supervisor::start` return type changed to `ServiceResult<(Handle, JoinHandle<()>)>` in T-035, breaking the existing test helper in `dispatch.rs`. Fixed by wrapping the destructuring in `Ok(...)`.
- The `shell_e2e.rs` integration test (outside listed scope) expected `bob serve` to exit within `SHUTDOWN_DRAIN_DEADLINE + SHUTDOWN_EXIT_MARGIN` (1100ms), which broke when phase 4 started doing real work. Fixed by configuring a tight `BOB_SHUTDOWN_REAP_DEADLINE=200ms` and adding it to the exit deadline.

**Nothing remains** — all four criteria have passing tests and the two specified verification commands both pass.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->
