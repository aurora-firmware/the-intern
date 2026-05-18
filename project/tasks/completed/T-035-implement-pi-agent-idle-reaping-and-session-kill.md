---
id: T-035
title: Implement pi-agent idle reaping and session kill
status: completed
priority: high
assigned-role: unassigned
created: '2026-05-18'
spec: S-001
---

# Implement pi-agent idle reaping and session kill

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

Implement Phase 2 cleanup semantics in the supervisor. The architecture requires
pi-agent processes to be reaped after a configurable idle period, and the shell
already exposes `bob sessions kill <id>` through the admin RPC surface.

This task should make `Handle::kill_session` real and add deterministic
idle-reap behavior for active sessions and surplus warm workers. Use controllable
time in tests where possible.

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

AC-1: WHEN a session has no prompt activity for `pi_agent_idle_reap_timeout` THE SYSTEM SHALL terminate that session's worker and remove it from `list_sessions`.
AC-2: WHEN `Handle::kill_session(session_id)` is called for an active session THE SYSTEM SHALL terminate that session's worker and return `Ok(())`.
AC-3: IF `Handle::kill_session(session_id)` is called for an unknown session THEN THE SYSTEM SHALL return `ServiceError::InvalidRequest` with safe detail text.
AC-4: WHILE the supervisor is running THE SYSTEM SHALL keep the warm pool at or below `pi_agent_warm_pool_size` after reap activity.
AC-5: WHEN the supervisor actor stops THE SYSTEM SHALL terminate all active and warm pi-agent child processes.

## Dependencies

- `T-034` — prompt routing updates session activity

## Files to Touch

- `the-intern/service/crates/pi-agent-supervisor/src/reaper.rs` — new idle-reap and shutdown cleanup helper
- `the-intern/service/crates/pi-agent-supervisor/src/lib.rs` — implement `kill_session`, reaper ticks, and actor shutdown cleanup
- `the-intern/service/crates/pi-agent-supervisor/src/pool.rs` — track last activity and termination selection

## Verification

```bash
cd the-intern/service && cargo test -p pi-agent-supervisor reaper
cd the-intern/service && cargo test -p pi-agent-supervisor kill_session
```

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

### Session 1 — 2026-05-18

Implemented Phase 2 cleanup semantics in pi-agent-supervisor with TDD on the task branch. First cycle covered kill-session behavior: I replaced the old not-implemented test with explicit success/error cases, verified red, implemented pool-backed termination, and wired actor handling so active sessions are terminated and unknown sessions return ServiceError::InvalidRequest with safe detail. Second cycle added reaping/shutdown behavior: I introduced a dedicated reaper helper module, added last prompt activity tracking per active session, wired periodic reap ticks in the actor, implemented idle session termination and surplus warm-worker trimming, and added actor-stop cleanup that terminates all active and warm workers.

For AC-5 validation, I first tried TERM-trap file markers and rejected that approach because shell trap timing was not reliable under test; I switched to PID-capture at worker startup plus post-shutdown `/proc` non-existence checks, which produced stable evidence that both active and warm workers are terminated.

Remaining work in this task branch: none; ready for reviewer and loop handoff append on `dev-agent`.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->

### Review Verdict — 2026-05-18
PASS

Stage 1 (acceptance criteria) and Stage 2 (code quality) passed against branch `task/T-035-implement-pi-agent-idle-reaping-and-session-kill`.

- AC-1: Verified idle reaping removes inactive sessions from active map/list and terminates workers via `Actor` reap tick + `SessionPool::reap_idle_and_surplus` (`src/lib.rs`, `src/pool.rs`) with coverage in `idle_reaper_removes_session_after_idle_timeout_without_prompt_activity`.
- AC-2: Verified `Handle::kill_session` now routes to pool termination and returns `Ok(())` for active sessions with coverage in `kill_session_terminates_active_session_and_removes_it_from_list`.
- AC-3: Verified unknown session kill returns `ServiceError::InvalidRequest` with safe detail text (`"session is not active"`) with coverage in `kill_session_returns_invalid_request_for_unknown_session`.
- AC-4: Verified reap path trims surplus warm workers to at most `warm_pool_size` via `surplus_warm_worker_count` and `reap_idle_and_surplus`, covered in `reap_idle_and_surplus_terminates_surplus_warm_workers_above_configured_pool_size`.
- AC-5: Verified actor shutdown calls pool-wide termination for active and warm workers via `shutdown_all`, with test `actor_shutdown_terminates_active_and_warm_worker_processes`.

Verification evidence run on implementation branch:

- `cd the-intern/service && cargo test -p pi-agent-supervisor reaper`
- `cd the-intern/service && cargo test -p pi-agent-supervisor kill_session`
- `cd the-intern/service && cargo test -p pi-agent-supervisor`
