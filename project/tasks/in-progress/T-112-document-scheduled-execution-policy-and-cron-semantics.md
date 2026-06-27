---
id: T-112
title: Document scheduled execution policy and cron semantics
status: pending
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

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->
