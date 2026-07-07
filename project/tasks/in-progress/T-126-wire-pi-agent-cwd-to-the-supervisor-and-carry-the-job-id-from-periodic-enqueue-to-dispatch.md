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
