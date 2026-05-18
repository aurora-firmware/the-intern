---
id: T-031
title: Add pi-agent supervisor RPC process configuration
status: pending
priority: high
assigned-role: unassigned
created: '2026-05-18'
spec: S-001
---

# Add pi-agent supervisor RPC process configuration

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

Add Phase 2 process-pool configuration to the service and supervisor. The
approved architecture requires one supervised pi-agent process per active
user-session, drawn from a warm pool and reaped after an idle timeout.

The pi-agent binary is a hard runtime prerequisite named `pi`. The worker launch
mode for Phase 2 is `pi --mode rpc`, using JSONL over stdin/stdout per
https://pi.dev/docs/latest/rpc. Do not implement a substitute when `pi` is not
available; the service must surface a child-process/configuration error so the
work can stop and escalate.

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

AC-1: The system shall expose `pi_agent_command`, `pi_agent_args`, `pi_agent_warm_pool_size`, `pi_agent_max_processes`, and `pi_agent_idle_reap_timeout` in `BobConfig`.
AC-2: WHEN `BobConfig::default()` is used THE SYSTEM SHALL configure the worker command as `pi`, include `--mode rpc` in the worker arguments, and use positive process-pool defaults.
AC-3: IF `pi_agent_warm_pool_size` is zero, `pi_agent_max_processes` is zero, or `pi_agent_warm_pool_size` is greater than `pi_agent_max_processes` THEN THE SYSTEM SHALL return a configuration error.
AC-4: WHEN `bob serve` constructs `pi_agent_supervisor::Config` THE SYSTEM SHALL pass the configured command, arguments, warm-pool size, maximum process count, idle timeout, command-buffer size, and `shutdown_reap_deadline` as the child termination deadline into the supervisor.

## Dependencies

- None

## Files to Touch

- `the-intern/service/crates/bob/src/config.rs` — add Phase 2 pi-agent process-pool settings, defaults, deserialization, and validation
- `the-intern/service/crates/pi-agent-supervisor/src/lib.rs` — extend `Config` with worker command, args, pool limits, idle timeout, and child termination deadline fields
- `the-intern/service/crates/bob/src/serve.rs` — pass `BobConfig` Phase 2 settings into `pi_agent_supervisor::start`

## Verification

```bash
cd the-intern/service && cargo test -p bob config
cd the-intern/service && cargo test -p bob serve::tests
cd the-intern/service && cargo test -p pi-agent-supervisor --lib
```

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

### Session 1 — 2026-05-18

Implemented T-031 via TDD across three cycles. First, I added failing config tests for new Phase 2 keys, then implemented `BobConfig`/`RawBobConfig` fields (`pi_agent_command`, `pi_agent_args`, `pi_agent_warm_pool_size`, `pi_agent_max_processes`, `pi_agent_idle_reap_timeout`) with defaults (`pi`, `--mode rpc`, positive pool limits) and loader support. Second, I added failing validation tests for invalid pool settings and implemented startup validation errors when warm pool is zero, max processes is zero, or warm pool exceeds max. Third, I added failing tests for supervisor config expansion and serve wiring, then extended `pi-agent-supervisor::Config` with worker command/args, pool sizing, idle reap timeout, command buffer, and child termination deadline, and updated `bob serve` to pass all required values (including `shutdown_reap_deadline` as the child termination deadline).

I also tried running the task's exact verification commands. `cargo test -p pi-agent-supervisor --lib` passed. The two bob commands that include socket-heavy tests failed in this sandbox with `Operation not permitted` when binding Unix sockets; I did not alter those unrelated tests or runtime behaviors because they are outside this task's scope.

Remaining work: none in implementation scope; this is ready for reviewer/loop handoff and canonical Work Log append on `dev-agent`.

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

- Stage 1 (acceptance criteria): AC-1 through AC-4 are satisfied in the implementation branch. `BobConfig` exposes all required Phase 2 fields with defaults, validates invalid pool-size combinations, `pi_agent_supervisor::Config` includes the required process/pool fields, and `bob serve` maps command, args, pool limits, idle timeout, command buffer, and `shutdown_reap_deadline` to `child_termination_deadline`.
- Stage 2 (quality): No correctness, security, readability, or performance defects found in scope. Changed code is limited to expected files plus task log updates.
- Verification evidence: `cargo test -p pi-agent-supervisor --lib` passed. The two bob verification commands fail in this sandbox due to Unix socket bind permission (`Operation not permitted`), not due to task logic.
