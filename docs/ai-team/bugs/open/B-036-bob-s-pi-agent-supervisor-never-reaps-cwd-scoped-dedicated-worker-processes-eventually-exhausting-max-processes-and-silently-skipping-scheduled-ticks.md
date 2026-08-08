---
id: B-036
title: bob's pi-agent-supervisor never reaps cwd-scoped dedicated worker 
  processes, eventually exhausting max_processes and silently skipping scheduled
  ticks
severity: high
status: open
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
- For PASS: brief confirmation that diagnosis, fix, verification, and code quality passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->
