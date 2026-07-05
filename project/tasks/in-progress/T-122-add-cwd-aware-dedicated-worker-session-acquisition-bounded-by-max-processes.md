---
id: T-122
title: Add cwd-aware dedicated-worker session acquisition bounded by 
  max_processes
status: pending
priority: high
assigned-role: developer
created: '2026-07-05'
spec: S-002
---

# Add cwd-aware dedicated-worker session acquisition bounded by max_processes

## Description

Per S-002 (Component 6, warm-pool contract), a per-entry scheduled `cwd` cannot
reuse a warm-pool worker — warm workers are pre-spawned with the service-wide
cwd. Add a cwd-aware acquisition path on the pool
(`crates/pi-agent-supervisor/src/pool.rs`, spawn helper in `process.rs`) that
spawns a **dedicated** worker whose `current_dir` is a caller-supplied directory
instead of binding a warm worker. Bound it by `max_processes` exactly like the
existing `acquire_session`: when active + warm workers already fill the limit,
**refuse** the acquisition (no eviction, no exceeding the bound) so the caller
(T-127) can skip the fire. A dedicated cwd-scoped worker consumes one
`max_processes` slot for the duration of the run.

## Acceptance Criteria

AC-1: WHEN a session is acquired with a caller-supplied working directory THE
      SYSTEM SHALL spawn a dedicated worker whose current directory is that
      directory rather than reusing a warm-pool worker.
AC-2: IF active plus warm workers already fill `max_processes` when a cwd-scoped
      session is requested THEN THE SYSTEM SHALL refuse the acquisition without
      evicting a live worker or exceeding the bound.
AC-3: WHILE a cwd-scoped dedicated worker is active THE SYSTEM SHALL count it
      against the `max_processes` limit for the duration of the run.

## Dependencies

- `T-121` — supervisor `Config` and worker-spawn `current_dir` support

## Files to Touch

- `crates/pi-agent-supervisor/src/pool.rs` — add cwd-aware acquisition + bound check
- `crates/pi-agent-supervisor/src/process.rs` — spawn a dedicated worker at a cwd

## Verification

```bash
cd the-intern/service && cargo test -p pi-agent-supervisor
```

## Work Log

### Session 1 — 2026-07-05

Implemented T-122 end to end via TDD across three red→green→refactor cycles (four commits total, including a refactor), all on the task branch.

**Cycle 1 (AC-1):** Added `SessionPool::acquire_session_with_cwd(&mut self, cwd: PathBuf) -> ServiceResult<SessionId>` to `pool.rs`, plus a private `worker_process_config_for_cwd_session` helper that builds a `WorkerProcessConfig` via the existing `worker_process_config_for_session` helper but overrides `worker_cwd` with the caller-supplied directory. Wrote two tests first (`acquire_session_with_cwd_does_not_consume_a_warm_worker`, which asserts `warm_worker_count()` is unchanged after a cwd-scoped acquisition even when a warm worker is available; and `acquire_session_with_cwd_spawns_dedicated_worker_running_in_given_directory`, a real-spawn test that has the child run `pwd > marker.txt` and asserts the canonicalized marker contents match the caller-supplied cwd), confirmed both failed to compile (method didn't exist), then implemented the minimal method and confirmed both passed.

**Cycle 2 (AC-2):** Added the `max_processes` bound check to `acquire_session_with_cwd` (`total_process_count() >= max_processes` refuses with `ServiceError::ChildProcess`, mirroring `acquire_session`'s existing check). Wrote `acquire_session_with_cwd_refuses_without_evicting_when_max_processes_is_full` first (warm pool already at capacity 1/1), confirmed it failed (the call succeeded because no bound check existed yet), then added the check and confirmed pass, along with asserting the warm worker survives and no active session was created.

**Cycle 3 (AC-3):** Wrote `acquire_session_with_cwd_counts_toward_max_processes_while_active`, which acquires a cwd-scoped session at `max_processes = 1`, then asserts a subsequent `acquire_session()` is refused while the dedicated worker remains active. This test passed immediately without further production changes, since AC-3 is a natural consequence of cycles 1-2 (the dedicated worker is inserted into `active_workers`, which `total_process_count()` already counts). Following the precedent set in T-121's Work Log, confirmed the test wasn't vacuous by temporarily making `acquire_session_with_cwd` not track the spawned worker (dropping it instead of inserting into `active_workers`), reran the test, observed the expected failure (subsequent `acquire_session()` unexpectedly succeeded), then restored the correct implementation and reran to confirm green. Committed as a `test(...)` commit since production code was already correct.

**Refactor cycle:** `acquire_session` and `acquire_session_with_cwd` had identical `active_workers.insert(...)` blocks; extracted a shared private `track_active_worker(&mut self, session_id, worker)` helper and reran the full `pi-agent-supervisor` suite (60 passed) plus `cargo fmt --all -- --check` (clean) to confirm no behavior change.

**Post-cycle full-suite check:** Ran `cargo build -p bob` and `cargo test --workspace` (broader than the task's own verification command) — both green, no regressions in any other crate.

**What remains:** Nothing outstanding for T-122 itself. Per the task description, T-127 (pending) will call `acquire_session_with_cwd` from the periodic dispatcher with the resolved per-entry cwd, and skip the fire on refusal (that dispatcher-level wiring, including any needed actor `Command`/`Handle` surface in `lib.rs`, is explicitly out of this task's file scope). No rejected approaches worth recording — the two-method-with-shared-tracking-helper design followed directly from the existing `acquire_session` structure.

**Obstacles Encountered:** The task's "Files to Touch" list includes `crates/pi-agent-supervisor/src/process.rs`, but no change was needed there. T-121 (a stated dependency, already completed) had already added generic `worker_cwd: Option<PathBuf>` support to `WorkerProcessConfig` and `RpcWorkerProcess::spawn`. The new pool-level method reuses that existing, already-tested spawn path by overriding `worker_cwd` per call rather than duplicating spawn logic, so `process.rs` was left untouched — noted here for the reviewer since it's a deviation from touching every file named in the task, even though it stays within the file-scope boundary. Also: `cargo clippy -p pi-agent-supervisor --all-targets -- -D warnings` cannot even reach this crate because `bob-core` fails to compile under `-D warnings` due to pre-existing pedantic lint debt (confirmed as expected per CLAUDE.md, which documents clippy as not yet a clean gate for this workspace); not treated as a blocker since it is outside this task's verification command and pre-existing.

## Review

### Review Verdict — 2026-07-05

PASS

**Stage 1 — Acceptance Criteria**

- AC-1 (dedicated worker at caller-supplied cwd, not a warm worker): Met. `acquire_session_with_cwd` (`pool.rs`) always spawns a fresh worker via `worker_process_config_for_cwd_session`, which overrides `worker_cwd` with the caller's directory; it never pops from `warm_workers`. Verified by `acquire_session_with_cwd_does_not_consume_a_warm_worker` (warm worker count unchanged) and `acquire_session_with_cwd_spawns_dedicated_worker_running_in_given_directory` (real spawn, child's `pwd` matches the caller-supplied, canonicalized directory). Both pass.
- AC-2 (refuse without eviction when `max_processes` is full): Met. The bound check `total_process_count() >= self.cfg.max_processes` runs before any spawn and returns `ServiceError::ChildProcess` without touching `warm_workers` or `active_workers`. Verified by `acquire_session_with_cwd_refuses_without_evicting_when_max_processes_is_full` (warm pool at 1/1, refusal confirmed, warm worker count and active session count both unchanged afterward).
- AC-3 (dedicated worker counts toward the bound while active): Met. The dedicated worker is tracked via the new shared `track_active_worker` helper, which inserts into `active_workers` — already counted by `total_process_count()`. Verified by `acquire_session_with_cwd_counts_toward_max_processes_while_active` (a subsequent plain `acquire_session()` is refused while the dedicated worker is alive), and the Work Log records a deliberate vacuity check (temporarily not tracking the worker, confirming the test fails) before restoring the correct implementation.
- No unspecified behavior added; only `pool.rs` and the task file were touched. The Work Log's noted deviation (leaving `process.rs` untouched) is justified: T-121 already added generic `worker_cwd: Option<PathBuf>` plumbing through `WorkerProcessConfig`/`RpcWorkerProcess::spawn`, confirmed by reading `process.rs` — reusing that existing, already-tested spawn path instead of duplicating it is the correct, minimal approach, not a scope gap.

**Stage 2 — Code Quality**

- Correctness: The bound check mirrors `acquire_session`'s existing check and is evaluated with `&mut self` under `current_thread` async tests, so there is no TOCTOU race. `worker_process_config_for_cwd_session` correctly reuses the base config and overrides only `worker_cwd` via struct-update syntax.
- Tests: Four new tests cover the happy path, the real-spawn cwd verification, the refusal path (with explicit non-eviction and non-creation assertions), and the bound-persists-while-active path, each using a uniquely named temp directory (no shared mutable state across tests). Confirmed independently:
  - `cd the-intern/service && cargo test -p pi-agent-supervisor` → 60 passed, 0 failed.
  - `cargo test --workspace` → all crates green, no regressions.
  - `cargo fmt --all -- --check` → clean.
  - `cargo build -p bob` → clean, no warnings.
- Security: No external/untrusted input handling introduced beyond what `acquire_session` already does; no secrets, no injection surface.
- Readability: Method and helper names are descriptive (`acquire_session_with_cwd`, `worker_process_config_for_cwd_session`, `track_active_worker`); doc comments correctly cite S-002 Component 6. No dead code.
- Performance: No unnecessary loops or blocking calls; the refactor into `track_active_worker` removes duplication without changing behavior (verified by the full suite staying green across the refactor commit).

**Commits:** Four commits on `task/T-122-...` (`feat`, `feat`, `test`, `refactor`), each following `<type>(<component>): <description>` format, imperative, lowercase, no period, under 72 chars, no task ID repeated.

No blocking issues found.
