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

### Session 1 — 2026-06-30

Picked up T-117 on branch `task/T-117-admit-scheduler-firings-without-uuid-policy-entries`. Work log was empty (first session).

**What was done**

Read the task, ADR-012, and the current flow through `serve.rs`, `scheduler-adapter/src/lib.rs`, and `requests-handler/src/handler.rs`. The scheduler submits `DeliveryKind::Periodic` events through the requests-handler; the preflight closure currently calls `run_preflight` for every event regardless of kind, which evaluates the scheduler-derived `UserId` against `[policy].admitted_users`. Under ADR-012, that check must not be applied to periodic events.

The implementation is a single branch in `serve.rs`'s preflight closure: `if event.kind == DeliveryKind::Periodic { persistence_store.enqueue(event).await; } else { run_preflight(...).await; }`. No changes to `requests-handler/src/handler.rs` were needed — the exception is cleanest in `serve.rs` as the task specified. `scheduler-adapter/src/lib.rs` received only comment and log-message updates (replacing "for policy rules" with "for audit attribution") to remove policy-gating language that no longer reflects the design.

**Tried and rejected**

First attempt at the AC-1 test tried to observe admission by calling `persistence.dequeue_next()` right after submitting a Periodic event. This failed because the concurrently running periodic dispatcher consumed the event from persistence before the test assertion ran. Resolved by adopting the same end-to-end pattern as the existing `periodic_event_is_dispatched_to_pi_agent_with_payload_as_prompt` test: a worker script writes the prompt to a file, and the test waits for that file to appear.

Also hit a compile error when constructing `BobConfig` inline with `policy: crate::config::PolicyConfig { admitted_users: vec![], ... }` — `PolicyConfig` is re-exported, not directly named under the `crate::config` path in test scope. Fixed by using `..BobConfig::test_base()` (which already has `PolicyConfig::default()` = empty `admitted_users`).

**Tests added:** `periodic_event_is_admitted_and_reaches_pi_agent_with_empty_admitted_users` (AC-1, full path requests-handler → bypass → persistence → dispatcher → pi-agent) and `sync_event_from_sender_absent_from_admitted_users_is_denied` (AC-5). AC-4 verified by inspection (no changes on the post-persistence / tool_call authorization path).

**Evidence:** `cargo test -p bob --lib serve::tests` 34 passed; `cargo test -p scheduler-adapter` 9 passed; `cargo test -p requests-handler` 15 passed; `cargo test --workspace` all green. Committed as `feat(scheduler): bypass UserId admission for periodic events per ADR-012` (`9632acd`).

**What remains**

Nothing. All five acceptance criteria are satisfied.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->
