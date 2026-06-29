---
id: T-117
title: Admit scheduler firings without UUID policy entries
status: pending
priority: high
assigned-role: unassigned
created: '2026-06-30'
---

# Admit scheduler firings without UUID policy entries

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

Remove scheduler-derived UUID admission as an execution gate. Under ADR-012, a
scheduled job present in the trusted JSON schedule store is admitted for firing;
the operator should not need to add `UserId::from_name(job_id)` to
`[policy].admitted_users`.

Keep the request/audit context useful for attribution, but ensure scheduler
firings reach persistence/pi-agent even when policy admission would otherwise
deny the synthetic scheduler `UserId`. Do not weaken S-004 `tool_call` action
authorization.

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

AC-1: WHEN a valid scheduled job fires and `[policy].admitted_users` is empty
      THE SYSTEM SHALL admit the scheduler firing into the periodic dispatch
      path.
AC-2: IF a scheduled job fires THEN THE SYSTEM SHALL NOT evaluate admission by
      checking a scheduler-derived `UserId` against `[policy].admitted_users`.
AC-3: The system shall preserve scheduler request context fields needed for
      audit attribution, including job id and scheduler channel/source.
AC-4: The system shall leave `tool_call` action authorization unchanged for
      pi-agent work triggered by scheduled prompts.
AC-5: IF a non-scheduler admission-gated request has a sender absent from
      `[policy].admitted_users` THEN THE SYSTEM SHALL continue to deny that
      request through the existing pre-flight path.

## Dependencies

- `T-114` — scheduler startup is driven from trusted JSON schedule state.
- `T-115` — admin-RPC schedule persistence and `serve.rs` schedule-store path
  wiring are updated before this task changes scheduler admission in `serve.rs`.

## Files to Touch

- `the-intern/service/crates/bob/src/serve.rs` — route scheduler-originated
  periodic events through the ADR-012 admission path while preserving normal
  pre-flight for admission-gated requests.
- `the-intern/service/crates/scheduler-adapter/src/lib.rs` — remove policy-rule
  oriented scheduler `UserId` logging/identity assumptions if they are no
  longer needed for admission.
- `the-intern/service/crates/requests-handler/src/handler.rs` — adjust only if
  the cleanest implementation needs an explicit admission-bypass helper instead
  of keeping the exception in `bob serve`.

## Verification

```bash
cd the-intern/service && cargo test -p bob serve::tests -p scheduler-adapter -p requests-handler
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
