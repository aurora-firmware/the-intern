---
id: T-112
title: Document scheduled execution policy and cron semantics
status: completed
priority: medium
assigned-role: developer
created: '2026-06-27'
spec: S-009
---

# Document scheduled execution policy and cron semantics

## Description

After T-109 and T-111, the operator guide needs to match the shipped scheduler
behavior. It currently explains how to add/list/remove jobs, but it does not
make the full execution path, policy-admission requirement, local-time cron
semantics, or observability limits clear enough for operators.

Update the scheduled-jobs documentation so an operator can add a job, admit its
deterministic scheduler `UserId`, understand that cron is evaluated in local
time, and know what can be observed through logs and audit records. Keep the
no-job-history and fire-and-forget semantics from S-009/ADR-006.

## Acceptance Criteria

AC-1: The operator guide shall state that scheduled jobs run through
      pre-flight policy admission before pi-agent receives the prompt.

AC-2: The operator guide shall explain how to obtain the scheduler-derived
      `UserId` from the `scheduler-adapter job registered` service log and add
      it to `[policy].admitted_users`.

AC-3: The operator guide shall state that five-field cron expressions are
      evaluated in the host's local wall-clock time.

AC-4: The operator guide shall describe the current observability surface:
      service logs, policy verdict audit records, extension events, and no
      dedicated schedule run-history store.

AC-5: The mdBook user documentation shall build successfully.

## Dependencies

- `T-109` — scheduled prompts must actually dispatch to pi-agent.
- `T-111` — cron expressions must use local wall-clock time.

## Files to Touch

- `the-intern/docs/src/operator-guide/index.md` — update the scheduled-jobs
  and policy guidance.

## Verification

```bash
cd the-intern/docs
mdbook build
```

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

### Session 1 — 2026-06-27

Read the task file (empty work log, first session), then read all referenced source before touching prose: `scheduler-adapter/src/lib.rs` for the exact log line and identity-derivation logic (`UserId::from_name(&entry.id)`, the `info!` macro in `spawn_job_tasks` with message "scheduler-adapter job registered — fixed channel/user IDs for policy rules" and fields `job_id`, `user_id`, `channel_id`, `cron`); `serve.rs` for `start_periodic_dispatcher` (admitted periodic events are drained from persistence, a pi-agent session is acquired, and the prompt is sent verbatim — fire-and-forget, per-event failures are logged as warnings and skipped); S-009 and ADR-006 for the fire-and-forget and no-run-history-store mandates.

Updated `the-intern/docs/src/operator-guide/index.md` with three additions to the existing Scheduled jobs section:

1. A local-time note appended to the "Cron expression format" subsection (AC-3): five-field cron expressions are evaluated in the host's local wall-clock time, not UTC.

2. A new "Policy admission for scheduled jobs" subsection (AC-1, AC-2): states that each tick goes through pre-flight policy admission before pi-agent receives the prompt; explains how to read the `user_id` UUID from the `scheduler-adapter job registered` `INFO` log line and add it to `[policy].admitted_users`, with a `bob policy reload` step.

3. A new "Observability for scheduled jobs" subsection (AC-4): lists the four observation points — service logs, policy verdict audit records, extension events, and explicitly states there is no dedicated schedule run-history store — keeping S-009/ADR-006 fire-and-forget semantics intact.

`mdbook build` from `the-intern/docs` succeeded (the pre-existing mermaid preprocessor version warning is not an error and was present before this change). All five acceptance criteria are met. Nothing remains for the next session. Implementation committed as `51ea880`.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->

### Review Verdict — 2026-06-27

PASS

Both Stage 1 (acceptance criteria) and Stage 2 (documentation accuracy) passed.

**Stage 1 — Acceptance Criteria:**

- AC-1 (PASS): The new "Policy admission for scheduled jobs" subsection explicitly states that each tick goes through pre-flight policy admission before pi-agent receives the prompt. Confirmed against `serve.rs`: `scheduler_adapter::start` receives the `requests_handler_handle`; events submit to the requests-handler which runs `requests_handler::run_preflight` for every inbound event before anything reaches persistence or pi-agent.

- AC-2 (PASS): The guide documents the log message text (`"scheduler-adapter job registered — fixed channel/user IDs for policy rules"`), the `user_id` field, the `[policy].admitted_users` config key, and the `bob policy reload` command. Cross-checked against `scheduler-adapter/src/lib.rs` line 255 — the `info!` macro message and field names (`job_id`, `channel_id`, `user_id`, `cron`) match exactly. Config key confirmed in `bob/src/config.rs`. `bob policy reload` confirmed in `cli/mod.rs` (`PolicyCommand::Reload`) and `cli/commands/policy.rs`.

- AC-3 (PASS): The cron-expression section now states five-field expressions are evaluated against the host's local wall-clock time, not UTC. Confirmed against `scheduler-adapter/src/lib.rs`: `use chrono::Local` and `let now = Local::now()` in `run_job_tick_loop`.

- AC-4 (PASS): The new "Observability for scheduled jobs" subsection lists all four surfaces: service logs, policy verdict audit records, extension events, and explicitly no dedicated schedule run-history store. The `bob audit tail --filter verdicts` and `bob audit tail --filter events` commands are correct — `cli/mod.rs` defines `#[arg(long = "filter")]` (singular, repeatable). No run-history store claim is consistent with S-009 and ADR-006.

- AC-5 (PASS): Ran `cd the-intern/docs && mdbook build` with the task-branch version of the file. Build succeeded. Only the pre-existing mermaid preprocessor version warning was emitted — no errors.

**Scope (PASS):** Only `the-intern/docs/src/operator-guide/index.md` and the task work-log entry changed. No source code modified. S-009/ADR-006 fire-and-forget and no-job-history semantics are preserved, not contradicted.

**Stage 2 — Documentation Quality:**

All claims are accurate and verifiable against the shipped code. No fabricated log messages, non-existent CLI flags, or incorrect config keys. One non-blocking cosmetic observation: the log example in the guide shows fields in the order `job_id, user_id, channel_id, cron`, while the `info!` macro emits them as `job_id, channel_id, user_id, cron`. Structured log field order in rendered output is subscriber-dependent and operators will grep by field name, so this does not affect correctness.
