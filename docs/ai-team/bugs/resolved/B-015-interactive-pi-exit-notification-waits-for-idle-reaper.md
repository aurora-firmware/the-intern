---
id: B-015
title: Interactive pi exit notification waits for idle reaper
severity: medium
status: resolved
created: '2026-06-24'
task: T-105
---

# Interactive pi exit notification waits for idle reaper

## Summary

Natural interactive pi exits are detected only by the supervisor's general idle
reaper tick. Its production interval is five minutes, so `bob chat` can remain
blocked for up to five minutes after the user exits pi instead of receiving
`session.interactive.exited` promptly.

## Reproduction Status

Status: confirmed

Confirmed deterministically by tracing the watcher and timer paths on
`dev-agent` at commit `1ae86bce90bf9ea718414b538eb12e8350fb3d0f`.

## Evidence

- `pi-agent-supervisor/src/lib.rs` creates `reap_tick` from
  `cfg.idle_reap_timeout`, whose default is 300 seconds.
- `SessionPool::poll_interactive_exits()` is called only from that tick.
- The admin-RPC exit-notification test sets `idle_reap_timeout` to 50 ms, so it
  does not cover production timing.

## Reproduction Steps

1. Start the supervisor with the production 300-second idle reap timeout.
2. Start and watch an interactive child that exits naturally.
3. Wait for the exit watcher notification.

## Expected Behavior

The watcher fires promptly after the child exits, independently of the idle RPC
worker reap schedule.

## Actual Behavior

The watcher is not polled again until the next idle reaper tick, which can be up
to 300 seconds later.

## Environment

- OS / platform: Linux
- Language / runtime version: Rust workspace toolchain managed by mise
- Relevant dependencies: Tokio process and timer APIs
- Branch / commit: `dev-agent` / `1ae86bce90bf9ea718414b538eb12e8350fb3d0f`

## Related

- Task: `T-105`
- Change request: `CR-002-bob-chat-launches-an-interactive-pi-session.md`
- Decision: `ADR-011-interactive-chat-brokers-the-client-terminal-to-pi-via-scm-rights-fd-passing.md`

## Suspected Area

`the-intern/service/crates/pi-agent-supervisor/src/lib.rs`, where interactive
exit polling is coupled to idle worker reaping.

## Fix Verification

```bash
cd the-intern/service
cargo test -p pi-agent-supervisor
cargo test -p admin-rpc
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

### Diagnosis 1 — 2026-06-24

Reproduction status: Confirmed deterministically by code-path inspection on
`dev-agent` commit `6452d4b`. A watched child can make no notification progress
between idle reaper ticks.

Evidence captured: `pi-agent-supervisor/src/lib.rs:246-248` constructs the only
timer from `cfg.idle_reap_timeout`; its production default is 300 seconds.
Lines 360-364 call `poll_interactive_exits()` only from that timer branch.
`register_interactive_exit_watcher` merely stores the sender, while the
admin-RPC test helper reduces the idle timeout to 50 ms and therefore masks the
production delay.

Isolated fault: `Actor::run` couples non-blocking interactive child exit polling
to the unrelated RPC-worker idle reaping schedule.

Root cause or fault hypothesis: T-105 retained the interactive process in the
pool so client disconnect can still terminate it, then reused the existing reap
tick as a convenient poll trigger without accounting for its five-minute
production cadence.

Planned fix: Add a dedicated 50 ms interactive-exit polling interval in
`Actor::run`. Its select branch will only call `poll_interactive_exits`; the
existing idle timer remains responsible for RPC worker reaping. Preserve the
pool ownership and watcher semantics.

Planned verification: Add an actor-level regression test with a 60-second idle
reap timeout and a naturally exiting interactive child, first confirming its
watch receiver times out on current code, then confirming prompt delivery after
the dedicated timer is added. Run `cargo test -p pi-agent-supervisor`,
`cargo test -p admin-rpc`, and `cargo fmt --all -- --check` from
`the-intern/service`.

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

### Session 1 — 2026-06-24

Implemented the diagnosis contract on
`bug/B-015-interactive-pi-exit-notification-waits-for-idle-reaper`. Added the
actor-level regression test
`interactive_exit_watcher_is_not_delayed_by_idle_reap_timeout`, which consumes
the idle timer's immediate tick, starts a naturally exiting interactive child
with a 60-second idle timeout, and requires notification within two seconds.
Before implementation it failed after timing out at the original 500 ms red
deadline, directly reproducing the coupling.

Added a dedicated 50 ms interactive-exit interval in `Actor::run`; it only
polls registered interactive children, while the existing idle timer remains
responsible for RPC worker reaping. The process stays in the pool, preserving
client-disconnect termination. Updated stale watcher documentation to describe
the retained-process polling model.

Verification passed: 50/50 `pi-agent-supervisor` tests, 99/99 `admin-rpc`
tests, the focused regression test after widening its CI margin to two seconds,
and `cargo fmt --all -- --check`. Implementation commit: `31e0863`.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that diagnosis, fix, verification, and code quality passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->

### Review Verdict — 2026-06-24

PASS

Stage 1 passed: the Diagnosis Log is complete, the dedicated timer directly
decouples interactive exit notification from idle worker reaping, and the
regression test reproduces production-like idle timing. Both Fix Verification
suites passed and the branch changes only the supervisor implementation and its
direct documentation.

Stage 2 passed: child ownership remains in `SessionPool`, so existing
`kill_session` and shutdown behavior is preserved. The 50 ms non-blocking poll
is bounded by the number of registered watchers, uses delayed missed-tick
behavior, and introduces no resource or security regression. The test has a
40x scheduling margin relative to the poll interval and failed before the fix.
