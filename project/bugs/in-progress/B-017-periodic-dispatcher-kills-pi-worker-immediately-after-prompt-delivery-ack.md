---
id: B-017
title: periodic dispatcher kills pi worker immediately after prompt delivery ack
severity: high
status: in-progress
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

### Diagnosis 1 — 2026-07-04

Reproduction status: Confirmed. Independently re-verified against the repo-root
artifact `pi-logs.log` (untracked, session
`577ef1bc-e5de-497b-b4f0-f42f6b9443ac`, captured from a live `bob serve` + real
`pi` run on 2026-06-30) plus static source analysis of the current
`bug/B-017-...` branch (identical to `dev-agent` @ `0144821`, no drift). A fresh
live re-run was not performed this session; the captured log plus source-path
analysis together confirm the fault deterministically — it is a structural
code-path defect, not a timing-dependent flake.

Evidence captured:
- `pi-logs.log` timeline for session `577ef1bc`:
  - `14:47:00.120662Z` — `pi-agent-supervisor send prompt command received`
  - `14:47:00.839199Z` — extension event `agent_start`
  - `14:47:00.839468Z` — `pi-agent-supervisor kill session command received`
    (dispatcher's `kill_session` invoked here)
  - `14:47:00.839768Z` — extension event `turn_start` (fires *after* the kill
    command was issued)
  - `14:47:00.852065Z` — extension event `before_provider_request` (12.6 ms
    after the kill command)
  - `14:47:00.866436Z` — extension event `session_shutdown` (14.4 ms after
    `before_provider_request`)
  - `grep -c` for `after_provider_response`, `tool_execution_start`,
    `tool_execution_end`, `agent_end` = 0. The run never got a provider response
    and never executed a tool. The kill command was sent *before* the provider
    request even began — it is unconditional and immediate, not a reaction to
    run completion.
- `serve.rs:551-577` (`start_periodic_dispatcher`, `Ok(Some(event))` arm):
  confirmed `acquire_session()` → `send_prompt()` → unconditional
  `kill_session()`; each step's error is only `tracing::warn!`-logged and never
  used to skip the kill.
- `pi-agent-supervisor/src/pool.rs:127-163` (`send_prompt`): returns `Ok(())`
  as soon as `rpc::parse_prompt_response` yields `Some(true)`.
- `pi-agent-supervisor/src/rpc.rs:31-55` (`parse_prompt_response`): matches
  purely on `{"id": <matching>, "type": "response", "success": true}` — the RPC
  *acceptance* ack, with no notion of run completion.
- `pool.rs:106-125` (`kill_session`) + `process.rs:160-189` (`terminate`):
  `kill_session` unconditionally removes and terminates the worker (SIGTERM then
  force-kill after `child_termination_deadline`), regardless of run state.
- `cargo test -p bob periodic_event_is_dispatched_to_pi_agent_with_payload_as_prompt -- --nocapture`
  → 1 passed. The fake worker script (`serve.rs:1442-1450`) writes the record
  file and emits the `{"success":true}` ack from the *same* shell loop
  iteration, so the observable side effect happens synchronously with the ack
  the dispatcher waits on — the test cannot detect a kill that happens after the
  ack, confirming the masking claim.

Isolated fault: `crates/bob/src/serve.rs`, `start_periodic_dispatcher`,
lines 551-577 — the unconditional `supervisor.kill_session(session_id).await`
immediately following `supervisor.send_prompt(...)`, with no wait for or
observation of agent-run completion before tearing the worker down.

Root cause or fault hypothesis: The dispatcher conflates "prompt was accepted by
the RPC channel" (`send_prompt`'s return, driven by the
`{"type":"response","success":true}` ack) with "the agent run is finished."
These are different events in pi's `runRpcMode()` protocol: the ack only
confirms receipt of the prompt command; the actual agent turn (provider calls,
tool execution, `agent_end`) proceeds asynchronously afterward. `kill_session`
SIGTERMs the worker as soon as the ack arrives, aborting the run before the
first provider call completes. This is a logic error (missing run-completion
condition) in `start_periodic_dispatcher`, not an environment or timing issue.
The existing e2e test does not catch it because its fake worker performs the
side effect synchronously inside the ack-handling loop iteration, unlike a real
pi worker where the side effect happens after the ack during the (currently
aborted) run.

Planned verification: `cargo test --workspace`;
`cargo test -p bob --test scheduler_execution_e2e -- --nocapture`; a new/updated
e2e test whose fake worker defers its side effect until *after* sending the ack
(simulating real pi timing) to prove the session is not torn down before the
deferred side effect completes; manual check per the bug's Fix Verification
(schedule a job with an observable side effect via `scripts/bob-dev.sh`, confirm
the side-effect file appears and the serve log shows the run completing before
session teardown).

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
