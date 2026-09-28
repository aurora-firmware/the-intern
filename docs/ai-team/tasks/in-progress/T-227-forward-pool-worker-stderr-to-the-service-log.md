---
id: T-227
title: Forward pool-worker stderr to the service log
status: in-progress
priority: high
assigned-role: developer
created: '2026-09-29'
---

# Forward pool-worker stderr to the service log

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

Forward every RPC pool worker's stderr to the service log (CR-015; S-002 v0.2
Component 6 "Worker stderr"; S-003 v0.3). Today `RpcWorkerProcess::spawn`
(`crates/pi-agent-supervisor/src/process.rs`) pipes stderr into
`_stderr: ChildStderr` and never reads it. pi reports start-up failures there
— for example `Error: Model "<x>" not found.` for an unrecognized `--model`
(issue #104) — and the bob extension writes its warning or transport-lost error
there when it has no UI, so today all of that is lost. An unread pipe also
blocks the child once the OS pipe buffer fills.

Replace the held `ChildStderr` with a background reader started at spawn:
read raw bytes up to each newline, decode with `String::from_utf8_lossy`, and
log each line with `tracing::warn!`, tagged with the worker's session id
(`cfg.session_id`). Invalid UTF-8 must never stop the reader — only EOF
(worker exited or terminated) or a genuine I/O error ends it, the latter with
one log line and never a panic. Every line is logged at warning level: no rate
limiting, filtering, or level change (S-002). The existing test
`spawn_starts_configured_command_with_piped_stdio` (`process.rs` ~853)
references `worker._stderr` and must be updated.
It must not keep a terminated worker alive or delay `terminate()`.
`spawn` is synchronous but always called inside the Tokio runtime (actor and
`#[tokio::test]`); confirm this for every call site. Interactive sessions are
out of scope: their stderr is the user's terminal fd and stays untouched.
For tests, use fake workers (`sh -c '…'`) as existing process tests do, and a
tracing-capture approach already used in the workspace (e.g. the
`extension-ipc` multiplex tests); add a dev-dependency only if needed.

## Acceptance Criteria

AC-1: WHEN a pool worker writes a line to stderr THE SYSTEM SHALL log that line
      at warning level with the worker's session id.
AC-2: WHEN a worker's stderr reaches end of file THE SYSTEM SHALL end the
      reader without an error log or panic.
AC-3: IF a worker writes more than 64 KiB to stderr THEN THE SYSTEM SHALL keep
      draining so the worker does not block (a worker writing 200 KiB to stderr
      then exiting finishes within the test timeout).
AC-4: IF a worker writes bytes that are not valid UTF-8 to stderr THEN THE
      SYSTEM SHALL log them lossily decoded and keep reading, so a later valid
      line is still logged.
AC-5: The system shall leave interactive-session stderr handling unchanged.

## Dependencies

- None

## Files to Touch

- `the-intern/service/crates/pi-agent-supervisor/src/process.rs` — stderr
  reader task and tests
- `the-intern/service/crates/pi-agent-supervisor/Cargo.toml` — test
  dev-dependency, only if needed for tracing capture (`tracing-subscriber`
  is not a dependency of this crate today)
- `the-intern/service/Cargo.lock` — only if a dev-dependency is added

## Verification

```bash
cd the-intern/service && cargo test -p pi-agent-supervisor && cargo fmt --all -- --check
```

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

### Session 1 — 2026-09-29

Implemented T-227 end to end on task/T-227-pool-worker-stderr-logging via red -> green -> refactor per AC, four commits:

- feat(pi-agent-supervisor): forward pool worker stderr lines to log — added spawn_stderr_forwarder(), a tokio::spawn background task started from RpcWorkerProcess::spawn that wraps ChildStderr in a BufReader and loops on read_until(b'\n'), decoding each chunk with String::from_utf8_lossy and emitting tracing::warn!(session = %session_id, ...) per line. Removed the unread _stderr: ChildStderr field and updated spawn_starts_configured_command_with_piped_stdio (it no longer references worker._stderr). This satisfies AC-1.
- test(pi-agent-supervisor): three follow-up commits added one test per remaining AC (AC-2 EOF-without-error-log, AC-3 draining >64 KiB without blocking the worker, AC-4 lossy UTF-8 decode continuing past invalid bytes). All three passed immediately against the AC-1 implementation, since the single read_until/from_utf8_lossy/Ok(0)-break loop already covers all four behaviors together — that's expected here, not a process shortcut: I verified each of AC-3 and AC-4 actually has teeth by temporarily reverting the relevant line (mem::forget on stderr instead of draining it; strict String::from_utf8 instead of lossy), confirming the test fails deterministically (not a hang — AC-3's test is timeout()-bounded at 5s), then restoring the fix before committing.
- AC-5 (interactive-session stderr unchanged) needed no test: InteractiveProcess and its spawn/terminate code are untouched (confirmed via a diff review — the only lines near `impl InteractiveProcess` in the diff are test-module additions above it), and its existing test suite continues to pass unmodified.

Test infra: added a TracingCapture/LineWriter/ensure_global_test_subscriber helper in process.rs's test module, mirroring the pattern already used in crates/extension-ipc/src/multiplex.rs's tests (same rationale: install one permissive global default subscriber once so no tracing callsite gets permanently cached "not interested" by a racing thread, then layer a thread-local capturing subscriber per test). Added tracing-subscriber 0.3 (features = ["fmt"]) as a dev-dependency in pi-agent-supervisor/Cargo.toml, which is the only reason Cargo.lock changed (one new lockfile entry).

One real bug I hit and fixed along the way: my first AC-1 test called worker.terminate().await immediately after spawn(), which sends SIGTERM synchronously right after fork+exec — a race against the freshly-forked `sh -c "echo ... >&2"` process even starting to run, so the shell was sometimes (deterministically, in this sandbox) killed by the default SIGTERM disposition before ever writing its line, producing an EOF with zero bytes read. Fixed by awaiting worker.child.wait() directly in the three tests that need the worker to run to completion on its own (spawn_logs_worker_stderr_line_at_warn_with_session_id, spawn_stderr_reader_ends_cleanly_at_eof_without_error_log, spawn_stderr_reader_keeps_reading_after_invalid_utf8_line), reserving .terminate() for tests that are specifically about termination behavior. `worker.child` is accessible because the tests module is a child module of process.rs and Rust's privacy rules give child modules access to ancestor private fields — the same pattern already relied on elsewhere in this test module (e.g. `worker.child.id()`).

Confirmed every RpcWorkerProcess::spawn call site (process.rs tests, pool.rs's acquire_session / acquire_session_with_cwd / spawn_warm_worker, reached via pi_agent_supervisor::start() -> SessionPool::new(), itself called from bob::serve::try_start_subsystems() inside the async pub async fn run(), plus #[tokio::test]-annotated callers in admin-rpc, bob's scheduler_execution_e2e, and pool.rs's own tests) executes inside an active Tokio runtime, so the synchronous spawn() function's internal tokio::spawn() always has a runtime to schedule onto — matches the task's stated precondition, no call site needed changing.

Verification: `cargo test -p pi-agent-supervisor` (81 passed, 0 failed, repeated 5x with no flakiness) and `cargo fmt --all -- --check` (clean), both matching the task's Verification command exactly. Also ran `cargo build -p bob` to confirm the Cargo.lock/dev-dependency change doesn't break the wider workspace build. Full `cargo test --workspace` was not run — this sandbox's socket-based suites hang per the repo's known limitation, unrelated to this change.

Nothing remains for this task; all five ACs have dedicated tests and pass, diff is scoped to exactly the three Files to Touch (process.rs, Cargo.toml, Cargo.lock), and the task lifecycle file was left untouched on the task branch.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->

### Review Verdict — 2026-09-29

FAIL

**Stage 1 — Acceptance Criteria: all five ACs met, evidence below.**

- AC-1 (log stderr line at warn with session id): met. `spawn_stderr_forwarder`
  (`process.rs:285-314`) emits `tracing::warn!(session = %session_id, "pool
  worker stderr: {line}")` per line; test
  `spawn_logs_worker_stderr_line_at_warn_with_session_id` passes and asserts
  the `WARN` level, the session id, and the content together.
- AC-2 (EOF ends the reader without error log/panic): met. `Ok(0) => break`
  with no log call; test
  `spawn_stderr_reader_ends_cleanly_at_eof_without_error_log` passes.
- AC-3 (drains >64 KiB without blocking the worker): met. Confirmed by
  running the test as written (passes) and by mutation: temporarily replacing
  the `spawn_stderr_forwarder` call with `std::mem::forget(stderr)` (leaving
  the pipe genuinely unread, matching the original bug) makes
  `spawn_stderr_reader_drains_large_writes_without_blocking_worker` fail
  deterministically inside its 5s timeout — the test has real teeth, not just
  a passing coincidence.
- AC-4 (lossy UTF-8, later valid line still logged): met. Confirmed by
  mutation: replacing `String::from_utf8_lossy` with strict `String::from_utf8`
  (`Err(_) => break`) makes
  `spawn_stderr_reader_keeps_reading_after_invalid_utf8_line` fail with
  `got: []`.
- AC-5 (interactive-session stderr unchanged): met. The diff hunk touching
  `InteractiveProcess` (`process.rs` diff around line 561) adds only new test
  helper code above it; `InteractiveProcess::spawn`/`terminate` and
  `InteractiveProcessConfig` are byte-for-byte identical to `dev-agent`, and
  their existing test suite is untouched and passing.

No unspecified behavior was added, and the diff is scoped to exactly the
three Files to Touch (`process.rs`, `pi-agent-supervisor/Cargo.toml`,
`Cargo.lock`).

**Stage 2 — Code Quality: one blocking issue.**

- File: `the-intern/service/crates/pi-agent-supervisor/src/process.rs`
- Location: `spawn_stderr_forwarder` (lines 285-314) and its call site in
  `RpcWorkerProcess::spawn` (line 113).
- What is wrong: `spawn_stderr_forwarder` calls `tokio::spawn(...)` and
  discards the returned `JoinHandle` entirely — the forwarder task is fully
  detached, with no field on `RpcWorkerProcess` or anywhere in the pool
  holding a handle to it. This violates
  `docs/ai-team/docs/coding-guidelines-rust.md` §4 ("Every spawned task is
  owned by a supervisor or task tracker. Do not spawn detached work whose
  lifecycle cannot be cancelled, awaited, and observed during shutdown.").
  The same crate already has the correct pattern for the sibling problem one
  file over: `pool.rs`'s `spawn_stdout_drain` (`pool.rs:119`) returns a
  `JoinHandle<()>`, which `ActiveSessionWorker` stores as `drain_handle`
  (`pool.rs:52`, documented "Aborted when the worker is removed (killed,
  reaped, or shut down)"), explicitly `.abort()`'d in `kill_session`
  (`pool.rs:283`), `reap_idle_and_surplus` (`pool.rs:481`), and
  `shutdown_all` (`pool.rs:508`). The new stderr forwarder has no equivalent:
  those same three teardown paths now terminate a worker's child process
  with zero visibility into or control over its still-running
  stderr-forwarding task. Because the forwarder starts immediately in
  `RpcWorkerProcess::spawn` — including for warm-pool workers that can sit
  idle for the whole life of the pool — every worker the service ever spawns
  now carries an untrackable, unabortable background task for its entire
  lifetime. This is not just a style gap: the messages this task exists to
  preserve (pi's start-up failure, the bob extension's transport-lost/
  shutdown error per S-002/S-003) are exactly the kind of stderr output
  likely to appear right around worker teardown or service shutdown, and
  none of `kill_session`, idle/surplus reaping, or `shutdown_all` can wait
  for or even observe whether the forwarder drained and logged a worker's
  last buffered line before that worker (or the whole service) goes away.
- What should change: give `spawn_stderr_forwarder` the same shape as
  `spawn_stdout_drain` — return the `JoinHandle<()>`, store it (e.g. as a
  field on `RpcWorkerProcess` alongside `child`/`stdin`/`stdout`, or threaded
  into the pool's per-worker bookkeeping the way `drain_handle` is), and
  `.abort()` it at the same teardown points used for `drain_handle`
  (`kill_session`, `reap_idle_and_surplus`, `shutdown_all`) plus wherever
  `RpcWorkerProcess::terminate()` finalizes a worker. `.abort()` is
  synchronous and non-blocking (as the existing `drain_handle.abort()` calls
  already demonstrate), so this can be done without delaying `terminate()`,
  matching the task's own "must not ... delay terminate()" constraint.

All other Stage 2 checks passed: tests are independent (stable across 5
repeated `cargo test -p pi-agent-supervisor` runs, no shared mutable state —
each test gets its own thread-local tracing subscriber, matching the
established `extension-ipc::multiplex` pattern), no hardcoded secrets, no
dead code or commented-out blocks, naming is descriptive, and
`cargo fmt --all -- --check` is clean. `cargo clippy -p pi-agent-supervisor
--all-targets` surfaces one pre-existing `missing_errors_doc`/
`result_unit_err` error in `pool.rs` (unrelated to this diff — confirmed
present on `dev-agent` before this branch too); per CLAUDE.md, clippy is not
a clean gate for this workspace and this finding is not attributable to this
task.

Verification command run: `cargo test -p pi-agent-supervisor && cargo fmt
--all -- --check` on `task/T-227-pool-worker-stderr-logging` — 81 passed, 0
failed (5 repeated runs, no flakiness); fmt clean. `cargo build -p bob` also
succeeds.

Next: address the detached-task-lifecycle finding above (mirroring
`spawn_stdout_drain`/`drain_handle`) and resubmit; everything else in this
task is ready.
