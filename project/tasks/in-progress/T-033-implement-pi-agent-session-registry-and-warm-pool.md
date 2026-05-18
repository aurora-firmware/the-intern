---
id: T-033
title: Implement pi-agent session registry and warm pool
status: pending
priority: high
assigned-role: unassigned
created: '2026-05-18'
spec: S-001
---

# Implement pi-agent session registry and warm pool

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

Implement the supervisor's in-memory session registry and fail-fast warm-pool
allocation. The architecture requires one pi-agent process per active
user-session, with a small pre-warmed pool to hide spawn latency. Warm workers
are unbound RPC-mode children; assigning a session turns a warm worker into an
active session worker.

This task should keep prompt delivery out of scope. It should provide the
allocation/listing primitives that prompt routing and admin session listing will
use later. Because `pi` is a hard project prerequisite, supervisor startup must
fail if the configured warm workers cannot be spawned.

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

AC-1: WHEN the supervisor starts THE SYSTEM SHALL maintain up to `pi_agent_warm_pool_size` idle RPC workers without exceeding `pi_agent_max_processes`.
AC-2: WHEN a session is acquired THE SYSTEM SHALL bind an idle warm worker to the requested `SessionId` when one exists, otherwise spawn a new RPC worker unless doing so would exceed `pi_agent_max_processes`.
AC-3: IF acquiring a session would exceed `pi_agent_max_processes` THEN THE SYSTEM SHALL return `ServiceError::ChildProcess`.
AC-4: IF startup cannot spawn the configured warm-pool workers THEN THE SYSTEM SHALL fail supervisor startup with `ServiceError::ChildProcess`.
AC-5: WHEN `Handle::list_sessions()` is called THE SYSTEM SHALL return the active session ids currently bound to workers.

## Dependencies

- `T-032` — RPC child-process lifecycle

## Files to Touch

- `the-intern/service/crates/pi-agent-supervisor/src/pool.rs` — new session registry and warm-pool state
- `the-intern/service/crates/pi-agent-supervisor/src/lib.rs` — add handle commands for acquiring sessions and listing active sessions
- `the-intern/service/crates/pi-agent-supervisor/src/process.rs` — adapt process helper only if pool ownership requires it
- `the-intern/service/crates/bob/src/serve.rs` — handle fallible supervisor startup so missing `pi` stops `bob serve`

## Verification

```bash
cd the-intern/service && cargo test -p pi-agent-supervisor pool
cd the-intern/service && cargo test -p pi-agent-supervisor list_sessions
cd the-intern/service && cargo test -p bob serve::tests
```

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

### Session 1 — 2026-05-18

Implemented T-033 in four TDD cycles. First, I added pool startup tests and implemented warm-pool preallocation with a cap at `min(warm_pool_size, max_processes)`, plus fail-fast `ChildProcess` propagation when warm workers cannot spawn. Second, I added acquisition tests and implemented session binding semantics: consume warm workers first, spawn on demand when under capacity, and return `ServiceError::ChildProcess` when acquisition would exceed `max_processes`. Third, I wired the pool into the supervisor actor/handle flow: added `acquire_session`, implemented real `list_sessions`, and changed `start` to return `ServiceResult` so startup fails immediately if warm-pool spawn fails. Fourth, I updated `bob::serve` to handle fallible supervisor startup and added a serve test that verifies startup returns `ServiceDown` when the configured worker command is missing, ensuring `bob serve` does not continue in that state.

Tried and rejected: relying on sandbox execution for `serve::tests`; Unix-socket bind tests failed with `Operation not permitted`, so verification was rerun outside sandbox. Also avoided introducing extra API churn in unrelated crates by keeping changes scoped to task-listed files only.

Remaining work: none for this task's acceptance criteria; handoff ready for reviewer.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->
