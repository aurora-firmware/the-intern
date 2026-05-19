---
id: T-039
title: Set BOB_SESSION_ID and BOB_EXTENSION_SOCK_PATH on every pi-agent child 
  spawn
status: pending
priority: high
assigned-role: unassigned
created: '2026-05-19'
spec: S-003
---

# Set BOB_SESSION_ID and BOB_EXTENSION_SOCK_PATH on every pi-agent child spawn

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

Phase 3 of S-003. The pi-agent supervisor must set two environment
variables on every `pi` child process it spawns (warm or active):

- `BOB_SESSION_ID` — the bob-service-side session id used for that
  worker. The bob extension reads this value verbatim and tags every
  outbound frame with it; the bob service's multiplex routes by exact
  match.
- `BOB_EXTENSION_SOCK_PATH` — absolute path to the running service's
  `extension.sock` (already available as `BobConfig::extension_sock_path`
  in `the-intern/service/crates/bob/src/config.rs`). Must be plumbed
  from `BobConfig` into `pi_agent_supervisor::Config` via
  `build_pi_agent_supervisor_config` in `bob/src/serve.rs`, then into
  the spawn site.

Warm-pool workers are spawned before any external session id exists.
To honour AC-1, the pool must allocate a `SessionId` per warm worker at
spawn time, store it on the worker record, and use that same id as the
session id when the worker is bound to a session via the existing
`acquire_session`/`submit_prompt` paths. The handle API in
`pi-agent-supervisor/src/lib.rs` may change shape if needed (e.g. the
supervisor returns the chosen id), but the existing admin-RPC contract
(`sessions.list` and `sessions.kill` per T-036) must keep working.

If `BOB_EXTENSION_SOCK_PATH` cannot be resolved (empty `PathBuf`), the
supervisor MUST still spawn pi but without that variable set, rather
than failing the spawn.

## Acceptance Criteria

AC-1: WHEN the supervisor spawns a pi-agent process (warm or in response to `acquire_session`) THE SYSTEM SHALL set `BOB_SESSION_ID` on the child environment to the `SessionId` value the supervisor uses for that process.
AC-2: WHEN the supervisor spawns a pi-agent process and `BOB_EXTENSION_SOCK_PATH` is configured to a non-empty absolute path THE SYSTEM SHALL set that path on the child environment as `BOB_EXTENSION_SOCK_PATH`.
AC-3: IF `BOB_EXTENSION_SOCK_PATH` resolves to an empty or unset path THEN THE SYSTEM SHALL spawn the pi-agent child without `BOB_EXTENSION_SOCK_PATH` set rather than failing the spawn.
AC-4: WHILE a warm worker is bound to a session THE SYSTEM SHALL ensure `sessions.list` reports a session id equal to the `BOB_SESSION_ID` value set on that worker process.

## Dependencies

- None — this task is parallel-safe with T-037, T-038, and T-040.

## Files to Touch

- `the-intern/service/crates/pi-agent-supervisor/src/process.rs` — extend `WorkerProcessConfig` with the env-var inputs and call `Command::env(...)` on spawn.
- `the-intern/service/crates/pi-agent-supervisor/src/pool.rs` — generate a `SessionId` per warm worker, plumb it and the configured extension sock path through `worker_process_config`, adjust `acquire_session` to honour pre-allocated ids.
- `the-intern/service/crates/pi-agent-supervisor/src/lib.rs` — expose the configured `extension_sock_path` on the supervisor `Config`; update the actor command dispatch if `acquire_session` shape changes.
- `the-intern/service/crates/bob/src/serve.rs` — pass `cfg.extension_sock_path` into `build_pi_agent_supervisor_config`.

## Verification

```bash
cd the-intern/service
cargo test -p pi-agent-supervisor
cargo test -p bob serve::tests
```

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->
