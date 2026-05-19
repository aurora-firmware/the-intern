---
id: T-040
title: Wire TracingMonitoringHandle into extension-ipc actor for forwarded 
  events
status: pending
priority: high
assigned-role: unassigned
created: '2026-05-19'
spec: S-003
---

# Wire TracingMonitoringHandle into extension-ipc actor for forwarded events

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

Phase 4 of S-003. Replace `NoopMonitoringHandle` (the current default in
the `extension-ipc` actor) with a `tracing`-based handler so events
forwarded by the bob extension are observable in `bob serve`'s log.

Add a new `TracingMonitoringHandle` in the `extension-ipc` crate that
implements `MonitoringHandle::record_event` and emits exactly one
`tracing::info!` per call with structured fields `session` (the
`SessionId` displayed) and `event` (the string read from
`payload.event`). The full payload MAY be attached at `tracing::debug`.
No buffering, no admin-RPC fan-out.

Wire it into `bob::serve::try_start_subsystems` by passing
`Arc::new(TracingMonitoringHandle::default())` as
`extension_ipc::Config { monitoring_handle: ... }` instead of letting
`Config::default()` substitute `NoopMonitoringHandle`.

## Acceptance Criteria

AC-1: The system SHALL provide a `TracingMonitoringHandle` in the `extension-ipc` crate implementing `MonitoringHandle::record_event`.
AC-2: WHEN `record_event` is called with `MonitoringEvent { session, payload }` and `payload.event` is a string THE SYSTEM SHALL emit exactly one `tracing::info!` event with structured fields `session` equal to the inbound `SessionId` and `event` equal to that string.
AC-3: WHEN `bob serve` starts the extension-ipc actor THE SYSTEM SHALL wire `TracingMonitoringHandle` as the active `MonitoringHandle` in place of `NoopMonitoringHandle`.

## Dependencies

- `T-039` — both tasks edit `the-intern/service/crates/bob/src/serve.rs`. Sequencing T-040 after T-039 avoids a merge conflict on that file and matches S-003's intent that the end-to-end log line is verifiable once supervisor env vars are flowing. T-037 and T-038 are independent and may run in parallel with either.

## Files to Touch

- `the-intern/service/crates/extension-ipc/src/multiplex.rs` (or a new sibling module) — define `TracingMonitoringHandle` and its unit test (use `tracing_test` or capture via a custom subscriber).
- `the-intern/service/crates/extension-ipc/src/lib.rs` — re-export `TracingMonitoringHandle` so `bob` can name it.
- `the-intern/service/crates/bob/src/serve.rs` — construct the extension-ipc `Config` with `TracingMonitoringHandle` instead of relying on the default.

## Verification

```bash
cd the-intern/service
cargo test -p extension-ipc
cargo test -p bob serve::tests
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
