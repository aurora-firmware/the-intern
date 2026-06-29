---
id: T-116
title: Update scheduler docs and end-to-end coverage for JSON state
status: pending
priority: medium
assigned-role: unassigned
created: '2026-06-30'
---

# Update scheduler docs and end-to-end coverage for JSON state

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

Update user-facing scheduler documentation and end-to-end coverage after the
CR-004 implementation tasks land. Operators should no longer be told to edit
`[[schedule]]` in `config.toml` or copy scheduler-derived UUIDs into
`[policy].admitted_users`.

The docs should explain `schedules.json`, the default XDG state location, the
owner-only permission model, `bob schedule` as the normal mutation path, direct
file edit plus `bob schedule reload`, and the fact that tool-call
authorization still applies. E2E tests should cover the full JSON-store path
and prove an otherwise empty `admitted_users` list does not block scheduled
prompt delivery.

## Acceptance Criteria

<!-- EARS pattern reference. Every criterion must match one pattern:
  1. Ubiquitous            — The system shall [outcome]
  2. Event-driven          — WHEN [trigger] THE SYSTEM SHALL [outcome]
  3. Unwanted-behaviour    — IF [fault] THEN THE SYSTEM SHALL [outcome]
  4. State-driven          — WHILE [state] THE SYSTEM SHALL [outcome]
  5. Optional              — WHERE [feature included] THE SYSTEM SHALL [outcome]

Examples:
  AC-1: WHEN the user submits valid credentials THE SYSTEM SHALL
        redirect to /dashboard within 200ms.
  AC-2: IF the password is incorrect THEN THE SYSTEM SHALL return 401
        and display "Invalid credentials".
  AC-3: The system shall log every authentication attempt with user id
        and outcome.
-->

AC-1: The operator guide shall document `schedules.json` as the scheduler source
      of truth, including the Linux XDG state path and fallback.
AC-2: The operator guide shall not instruct operators to add scheduler-derived
      UUIDs to `[policy].admitted_users` for scheduled jobs.
AC-3: The operator guide shall state that scheduled jobs are admitted by the
      Unix trust boundary and trusted schedule store, while every resulting
      `tool_call` still uses S-004 action authorization.
AC-4: WHEN the scheduler execution e2e test runs with a valid JSON schedule
      entry and empty `[policy].admitted_users` THE SYSTEM SHALL deliver the
      scheduled prompt to the fake pi-agent worker.
AC-5: IF repository documentation still references `[[schedule]]` in
      `config.toml` as the active scheduler source of truth THEN THE SYSTEM
      SHALL update that reference or mark it as historical report content.

## Dependencies

- `T-113` — JSON schedule-store persistence exists.
- `T-114` — startup loads scheduler entries from JSON state.
- `T-115` — schedule RPC mutations persist to JSON state.
- `T-117` — scheduler firings no longer require UUID policy admission.

## Files to Touch

- `the-intern/docs/src/operator-guide/index.md` — update scheduled-job
  configuration, policy, reload, and observability guidance.
- `the-intern/docs/src/architecture-overview/index.md` — update scheduler
  admission/source-of-truth wording.
- `the-intern/service/crates/bob/tests/scheduler_execution_e2e.rs` — update
  full-path scheduled prompt coverage for JSON state and empty admitted_users.

## Verification

```bash
cd the-intern/service && cargo test --test scheduler_execution_e2e -- --nocapture
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
