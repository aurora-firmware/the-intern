---
id: B-017
title: periodic dispatcher kills pi worker immediately after prompt delivery ack
severity: high
status: open
created: '2026-07-04'
---

# periodic dispatcher kills pi worker immediately after prompt delivery ack

## Summary

The periodic dispatcher in `bob serve` terminates the pi-agent worker
immediately after `send_prompt` returns, but `send_prompt` returns as soon as
pi acknowledges *receipt* of the prompt over `runRpcMode()`
(`{"type":"response","success":true}`), not when the agent run completes. The
worker is therefore SIGTERM'd milliseconds into its run — before the first
provider call finishes and before any tool executes. Every scheduled job
(S-009) delivers its prompt and then silently does nothing, which defeats the
scheduler channel entirely.

## Reproduction Status

Status: confirmed

Confirmed from a live run on 2026-06-30 using the dev helper scripts. The
service log shows the scheduled session emitting `before_provider_request` at
14:47:00.852 and `session_shutdown` at 14:47:00.866 — the worker was shut
down 14 ms after the agent tried to contact the provider. The job's expected
side effect (a file write) never happened across repeated firings.

## Evidence

- Logs / stack traces / failing assertions: `pi-logs.log` (repo root,
  untracked) — session `577ef1bc` timeline: `session_start` → `input` →
  `agent_start` → `turn_start` → `message_start`/`message_end` → `context` →
  `before_provider_request` (14:47:00.852) → `session_shutdown`
  (14:47:00.866). No `after_provider_response`, no `tool_execution_*`, no
  `agent_end`.
- Audit log `.tmp/bob-dev/state/bob/audit.jsonl`: scheduled sessions show
  `session_start` events but the prompt's side effect never occurs.
- Failing command or test: schedule a job via
  `./scripts/bob-dev.sh schedule add --id t --cron "* * * * *" --prompt
  "write a line to /tmp/bob-test-out.md"` — the file is never created.
- Code: `the-intern/service/crates/bob/src/serve.rs:551-577`
  (`start_periodic_dispatcher`): `acquire_session()` → `send_prompt()` →
  unconditional `kill_session()`. `send_prompt`
  (`crates/pi-agent-supervisor/src/pool.rs:127-163`) returns on the RPC
  acceptance ack, not on run completion.
- The e2e test
  `periodic_event_is_dispatched_to_pi_agent_with_payload_as_prompt`
  (`serve.rs` tests) masks the bug: its fake worker performs its side effect
  synchronously inside the ack handler, so the immediate kill looks harmless.

## Reproduction Steps

1. Start the service with `./scripts/run-bob-dev.sh` (real `pi` on PATH).
2. Add a schedule entry whose prompt has an observable side effect, e.g.
   `./scripts/bob-dev.sh schedule add --id test-write --cron "* * * * *"
   --prompt "write the word hello to /tmp/bob-test-out.md"`.
3. Wait for at least one cron firing (watch `bob audit tail` or the serve
   log: a session starts each minute).
4. Observe `/tmp/bob-test-out.md` is never created, and the serve log shows
   `session_shutdown` within milliseconds of `before_provider_request`.

## Expected Behavior

A scheduled firing delivers the prompt to a pi worker and the worker stays
alive until the agent run completes (fire-and-forget per ADR-004 means no
*response* is routed back, not that the run may be aborted). The session is
then released — either after observed run completion or by the existing idle
reaper (`last_prompt_activity` + `idle_reap_timeout`).

## Actual Behavior

The dispatcher kills the session immediately after the prompt-acceptance ack.
The agent run is aborted mid-flight: the provider call never completes, no
tool call is ever attempted, and the scheduled job has no effect. No error is
surfaced anywhere — the audit trail shows a normal-looking `session_start` /
`session_shutdown` pair.

## Environment

- OS / platform: Linux (dev machine, single-user-local per ADR-008)
- Language / runtime version: Rust workspace `the-intern/service`; pi-agent
  binary on PATH (tested version recorded in `README.md`)
- Relevant dependencies: pi `runRpcMode()` prompt delivery
- Branch / commit: `dev-agent` @ 56787d1

## Related

- Task: T-094 (periodic dispatcher), S-009 scheduler adapter
- Specification: `project/specs/S-009-scheduler-channel-adapter-and-bob-schedule-cli.md`
  (workflow: "pi-agent receives request, executes prompt verbatim"),
  `project/specs/S-001-the-intern-agent-service-architecture.md`
- Decision: ADR-004 (`periodic` = fire-and-forget receipt semantics), ADR-006

## Suspected Area

`the-intern/service/crates/bob/src/serve.rs` — `start_periodic_dispatcher`
(the `kill_session` call after `send_prompt`); interaction with
`crates/pi-agent-supervisor/src/pool.rs::send_prompt` ack semantics and the
idle reaper.

## Fix Verification

```bash
# From the-intern/service/:
cargo test --workspace
cargo test -p bob --test scheduler_execution_e2e -- --nocapture
# Manual: schedule a job with an observable side effect via scripts/bob-dev.sh
# and confirm the side-effect file appears after the next cron firing, and the
# serve log shows the run completing (agent_end) before session teardown.
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
