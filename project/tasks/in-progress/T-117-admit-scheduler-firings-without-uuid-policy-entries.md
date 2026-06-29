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

### Review Verdict — 2026-06-30

PASS

**Stage 1 — Acceptance Criteria**

AC-1 (scheduler firing with empty admitted_users is admitted): Met. The bypass
branch (`if event.kind == DeliveryKind::Periodic`) routes periodic events
directly to `persistence_store.enqueue` without calling `run_preflight`.
Test `periodic_event_is_admitted_and_reaches_pi_agent_with_empty_admitted_users`
exercises the full path (requests-handler → bypass → persistence → dispatcher →
pi-agent) using `BobConfig::test_base()` which has empty `admitted_users`.

AC-2 (no UserId admission evaluation for scheduler firings): Met. `run_preflight`
(and the `PolicyEngine::evaluate_admission` call inside it) is never reached for
`DeliveryKind::Periodic` events. The condition is structurally exclusive.

AC-3 (scheduler request context fields preserved for audit attribution): Met. The
`RequestContext` (carrying stable `channel_id`, `user_id`, and `context_id`/job
id set by the scheduler-adapter) is captured in the bypass closure and used in
the failure-path `tracing::warn!`. The scheduler-adapter updated docs confirm
these fields exist for audit attribution, not for admission. The context is not
stripped; it remains available in the closure on the success path for future use.

AC-4 (tool_call action authorization unchanged): Met by inspection. No changes
were made to the periodic dispatcher, pi-agent supervisor, or any code on the
post-persistence path. The diff touches only the pre-persistence preflight
closure in `serve.rs` and doc/log wording in `scheduler-adapter/src/lib.rs`.

AC-5 (non-scheduler requests still denied when sender absent from admitted_users):
Met. The `else` branch forwards all non-Periodic events to `run_preflight`
unchanged. Test `sync_event_from_sender_absent_from_admitted_users_is_denied`
submits a `DeliveryKind::Sync` event from a UserId not in `admitted_users` and
asserts that persistence is empty after the preflight actor processes it.

Security scope check: `DeliveryKind` has exactly three variants (`Sync`,
`Async`, `Periodic`). The bypass is conditional on `== DeliveryKind::Periodic`;
`Sync` and `Async` events always reach `run_preflight`. The scheduler-adapter
only ever constructs `InternalEvent { kind: DeliveryKind::Periodic, ... }`, so
there is no path by which a non-periodic event could enter the bypass branch
from the scheduler.

No unspecified behavior was added. No unexpected files were modified.

**Stage 2 — Code Quality**

Correctness: the bypass logic is minimal and correct. Error handling for failed
`persistence_store.enqueue` emits a structured `WARN` log with `job_id` from
`context.context_id` — appropriate level and no sensitive payload exposed.

Tests: both new tests construct independent fixtures, use descriptive names, and
assert the right outcome (prompt reaches pi-agent for AC-1; persistence stays
empty for AC-5). The AC-1 test uses a file-based polling approach consistent
with the existing `periodic_event_is_dispatched_to_pi_agent_with_payload_as_prompt`
test. The 50ms sleep in the AC-5 test is consistent with the project's existing
integration test patterns.

Security: no hardcoded secrets; bypass is strictly scoped; non-Periodic events
are unaffected.

Readability: comment block clearly references ADR-012 and explains the trust
model. Scheduler-adapter doc updates remove stale "for policy rules" language
without altering any runtime behavior.

All tests green: `cargo test -p bob --lib serve::tests` (34 passed), `cargo
test -p scheduler-adapter` (9 passed), `cargo test -p requests-handler` (15
passed), `cargo test --workspace` (no failures across all crates).

**Non-blocking observation**: the bypass path does not write an audit record on
successful scheduler enqueue. ADR-012 notes (neutral consequence) that "audit
should still record scheduled execution". AC-3 requires preserving context
fields, not emitting a record, so this does not block the verdict. A future
task could add an admit-verdict audit record for periodic events symmetrically
with the allow-verdict record already written by `run_preflight`.
