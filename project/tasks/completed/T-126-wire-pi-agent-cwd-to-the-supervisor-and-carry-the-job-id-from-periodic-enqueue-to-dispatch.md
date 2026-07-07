---
id: T-126
title: Wire pi_agent_cwd to the supervisor and carry the job id from periodic 
  enqueue to dispatch
status: pending
priority: high
assigned-role: developer
created: '2026-07-05'
spec: S-009
---

# Wire pi_agent_cwd to the supervisor and carry the job id from periodic enqueue to dispatch

## Description

Startup + queue wiring in `crates/bob/src/serve.rs`. (a) Map
`BobConfig.pi_agent_cwd` (T-119) into the supervisor `Config` worker cwd (T-121)
so warm-pool workers run in the service-wide cwd; unset → inherit launch cwd.
(b) On the periodic branch (`serve.rs` ~line 190, `if event.kind ==
DeliveryKind::Periodic`) enqueue the event together with its job id
(`context.context_id`) using the correlator-carrying API from T-120, and have the
periodic dispatcher's `dequeue_next` read that job id back. Non-periodic paths
keep using the plain `enqueue` and are unchanged. This task does **not** resolve
cwd or acquire the worker (that is T-127); it only ensures `pi_agent_cwd` reaches
the pool and the job id reaches the dispatcher.

## Acceptance Criteria

AC-1: WHEN the service starts with `pi_agent_cwd` set THE SYSTEM SHALL configure
      the supervisor so warm-pool workers run in that directory.
AC-2: WHILE `pi_agent_cwd` is unset THE SYSTEM SHALL leave warm-pool workers
      inheriting the launch cwd.
AC-3: WHEN a `periodic` event is enqueued THE SYSTEM SHALL carry the firing
      entry's job id through the inbound queue to the dispatcher.
AC-4: WHILE dispatching non-periodic deliveries THE SYSTEM SHALL require no
      job-id correlator and keep existing behaviour unchanged.

## Dependencies

- `T-119` — `pi_agent_cwd` config field
- `T-120` — inbound-queue job-id correlator API
- `T-121` — supervisor `Config` worker cwd
- `T-123` — ordering-only: both edit `crates/bob/src/serve.rs`; T-123's audit
  field lands before this serve.rs wiring (no logical dependency)

## Files to Touch

- `crates/bob/src/serve.rs` — supervisor config mapping + periodic enqueue/dequeue
  job-id wiring

## Verification

```bash
cd the-intern/service && cargo build -p bob && cargo test -p bob serve
```

## Work Log

### Session 1 — 2026-07-07

Implemented both halves of T-126 in `crates/bob/src/serve.rs` via three red→green→refactor cycles, one commit each.

**Cycle 1 (AC-1/AC-2, supervisor cwd):** `build_pi_agent_supervisor_config` hardcoded `worker_cwd: None` with a comment deferring to this task. Wrote two tests first (`pi_agent_supervisor_config_maps_pi_agent_cwd_when_set`, `..._leaves_worker_cwd_unset_when_pi_agent_cwd_is_unset`); the first failed red as expected. Fix: `worker_cwd: cfg.pi_agent_cwd.clone()`. Trivial, no surprises.

**Cycle 2 (AC-3 enqueue side):** Extracted the periodic branch's inline enqueue into a new `admit_periodic_event(persistence_store: &dyn PersistenceStore, event, job_id: Option<String>)` that calls `enqueue_with_job_id` (T-120) instead of plain `enqueue`, using `context.context_id.clone()` as the job id. Two new unit tests roundtrip a job id (and its absence) through a real `persistence::Handle`.

**Cycle 3 (AC-3/AC-4 dispatcher side):** Changed `start_periodic_dispatcher`'s dequeue call from `dequeue_next()` to `dequeue_next_with_job_id()`, destructuring `(event, job_id)` in both match arms; the non-periodic re-enqueue arm deliberately keeps calling plain `enqueue(event)` (AC-4, job id dropped, unchanged). Added a `tracing::debug!` logging the job id at periodic-dispatch time, both for production observability ahead of T-127 and as an initial test hook.

**Tried and rejected:** My first test for "the dispatcher reads the job id back" used a `tracing::subscriber::set_default` capture (mirroring the pattern in `extension_ipc::multiplex::tests`) plus real `persistence`/`pi_agent_supervisor` handles. It passed in isolation but failed ~4/5 times when run as part of the full `serve` suite, always timing out at exactly 5s. Root cause: the new `tracing::debug!` callsite lives in code shared by four other pre-existing tests that run concurrently without any capturing subscriber, and `tracing`'s process-global per-callsite interest cache raced between my thread's capture and theirs. Rejected that approach and instead changed `start_periodic_dispatcher`'s `persistence` parameter from the concrete `persistence::Handle` to `Arc<dyn PersistenceStore>` (the same trait already used elsewhere in this file), letting tests inject a `SpyPersistence` that records which trait method was called (`dequeue_next` vs `dequeue_next_with_job_id`, `enqueue` vs `enqueue_with_job_id`) and serves one pre-loaded `(event, job_id)` pair. Paired with a `failing_supervisor_handle()` helper (empty warm pool, nonexistent binary, so `acquire_session` fails fast without real process I/O), the two dispatcher tests now run in ~10ms and passed cleanly across 8 repeated full-suite runs plus 3 repeated `cargo test -p bob` runs after the fix — no flakiness observed.

**Remaining work:** None within T-126's scope. Per the task description, resolving a per-job `cwd` from the job id and calling `acquire_session_with_cwd` (or similar) at dispatch time is explicitly T-127's job — this task only had to get `pi_agent_cwd` to the supervisor's warm pool and the job id to the dispatcher, both done.

**Obstacles Encountered:** The tracing-capture test flakiness described above was the only real obstacle; resolved by refactoring to a spy `PersistenceStore` rather than working around it with longer timeouts or `--test-threads=1`. No missing prerequisites (`pi` binary not needed for this task — all new/changed tests use `sh` stand-ins or fail-fast configs, consistent with existing test conventions in this file).

**Verification:** `cargo build -p bob` succeeds. `cargo test -p bob serve` — 45 lib tests + all integration binaries pass. `cargo test --workspace` — every crate's suite green (0 failed). `cargo fmt --all -- --check` clean. `cargo clippy -p bob --tests` shows no new warnings on `serve.rs` (pre-existing debt is elsewhere, per this repo's documented clippy status). Repeated the full `serve` suite 8× and full `bob` crate 3× to confirm the earlier flakiness is gone.

**Status:** Complete — all four acceptance criteria (AC-1 through AC-4) implemented and covered by passing tests.
**Branch:** `task/T-126-wire-pi-agent-cwd-to-the-supervisor-and-carry-the-job-id-from-periodic-enqueue-to-dispatch`
**Commits:** `e00900a` (AC-1/AC-2 supervisor cwd), `1c73cfc` (AC-3 enqueue side), `84cd495` (AC-3/AC-4 dispatcher side)
**Files Changed:** `the-intern/service/crates/bob/src/serve.rs` only (matches the task's "Files to Touch")
**Tests Added:** `pi_agent_supervisor_config_maps_pi_agent_cwd_when_set`, `pi_agent_supervisor_config_leaves_worker_cwd_unset_when_pi_agent_cwd_is_unset`, `admit_periodic_event_enqueues_with_job_id_from_context`, `admit_periodic_event_enqueues_with_none_job_id_when_context_has_none`, `periodic_dispatcher_calls_dequeue_next_with_job_id`, `dispatcher_re_enqueues_non_periodic_event_via_plain_enqueue`
**Verification Command Run:** `cd the-intern/service && cargo build -p bob && cargo test -p bob serve` — passes; also ran `cargo test --workspace` and `cargo fmt --all -- --check` — both clean

## Review

### Review Verdict — 2026-07-07

PASS

**Stage 1 — Acceptance Criteria** (checked against `the-intern/service/crates/bob/src/serve.rs` on `task/T-126-wire-pi-agent-cwd-to-the-supervisor-and-carry-the-job-id-from-periodic-enqueue-to-dispatch`, diffed against `dev-agent` merge-base `8003eff`):

- AC-1 (pi_agent_cwd set → worker_cwd configured): met. `build_pi_agent_supervisor_config` now sets `worker_cwd: cfg.pi_agent_cwd.clone()`. Confirmed `pi_agent_supervisor::Config.worker_cwd: Option<PathBuf>` (T-121) is consumed by `process.rs`'s `spawn` via `cmd.current_dir(worker_cwd)`. Covered by `pi_agent_supervisor_config_maps_pi_agent_cwd_when_set`.
- AC-2 (pi_agent_cwd unset → worker_cwd stays unset): met. Same mapping is `None` when `cfg.pi_agent_cwd` is `None`. Covered by `pi_agent_supervisor_config_leaves_worker_cwd_unset_when_pi_agent_cwd_is_unset`.
- AC-3 (periodic enqueue carries job id to dispatcher): met. New `admit_periodic_event` calls `PersistenceStore::enqueue_with_job_id` (T-120) with `context.context_id.clone()`, replacing the periodic branch's plain `enqueue` call in `try_start_subsystems`. `start_periodic_dispatcher` now calls `dequeue_next_with_job_id` and destructures `(event, job_id)`, logging the job id at periodic-dispatch time. Covered by `admit_periodic_event_enqueues_with_job_id_from_context`, `admit_periodic_event_enqueues_with_none_job_id_when_context_has_none`, and `periodic_dispatcher_calls_dequeue_next_with_job_id` (spy-verified: calls `dequeue_next_with_job_id`, never plain `dequeue_next`).
- AC-4 (non-periodic dispatch requires no correlator, unchanged behaviour): met. The dispatcher's non-periodic re-enqueue arm still calls plain `enqueue(event)`, dropping the job id, and the non-periodic admission path in `try_start_subsystems` (the `else` branch calling `requests_handler::run_preflight`) is untouched by this diff. Covered by `dispatcher_re_enqueues_non_periodic_event_via_plain_enqueue` (spy-verified: calls plain `enqueue`, never `enqueue_with_job_id`).
- No unspecified behaviour was added: T-127's cwd-resolution/`acquire_session_with_cwd` work is correctly left out, matching the task's explicit non-goal.
- No unexpected files modified: `git diff dev-agent...task/T-126...` touches only `the-intern/service/crates/bob/src/serve.rs` (347 insertions / 18 deletions), matching "Files to Touch."

**Stage 2 — Code Quality:**

- Correctness: `worker_cwd` mapping is a straightforward clone; `admit_periodic_event` and the dispatcher's destructuring of `(event, job_id)` correctly preserve the pre-existing warn-and-swallow error handling for enqueue/dequeue failures. Verified `ADR-012`/`ADR-013` references in new comments correspond to real, relevant ADRs on file.
- Tests: 6 new tests, covering both AC-1/AC-2 branches (set/unset) and both AC-3/AC-4 paths (job id present/absent, periodic/non-periodic), all independent (fresh `persistence::start` or `SpyPersistence` per test, no shared mutable state). The two dispatcher-level tests use a bounded polling loop (5s timeout) against an injected `SpyPersistence`, avoiding the tracing-capture race the Work Log describes hitting and rejecting.
- Security: no new external input paths; nothing hardcoded.
- Readability: new function and field comments clearly state intent and explicitly scope out T-127.
- Performance: no new blocking calls or resource leaks; polling loops are test-only.

**Independent verification performed** (branch `task/T-126-wire-pi-agent-cwd-to-the-supervisor-and-carry-the-job-id-from-periodic-enqueue-to-dispatch`, `pi` on `PATH`):
- `cargo build -p bob` — succeeds.
- `cargo test -p bob serve::` — 41 lib tests + 0 across integration binaries, all pass, including all 6 new tests (by name); repeated 3× with no flakiness.
- `cargo test --workspace` — all suites pass, 0 failed (highest single-crate count 144 passed).
- `cargo fmt --all -- --check` — clean.
- `cargo clippy -p bob --tests` — one pre-existing error (`clippy::result_unit_err` in `crates/pi-agent-supervisor/src/pool.rs::register_interactive_exit_watcher`) confirmed unrelated to this task (that file has zero diff between `dev-agent` and this branch); no new warnings attributable to `serve.rs`.

Minor observation (non-blocking): the dispatcher-level tests poll a shared spy with a 5ms sleep inside a 5s timeout — acceptable and consistent with existing patterns in this file, just noting for future reviewers that timing-based assertions remain in the suite even after the tracing-capture approach was rejected for flakiness.

Next owner: active Development Loop.
