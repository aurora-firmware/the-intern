---
id: T-039
title: Set BOB_SESSION_ID and BOB_EXTENSION_SOCK_PATH on every pi-agent child 
  spawn
status: completed
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

### Session 1 — 2026-05-19

Implemented all four acceptance criteria for T-039. The change touches the files listed in the task plus `admin-rpc/src/dispatch.rs` (test-only lines), which required a design decision explained below.

**What was done**

`process.rs` — extended `WorkerProcessConfig` with two new fields: `session_id: SessionId` and `extension_sock_path: PathBuf`. The `spawn` method now always calls `cmd.env("BOB_SESSION_ID", ...)` and conditionally calls `cmd.env("BOB_EXTENSION_SOCK_PATH", ...)` only when the path is non-empty. Three new tests cover AC-1, AC-2, and AC-3 at the spawn level.

`lib.rs` — added `extension_sock_path: PathBuf` to `Config` (defaulting to empty `PathBuf`). Changed the `Command::AcquireSession` variant and `Handle::acquire_session` to remove the `session_id` input and return `ServiceResult<SessionId>` — the actual id used for the session. The actor logs the allocated id on success.

`pool.rs` — introduced a `WarmWorker { session_id, worker }` struct. Warm workers are now spawned via `spawn_warm_worker(cfg)` which allocates a fresh `SessionId` and sets it as `BOB_SESSION_ID`. `acquire_session()` promotes a warm worker using its pre-allocated id (or spawns an overflow worker with a new id) and returns that id. `send_prompt` no longer implicitly acquires — callers must call `acquire_session` first. The surplus-reap and shutdown paths were updated to access `.worker` through the new struct.

`bob/src/serve.rs` — `build_pi_agent_supervisor_config` now maps `cfg.extension_sock_path` into the supervisor `Config`. Two new unit tests verify the mapping for non-empty and empty paths.

**Design decision: acquire_session API shape**

The task explicitly permits changing the Handle API shape. The previous `acquire_session(external_session_id)` signature was incompatible with AC-4 for warm workers because `BOB_SESSION_ID` is set at spawn time (before any external id exists), so the session id stored in `active_workers` must equal the pre-allocated id. Changing the return type to `ServiceResult<SessionId>` and removing the input was the only design that satisfies AC-1, AC-4, and keeps the pool logic coherent.

The admin-rpc `dispatch.rs` had two test-setup call sites (`acquire_session(session_id)`) that needed updating to `acquire_session()` with the return value captured. The production dispatch methods (`sessions.list`, `sessions.kill`) were unaffected — the existing admin-RPC contract is preserved. A `test(admin-rpc)` commit documents this as a test-only consequence of the API change.

**Removed behavior**: `send_prompt` no longer implicitly acquires a session for an unknown id. The old test `send_prompt_acquires_missing_session_before_sending` was replaced by `send_prompt_returns_child_process_error_when_session_not_yet_acquired` which documents the new explicit-acquire requirement.

**Obstacles**: one pre-existing flaky test (`terminate_requests_graceful_shutdown_before_deadline`) appeared once in a full run but passed consistently when isolated. This is a SIGTERM timing race unrelated to this task.

**All verification commands pass**: `cargo test -p pi-agent-supervisor` (39 tests), `cargo test -p bob serve::tests` (14 tests).

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->

### Review Verdict — 2026-05-19

PASS

**Stage 1 — Spec compliance**

- AC-1: Confirmed. `process.rs` line 46 calls `cmd.env("BOB_SESSION_ID", cfg.session_id.to_string())` unconditionally on every spawn. Both warm workers (via `spawn_warm_worker` in `pool.rs`) and overflow workers (allocated inline in `acquire_session`) receive a pre-allocated `SessionId` at spawn time. Verified by `process::tests::spawn_sets_bob_session_id_on_child_environment`. PASS.
- AC-2: Confirmed. `process.rs` lines 48-50 call `cmd.env("BOB_EXTENSION_SOCK_PATH", &cfg.extension_sock_path)` when the path is non-empty. Verified by `process::tests::spawn_sets_bob_extension_sock_path_when_path_is_non_empty`. PASS.
- AC-3: Confirmed. The guard `!cfg.extension_sock_path.as_os_str().is_empty()` correctly skips setting the variable when the path is empty, and spawn continues without it. Verified by `process::tests::spawn_omits_bob_extension_sock_path_when_path_is_empty`. PASS.
- AC-4: Confirmed. `pool.rs` `WarmWorker` stores the pre-allocated `session_id`; `acquire_session` promotes the warm worker using that same id as the `active_workers` key, which is what `list_sessions` returns. The integration test `tests::sessions_list_reports_same_id_as_bob_session_id_env_on_worker_process` spawns a real sh process, captures `BOB_SESSION_ID` from its environment via a temp file, and asserts equality with the `sessions.list` result. PASS.
- Files outside the stated scope: `admin-rpc/src/dispatch.rs` was touched. Both hunks fall entirely inside `mod tests` (at lines 836 and 869 of the diff). Production dispatch methods (`sessions.list`, `sessions.kill`) are unchanged. The scope expansion is test-only and is justified in the Work Log. PASS.
- `acquire_session` API shape change: the task explicitly permits handle API changes. Removing the input parameter and returning `ServiceResult<SessionId>` is the only design consistent with pre-allocated warm-worker ids. PASS.

**Stage 2 — Code quality**

- Correctness: Logic is correct for warm-pool promotion, overflow spawn, and max-capacity rejection. `send_prompt` now requires an explicit prior `acquire_session` call; the changed behaviour is documented in the Work Log and covered by a new test. No off-by-one or null-reference issues observed.
- Tests: 39 pi-agent-supervisor tests, 14 bob serve::tests, 78 admin-rpc tests — all pass. New tests cover AC-1/AC-2/AC-3 at the `process.rs` level, AC-1/AC-4 at the `pool.rs` level, AC-4 at the `lib.rs` integration level, and AC-2/AC-3 at the `serve.rs` plumbing level. Success and failure paths are covered. Tests are independent.
- Security: no hardcoded secrets; paths are passed as `PathBuf` values, not interpolated strings; no new permissions.
- Readability: `WarmWorker` struct, `spawn_warm_worker`, and `worker_process_config_for_session` are well-named. Doc-comments explain the pre-allocation invariant. No dead code or debugging artifacts.
- Performance: no unnecessary loops or blocking operations introduced.
- Pre-existing flaky test (`terminate_requests_graceful_shutdown_before_deadline`): confirmed pre-existing in `dev-agent` baseline — present before this branch. Non-blocking.

Both stages pass. No escalation required.
