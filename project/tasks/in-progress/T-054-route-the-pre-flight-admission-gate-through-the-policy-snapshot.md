---
id: T-054
title: Route the pre-flight admission gate through the policy snapshot
status: pending
priority: high
assigned-role: unassigned
created: '2026-05-20'
spec: S-004
---

# Route the pre-flight admission gate through the policy snapshot

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

Phase 3 of S-004. Route the pre-flight admission gate through the shared
policy engine instead of the standalone `allowed_user_ids` membership test,
preserving observable behaviour.

In the `requests-handler` crate:

- Add a dependency on `policy-control`.
- Change `run_preflight` to take a `policy_control::SnapshotHandle` in place
  of `&PreflightConfig`. For each event it reads the current snapshot and
  calls `PolicyEngine::evaluate_admission(snapshot, context.sender)`. An
  allow verdict enqueues the event; a deny verdict — or an absent
  `RequestContext` — drops it, emits a `tracing::warn!` **without the
  payload**, and appends a `PreflightDenied` `AuditRecord`.
- Remove `PreflightConfig` and reconcile `start_with_preflight` in `lib.rs`
  (update its signature or remove it if unused) so the crate is consistent.

In `bob/src/serve.rs`, build the pre-flight closure from the
`SnapshotHandle` (returned by T-053's wiring) instead of `PreflightConfig`.

Behaviour to preserve exactly: deny on missing context, deny when the user
is not admitted, warn lines must never contain the raw event payload, and a
`PreflightDenied` audit record is appended on every denial.

## Acceptance Criteria

AC-1: WHEN `run_preflight` processes an event whose `RequestContext.sender` is admitted by the current snapshot THE SYSTEM SHALL enqueue the event to persistence.
AC-2: IF `run_preflight` processes an event whose sender is not admitted, or whose `RequestContext` is absent, THEN THE SYSTEM SHALL drop the event, emit a `tracing::warn!` that excludes the raw event payload, and append a `PreflightDenied` audit record.
AC-3: The system shall evaluate pre-flight admission via `PolicyEngine::evaluate_admission` against the policy snapshot, and the `PreflightConfig` type shall no longer exist.
AC-4: WHEN `bob serve` starts THE SYSTEM SHALL wire the pre-flight gate to read the policy snapshot handle.

## Dependencies

- `T-053` — provides the `SnapshotHandle` at startup and shares `bob/src/serve.rs` (sequencing avoids a conflict on that file).

## Files to Touch

- `the-intern/service/crates/requests-handler/Cargo.toml` — add the `policy-control` dependency.
- `the-intern/service/crates/requests-handler/src/handler.rs` — `run_preflight` via the engine; remove `PreflightConfig`.
- `the-intern/service/crates/requests-handler/src/lib.rs` — reconcile `start_with_preflight` and re-exports.
- `the-intern/service/crates/bob/src/serve.rs` — build the pre-flight closure from the snapshot handle.

## Verification

```bash
cd the-intern/service
cargo test -p requests-handler -p bob
cargo clippy -p requests-handler -p bob --all-targets
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
