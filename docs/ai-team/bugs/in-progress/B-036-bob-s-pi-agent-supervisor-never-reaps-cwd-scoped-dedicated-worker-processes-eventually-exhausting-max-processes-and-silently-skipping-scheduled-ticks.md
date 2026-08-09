---
id: B-036
title: bob's pi-agent-supervisor never reaps cwd-scoped dedicated worker 
  processes, eventually exhausting max_processes and silently skipping scheduled
  ticks
severity: high
status: in-progress
created: '2026-08-08'
---

# bob's pi-agent-supervisor never reaps cwd-scoped dedicated worker processes, eventually exhausting max_processes and silently skipping scheduled ticks

## Summary

Discovered live during `B-030`/`B-031`'s combined live-validation session
(2026-08-08). A `bob schedule add ... --cron "* * * * *" --cwd <workspace>`
job firing once per minute accumulates one live `pi` child process per tick
under `pi_agent_supervisor` — confirmed via `pstree`/`ps` against the real
`bob serve` process — and none of them are ever reclaimed as idle/warm or
reaped, even long past the configured `idle_reap_timeout` (300s default) and
even for ticks whose sessions completed their work successfully (wrote a
worklog entry, sent a real email). After exactly 8 ticks (`max_processes`
default), the scheduler starts skipping every subsequent fire with `bob
serve`'s own logged warning: `"cannot acquire cwd-scoped session because
active + warm workers reached max_processes (8)"`. This makes any
long-running scheduled job (the documented `*/15 * * * *` cadence for
`email-triage`, or any tighter cadence) eventually stop firing entirely
after enough ticks, silently, with no error surfaced anywhere except a
`WARN`-level service log line — the mailbox simply stops being checked.

## Reproduction Status

Status: confirmed

## Evidence

- Logs / stack traces / failing assertions:
  - `ps --ppid <bob-pid> -o pid,stat,etimes,cmd` after ~23 minutes of a
    `* * * * *` schedule against one `--cwd` showed 8 live `pi` processes,
    ages 270s through 1440s, all in state `Sl` (sleeping,
    multi-threaded) with `wchan=do_epoll_wait` (idle event loop, not
    actively computing) — none exited, none reaped, despite the oldest
    being ~4.8x past the configured 300s `idle_reap_timeout`.
  - `bob serve`'s own log, once the 8th slot filled:
    `WARN bob::serve: crates/bob/src/serve.rs:883: periodic dispatcher: cwd-scoped
    session acquisition failed; skipping this fire error=child process error:
    cannot acquire cwd-scoped session because active + warm workers reached
    max_processes (8) job_id="check-email" cwd=<workspace>` — repeated on
    every subsequent minute tick indefinitely, with no recovery, until the
    service was manually restarted.
  - Confirmed this is not merely a symptom of `B-035`'s confused,
    non-terminating sessions: after fixing `B-035`'s project-trust gap and
    restarting `bob` with a clean process tree, a second run whose sessions
    completed normally (loaded skills, classified both synthetic messages
    correctly, sent one live escalation email, wrote correct worklog
    entries) still accumulated one un-reaped `pi` process per tick — 7
    processes after ~6.5 minutes of `* * * * *` firings, ages 41s–393s, same
    `do_epoll_wait` idle state, same failure to reap despite several already
    exceeding the 300s configured timeout.
  - `SIGTERM` and `SIGKILL` sent directly to the stuck child PIDs did
    terminate them at the OS level (they transitioned to `Z`/`<defunct>`
    zombie state within ~2s), but `bob` itself never reaped the zombies
    (no new log activity, no pool-slot reclamation) until the whole `bob
    serve` process was itself restarted — indicating `bob`'s supervisor is
    not watching for child exit/`SIGCHLD` on these workers at all, not just
    failing to proactively terminate idle ones.
  - `bob`'s own graceful-shutdown path (`SIGTERM` to `bob serve` itself)
    *does* correctly reap all outstanding children within its 10s reap
    deadline (confirmed via clean `"shutdown: pi-agent children reaped"`
    log line and an empty process list immediately after) — the defect is
    specific to the supervisor's *live*, in-process worker-pool bookkeeping
    for cwd-scoped dedicated workers, not to process reaping in general.
- Failing command or test: register a `bob schedule add --cron "* * * * *"
  ... --cwd <any-workspace>` job and observe `ps --ppid <bob-pid>` grow by
  one `pi` process per tick without bound, or watch `bob serve`'s log for
  the `"cannot acquire cwd-scoped session ... max_processes"` warning after
  `max_processes` ticks.

## Reproduction Steps

1. Start an isolated `bob serve` instance with default
   `pi_agent_supervisor` settings (`max_processes=8`,
   `idle_reap_timeout=300s`, confirmed via its own startup log line).
2. Register `bob schedule add --id t --cron "* * * * *" --prompt "..."
   --cwd <any-existing-directory>`.
3. Let 8+ minutes pass (8+ ticks).
4. Run `ps --ppid <bob-pid> -o pid,stat,etimes,cmd`: observe 8 accumulated
   `pi` child processes, none exited, ages exceeding `idle_reap_timeout`.
5. Check `bob serve`'s log after the 9th tick: observe the `"cannot acquire
   cwd-scoped session ... max_processes (8)"` warning, and confirm no
   further worklog/audit activity occurs for that job from that point
   onward without a service restart.

## Expected Behavior

Per the documented `idle_reap_timeout` (300s default,
`the-intern/docs/src/operator-guide/index.md`'s references to
`pi_agent_idle_reap_timeout`), a cwd-scoped dedicated worker that has
finished its tick's work and gone idle should either be returned to a
reusable warm-pool slot or reaped once its idle time exceeds the configured
timeout, so `max_processes` bounds *concurrently active* work, not the
*cumulative total* of every tick ever fired over the job's lifetime.

## Actual Behavior

Every scheduled-job tick against a given `--cwd` appears to permanently
consume one `max_processes` slot for the lifetime of the `bob serve`
process, regardless of `idle_reap_timeout` and regardless of whether the
tick's session completed successfully. Once `max_processes` cwd-scoped
workers have accumulated, every subsequent tick for every scheduled job is
silently skipped (`WARN`-level log line only) until the service is
restarted.

## Environment

- OS / platform: Linux (this dev environment)
- Language / runtime version: Rust (workspace default toolchain)
- Relevant dependencies: `the-intern/service/crates/pi-agent-supervisor`
  (`max_processes`, `idle_reap_timeout`, cwd-scoped dedicated worker
  acquisition), `the-intern/service/crates/bob/src/serve.rs` (periodic
  dispatcher's `"cannot acquire cwd-scoped session"` warning)
- Branch / commit: `dev-agent`; discovered during `B-030`/`B-031`'s combined
  live-validation session, 2026-08-08

## Related

- Bug: `B-030`, `B-031` (both live-validated with a `* * * * *` cadence
  during the same session that surfaced this; not blocked by it within the
  session's own short duration, but this would silently stop any longer-
  running deployment), `B-035` (this bug was first noticed while
  investigating `B-035`'s confused, non-terminating sessions, but was
  independently reproduced afterward against sessions that completed
  normally — the two are separate defects)
- Specification: n/a — this is a `bob` service-layer scheduling/process-pool
  defect, not an `email-skills` package defect

## Suspected Area

`the-intern/service/crates/pi-agent-supervisor/src/lib.rs` (cwd-scoped
dedicated worker lifecycle: acquisition, idle/warm-pool return, and
`idle_reap_timeout` enforcement for workers associated with a scheduled
job's `--cwd`, as distinct from the general warm pool) and
`the-intern/service/crates/bob/src/serve.rs`'s periodic dispatcher (the
`"cannot acquire cwd-scoped session"` warning path, `serve.rs:883`).

## Fix Verification

```bash
# Once a fix is implemented, run a bob instance with max_processes set low
# (e.g. 2) and a "* * * * *" schedule for longer than max_processes minutes;
# confirm via `ps --ppid <bob-pid>` that the live child-process count stays
# bounded (workers are reaped or reused, not accumulated), and confirm no
# "cannot acquire cwd-scoped session ... max_processes" warning appears.
cargo test -p pi-agent-supervisor
```

## Diagnosis Log

<!-- Mandatory before implementation. Append one entry before changing production code. Format:
### Diagnosis N — YYYY-MM-DD
Reproduction status:
Evidence captured:
Isolated fault:
Root cause or fault hypothesis:
Planned verification:
-->

### Diagnosis 1 — 2026-08-09
Reproduction status:
- Confirmed. The original live `bob serve` evidence demonstrates the leak, and a fresh local `pi --mode rpc --offline` reproduction confirmed that prompt handling can finish while the persistent child remains alive with stdout open.

Evidence captured:
- Before `bb92585`, `refresh_drain_state()` cleared the drain only on EOF/error, `is_periodic_run_in_flight()` was true while that drain existed, and idle reaping excluded in-flight workers.
- The local RPC repro (`pi 0.65.2`) observed an accepted prompt followed by a still-alive child and a timed-out post-run stdout read; EOF is therefore not a per-run completion signal.
- The existing branch commit adds terminal-record observation and a regression test where stdout never reaches EOF.

Isolated fault:
- `the-intern/service/crates/pi-agent-supervisor/src/pool.rs`: the drain-state refresh, periodic-run-in-flight predicate, stdout drain, and idle reaper modelled worker-process EOF as completion of one periodic run.

Root cause or fault hypothesis:
- `pi --mode rpc` workers persist between prompts. Since their stdout drain remains active until process exit, the old bookkeeping permanently classified completed cwd-scoped periodic runs as in-flight and excluded them from idle reaping, exhausting `max_processes` one tick at a time.

Planned verification:
- Test a persistent worker that emits `agent_end` then keeps stdout open; it must be reaped after `idle_reap_timeout`. Run `cargo test -p pi-agent-supervisor`, then manually verify a low-limit scheduled `--cwd` job stays bounded beyond `max_processes` ticks without acquisition warnings.

Obstacles encountered:
- The isolated local environment could not execute a full successful online pi run, so the fresh repro validates the no-EOF premise; the canonical live evidence covers the end-to-end scheduling symptom.

### Diagnosis 1 — 2026-08-09

Reproduction status: confirmed (both live end-to-end, matching the bug's own
evidence, and via a direct, isolated real-`pi` protocol reproduction below).

Evidence captured:
- Read `the-intern/service/crates/pi-agent-supervisor/src/pool.rs`,
  `reaper.rs`, `lib.rs`, `process.rs`, and the periodic-dispatch call site in
  `the-intern/service/crates/bob/src/serve.rs:919-969` (start_periodic_dispatcher).
- Direct reproduction against the real `pi` binary (0.80.3, on PATH), driven
  interactively over its own stdin/stdout via a bash coprocess (script
  captured, no repo files touched):
    coproc PI { timeout 30 pi --mode rpc --offline --no-approve; }
    echo '{"id":"prompt-1","type":"prompt","message":"say hi"}' >&"${PI[1]}"
  Observed the full RPC record stream through to completion
  (`response` -> `agent_start` -> `turn_start` -> `message_start/update/end`
  -> `turn_end` -> `agent_end`), then, after the run's own completion
  markers (`turn_end`/`agent_end`) were emitted:
    - `kill -0 $PI_PID` -> process still alive (`PI_STILL_ALIVE`).
    - A further `read -t 3 -u "${PI[0]}"` on the child's stdout **timed out**
      (rc=142, i.e. blocked waiting for data) rather than returning EOF —
      i.e. the real `pi --mode rpc` worker does NOT close/EOF its stdout
      when an individual prompt's run finishes; it stays resident, ready for
      the next RPC command, and only closes stdout when the whole process
      exits.
  No stray `pi` processes were left running afterward (verified with
  `pgrep -af "pi --mode rpc"`).
- `cargo test -p pi-agent-supervisor` (64 tests) — all pass on current
  `dev-agent` code. None of these tests exercise a worker process that
  survives past the end of a fire-and-forget periodic run (every test child
  is a synthetic `sh` script engineered to `exit 0` and thus close its own
  stdout), so the existing suite structurally cannot catch this defect —
  consistent with the bug being discovered only during B-030/B-031's
  extended live-validation session rather than by unit tests.
- `the-intern/service/crates/bob/tests/scheduler_execution_e2e.rs` (header
  comment, line 3) explicitly documents it uses a "fake sh worker", not real
  `pi`, for the same reason — the e2e suite doesn't cover this path either.

Isolated fault:
`the-intern/service/crates/pi-agent-supervisor/src/pool.rs`:
- `ActiveSessionWorker::is_periodic_run_in_flight()` (lines 46-48) returns
  `true` whenever `drain_handle: Option<JoinHandle<()>>` is `Some`.
- `refresh_drain_state()` (lines 35-44) only clears `drain_handle` to `None`
  once the background task spawned by `spawn_stdout_drain()` (lines 51-83)
  finishes — i.e. once `stdout.read_line()` returns `Ok(0)` (EOF) or an
  error. That task's doc comment (lines 51-58) and the design note in
  `serve.rs` (lines 931-934) both assume "the run completes" and "EOF" are
  the same event.
- `reap_idle_and_surplus()` (lines 391-415) filters any worker with
  `is_periodic_run_in_flight() == true` out of the idle-reap candidate set
  entirely (line 402: `.filter(|(_, worker)| !worker.is_periodic_run_in_flight())`),
  so such a worker can never appear in `stale_sessions` regardless of how
  long `now - last_prompt_activity` grows.

Root cause or fault hypothesis:
`send_prompt_and_drain` (used exclusively by the periodic dispatcher for
every `--cwd`-scoped scheduled fire, `serve.rs:939-941`) hands the worker's
stdout to `spawn_stdout_drain`, whose only completion signal is physical EOF
on that pipe. As directly confirmed against the real `pi` binary above, a
`pi --mode rpc` worker does not exit or close stdout when one prompt's run
finishes — it remains alive, listening for the next RPC command on stdin,
exactly as required for warm/active workers to be reused across multiple
sequential `send_prompt` calls elsewhere in this same pool. Consequently,
once a cwd-scoped dedicated worker has ever run one periodic prompt via
`send_prompt_and_drain`, its `drain_handle` is permanently `Some` (the
drain task is permanently blocked in `read_line`), so
`is_periodic_run_in_flight()` is permanently `true`, so the worker is
permanently excluded from `reap_idle_and_surplus`'s candidate set — it can
never be idle-reaped for as long as the process is alive, i.e. forever
(nothing else in the codebase kills it). This exactly reproduces every
symptom in the bug report:
- One dedicated worker leaked per `--cwd` tick (intentional per T-122's
  "always spawns a dedicated worker" design), none ever reclaimed —
  unbounded accumulation until `max_processes` is exhausted, then every
  subsequent fire is skipped with exactly the observed
  `"cannot acquire cwd-scoped session ... max_processes"` warning
  (`serve.rs:883-888`).
- Sessions that "completed their work successfully" are still never reaped
  — completion of the agent run (visible in the stream as `turn_end`/
  `agent_end`) is not the same event as EOF, so success/failure of the run
  is irrelevant to this defect.
- `bob serve`'s own graceful shutdown *does* reap everything cleanly,
  because `shutdown_all()` (pool.rs:431-481) unconditionally drains and
  terminates every entry in `active_workers` — it never consults
  `is_periodic_run_in_flight()` — matching the bug's explicit callout that
  the defect is specific to the *live* idle-reap bookkeeping, not to
  process reaping in general.
- Externally `SIGKILL`ing a stuck worker still doesn't free its pool slot
  promptly: killing the process does make the drain task observe EOF and
  clear `drain_handle`, but that clearing only happens the next time
  `reap_idle_and_surplus` runs (every `idle_reap_timeout`, i.e. up to 300s
  later by default), and `refresh_drain_state()` resets
  `last_prompt_activity` to that moment — so the slot isn't reclaimed until
  a further full `idle_reap_timeout` elapses after that. This is consistent
  with, and secondary to, the primary fault above.

Planned fix (target for the tdd cycle; to be finalized during
implementation):
Stop using "stdout drain task has reached physical EOF" as the sole gate on
idle-reap eligibility for periodic/drained workers, since that event does
not occur until the whole `pi` process exits. Instead, track genuine
in-flight-run activity independently of process-level EOF — e.g. have the
background drain task update a shared last-activity timestamp on every
drained record it reads (not only at EOF), and change
`reap_idle_and_surplus` to compare `now - <last drained-record activity>`
(falling back to `last_prompt_activity` when no records have streamed yet)
against `idle_reap_timeout` for these workers too, rather than
unconditionally excluding any worker whose drain task hasn't technically
finished. The drain task itself keeps running (and is still aborted, as
today, by `kill_session`/reap-removal/shutdown) so the child's stdout pipe
never fills; only the *eligibility test* changes. This preserves the
existing "don't reap a run that's still actively streaming" protection
(AC in the existing `send_prompt_and_drain_keeps_an_in_flight_run_alive_...`
test) while allowing genuinely idle dedicated workers to be reclaimed once
no further stdout activity has been observed for `idle_reap_timeout`. Scope
is limited to `pi-agent-supervisor/src/pool.rs` (`ActiveSessionWorker`,
`spawn_stdout_drain`, `reap_idle_and_surplus`) — no change is needed to
`acquire_session_with_cwd`'s "always spawn a fresh dedicated worker"
behavior, which is intentional per T-122, nor to `serve.rs`.

Planned verification:
- New unit test in `pi-agent-supervisor` (pool.rs or lib.rs) using a
  synthetic worker script that, after completing a fire-and-forget prompt
  (emitting a `response` record), stays alive and keeps stdout open
  (mirrors real `pi --mode rpc` behavior confirmed above) rather than
  exiting — asserting that once `idle_reap_timeout` elapses past the run's
  last observed activity, `reap_idle_and_surplus` (or the actor's reap
  tick / `list_sessions()`) does reclaim the session. This test must fail
  against the current code (red) before the fix, and pass after.
- `cargo test -p pi-agent-supervisor` (full crate suite) green.
- Manual live check per the bug's own Fix Verification block: run `bob
  serve` with `max_processes` set low (e.g. 2) and a `* * * * *` `--cwd`
  schedule for longer than `max_processes` minutes; confirm via
  `ps --ppid <bob-pid>` that the live child-process count stays bounded
  and no `"cannot acquire cwd-scoped session ... max_processes"` warning
  appears.

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

### Session 1 — 2026-08-09

Read the TDD workflow, Rust guidance, and Diagnosis 1 before validating the existing candidate commit `bb92585`. The fix changes periodic-run completion from the detached stdout drain reaching EOF to observing the terminal `agent_end` RPC record. It keeps the worker protected while work is active and restarts its idle timer only once the terminal record arrives, so an otherwise persistent RPC worker is subsequently eligible for idle reaping.

The included regression test models the fault directly: it acknowledges a prompt, emits `agent_end`, then keeps stdout open forever, and asserts the session is reaped after the configured idle timeout. No further source edits were needed; process reuse and shutdown behavior were inspected but did not contribute to this stale in-flight-state defect.

Verification passed: the focused regression test passed (`1 passed; 0 failed`), followed by `cargo test -p pi-agent-supervisor` (`65 passed; 0 failed`). Remaining implementation work: none.

Obstacles Encountered: None. An unrelated untracked `pr-42-review.md` was left untouched.

### Session 1 — 2026-08-09

Implemented the fix for B-036 following the Diagnosis Log's fix contract (isolated fault: `ActiveSessionWorker::is_periodic_run_in_flight()` in `the-intern/service/crates/pi-agent-supervisor/src/pool.rs`, treating "drain task hasn't hit physical EOF" as "run still active").

Before writing any test, I re-derived the exact implementation shape rather than applying the Diagnosis's literal wording ("update last-activity on every drained record") verbatim, because a literal reading would have broken the existing regression test `send_prompt_and_drain_keeps_an_in_flight_run_alive_past_idle_reap_timeout` — that test proves a periodic run must stay protected through a long *silent* period (no stdout activity at all) shorter than the run's own duration but longer than `idle_reap_timeout`. Pure "time since last activity" can't distinguish "silently still computing" from "genuinely finished and idle forever" — the exact ambiguity that caused the original bug. Instead I used the Diagnosis's own live-repro evidence (the real `pi --mode rpc` protocol's documented terminal record `agent_end`, emitted after `agent_start`/`turn_start`/`message_*`/`turn_end`) as an explicit semantic completion signal: the background stdout drain task now inspects each drained line for `"type":"agent_end"` and flips a shared `Arc<AtomicBool>` the first time it sees one. `ActiveSessionWorker::refresh_drain_state()` consumes that flag exactly once per run, at which point it resets `last_prompt_activity` to "now" and the worker leaves the "in-flight" state — `reap_idle_and_surplus()` then applies the normal `idle_reap_timeout` math to it like any other worker, using the existing filter/select machinery unchanged. Physical EOF (the child actually exiting) is still handled as a second, independent completion path for non-`pi` test doubles that do exit.

TDD cycle: added `send_prompt_and_drain_reaps_worker_once_idle_after_terminal_record_even_though_stdout_never_reaches_eof` in `lib.rs`, using a synthetic `sh` worker that ACKs the prompt, emits one `agent_end` record, then blocks forever on a further read without exiting or closing stdout (mirroring the real `pi` behaviour confirmed in the Diagnosis Log's direct repro). Verified it failed against the pre-fix code (worker never reaped, session still listed). Implemented the fix in `pool.rs` (new `TERMINAL_RUN_RECORD_TYPE`/`is_terminal_run_record`, extended `ActiveSessionWorker` with `drain_run_terminal_seen`/`drain_run_idle`, updated `refresh_drain_state`, `is_periodic_run_in_flight`, `spawn_stdout_drain`, `send_prompt_and_drain`, `track_active_worker`). Verified green: all 65 `pi-agent-supervisor` tests pass, including both pre-existing `send_prompt_and_drain_*` regression tests (streaming-doesn't-block, in-flight-survives-idle-timeout) and the new one. Ran `cargo fmt --all -- --check` (clean after `cargo fmt` auto-fixed one line-length wrap) and `cargo test --workspace` (all crates and e2e binaries — `scheduler_execution_e2e`, `shell_e2e`, `queue_load`, `session_state_roundtrip`, `non_serve` — green, no failures). Ran `cargo clippy -p pi-agent-supervisor --all-targets`; fixed one `doc_lazy_continuation` error my own new doc comment introduced (moved a trailing sentence into its own paragraph); the one remaining `error:` (`result_unit_err` on `register_interactive_exit_watcher`) and the pedantic-tier warnings are pre-existing debt untouched by this change, consistent with `CLAUDE.md`'s note that clippy is not yet a clean gate for this workspace.

Not done this session: the bug's own manual live-check ("run `bob serve` with `max_processes` set low and a `* * * * *` `--cwd` schedule for longer than `max_processes` minutes; confirm via `ps --ppid <bob-pid>` the process count stays bounded") was not run — it requires several minutes of wall-clock time against a live `bob serve` + real `pi` process tree, which didn't fit this session's scope. The automated regression test reproduces the diagnosed defect at the unit level using the same real-`pi` RPC record sequence the Diagnosis Log captured directly against the binary. Obstacles encountered: the Diagnosis Log's literal "planned fix" wording would have broken the existing silent-in-flight-protection regression test, resolved by keying off the real protocol's semantic `agent_end` terminal record instead of raw elapsed-time-since-last-record; `cargo fmt`/`cargo clippy` surfaced and I fixed two small style issues (a line-wrap and a doc-comment list-continuation lint), no functional impact; an untracked `pr-42-review.md` at repo root predates this session and is unrelated, left untouched.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that diagnosis, fix, verification, and code quality passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->
