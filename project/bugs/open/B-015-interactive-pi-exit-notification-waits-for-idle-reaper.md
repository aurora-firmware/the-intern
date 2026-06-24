---
id: B-015
title: Interactive pi exit notification waits for idle reaper
severity: medium
status: open
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
