---
id: T-065
title: Record extension events and policy verdicts in Monitoring
status: pending
priority: high
assigned-role: unassigned
created: '2026-05-20'
spec: S-005
---

# Record extension events and policy verdicts in Monitoring

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

Phase 4 of S-005. Route existing runtime producers into the real Monitoring
subsystem.

Phase 3 currently wires extension events to `TracingMonitoringHandle`; S-005
requires those events to become persistent audit records. S-004 policy paths
must also emit verdict audit records. The pre-flight verdict path is in
`requests-handler`, while tool-call verdicts flow through `extension-ipc`.
Replace tracing-only event recording with Monitoring-backed recording while
keeping useful tracing as secondary observability. Policy semantics must not
change: this task records verdicts; it does not alter allow/deny decisions.

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

AC-1: WHEN extension-ipc receives an `InboundFrame::Event` THE SYSTEM SHALL submit an `event` audit record to Monitoring with the session id and payload.
AC-2: WHEN the pre-flight or tool-call authorization path produces a verdict THE SYSTEM SHALL submit a `verdict` audit record to Monitoring without changing the verdict result.
AC-3: IF Monitoring rejects a runtime audit record THEN THE SYSTEM SHALL log the failure and preserve the existing request/tool-call control-flow outcome.
AC-4: WHEN `bob serve` starts extension-ipc and requests-handler integrations THE SYSTEM SHALL wire the real Monitoring handle instead of the tracing-only placeholder.

## Dependencies

- `T-060` — also modifies `monitoring/src/lib.rs`; this task extends the Monitoring API with producer-facing helpers after the actor/store exists.
- `T-061` — wires the real Monitoring actor into `bob serve`.
- `T-062` — also touches `bob/src/serve.rs`; sequencing after it avoids a runtime-wiring merge conflict.

## Files to Touch

- `the-intern/service/crates/extension-ipc/src/multiplex.rs` — record forwarded extension events through the Monitoring handle and update tests.
- `the-intern/service/crates/requests-handler/src/handler.rs` — emit pre-flight verdict audit records without changing admission behaviour.
- `the-intern/service/crates/bob/src/serve.rs` — pass the real Monitoring handle into extension and policy integrations.
- `the-intern/service/crates/monitoring/src/lib.rs` — add small helper methods only if the producer-specific record helpers belong in Monitoring.

## Verification

```bash
cd the-intern/service
cargo test -p extension-ipc
cargo test -p requests-handler
cargo test -p bob serve::tests
```

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

### Session 1 — 2026-05-20

Three TDD cycles implemented all four acceptance criteria.

Cycle 1 (AC-1, AC-2 tool-call, AC-3 — extension-ipc): added `monitoring` and `chrono` as dependencies to `extension-ipc`. Introduced a `MonitoringVerdict` struct alongside the existing `MonitoringEvent`. Extended the `MonitoringHandle` trait with a `record_verdict` method; updated `NoopMonitoringHandle` and `TracingMonitoringHandle` with no-op and tracing-only implementations. Created `MonitoringBackedHandle`, which wraps `monitoring::Handle` and appends `AuditRecord` instances of kind `Event` or `Verdict` per call; monitoring failures are logged via `tracing::warn!` and never propagate to the caller (AC-3). Updated `SessionMultiplexer::handle_frame` to call `record_verdict` on `InboundFrame::Authz` after policy evaluation and before sending the wire reply — the policy outcome is never changed. Updated `CapturingMonitoringHandle` in tests; exported `MonitoringBackedHandle` from the crate root.

Cycle 2 (AC-2 preflight — requests-handler): added allow-verdict `AuditRecord` emission to `run_preflight` for every admitted event (the deny path already existed). Updated two existing tests that previously asserted no audit records on allow; they now assert exactly one allow-verdict record.

Cycle 3 (AC-4 — bob serve): changed `try_start_subsystems` to pass `MonitoringBackedHandle::new(monitoring_handle.clone())` to the extension-ipc config instead of `TracingMonitoringHandle`. Added a test verifying the real monitoring handle supports pub/sub end-to-end after startup.

Tried and rejected: replacing the `MonitoringHandle` trait entirely with `monitoring::Handle` in extension-ipc — retained the trait as a testability seam, since `CapturingMonitoringHandle` remains useful for verifying call counts without a real monitoring actor. Also considered adding `append_event_record`/`append_verdict_record` helpers to `monitoring/src/lib.rs` — rejected because `Handle::append_record` is already the correct API and helpers would only relocate construction logic.

Verification (run from `the-intern/service`):
- `cargo test -p extension-ipc` — 35 passed, 0 failed.
- `cargo test -p requests-handler` — 14 passed, 0 failed.
- `cargo test -p bob --lib serve` — 21 passed, 0 failed (66 total lib tests, 0 failures workspace-wide).
- Three commits on the task branch.

Nothing remains; all four ACs are met.

Obstacles Encountered:
- The AC-4 test initially failed because `test_cfg_with_sockets` uses an empty `monitoring.audit_log_path`; fixed by constructing a `BobConfig` with a temp-dir-based audit log path in the test.
- `cargo test -p bob serve::tests` from the task's verification block was reported by the Developer as matching no tests in their environment; `cargo test -p bob --lib serve` matches the serve-module tests reliably. (Reviewer/integrator should confirm the canonical `serve::tests` filter.)

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->

### Review Verdict — 2026-05-20

PASS

Both stages passed.

**Stage 1 — Spec compliance**

- AC-1: `MonitoringBackedHandle::record_event` constructs an `AuditRecord` of kind `Event` with the session id from the `MonitoringEvent` and appends it via `monitoring::Handle::append_record`. Confirmed by `event_frame_submits_event_audit_record_to_monitoring_with_session_id` (35/35 pass).
- AC-2 (tool-call): In `SessionMultiplexer::handle_frame`, `PolicyEngine::evaluate_action` is called first; only then is `record_verdict` called with a clone of the reason — the `verdict` binding itself is passed unmodified to `OutboundFrame::AuthzVerdict`. The allow/deny outcome is unchanged. Confirmed by `authz_frame_submits_verdict_audit_record_to_monitoring_with_session_id`.
- AC-2 (pre-flight): `run_preflight` in `handler.rs` now emits an allow-verdict `AuditRecord` in the `if allowed` branch after `store.enqueue`; the deny branch is untouched. Two updated tests and one new test cover both paths.
- AC-3: Both `record_event` and `record_verdict` in `MonitoringBackedHandle` wrap `append_record` in `if let Err(err) = ...` with `tracing::warn!`; the error is never propagated. The `event_frame_monitoring_rejection_logs_failure_and_preserves_control_flow` test passes a directory path as the audit log (which causes `append_record` to fail) and asserts `handle_frame` returns `Ok(())`.
- AC-4: `try_start_subsystems` in `serve.rs` now passes `Arc::new(extension_ipc::MonitoringBackedHandle::new(monitoring_handle.clone()))` instead of `TracingMonitoringHandle`. The new test `extension_ipc_is_wired_with_monitoring_backed_handle_not_tracing_placeholder` verifies the shared monitoring handle is functional end-to-end.
- Scope: changed files are exactly those specified (`extension-ipc/Cargo.toml`, `extension-ipc/src/lib.rs`, `extension-ipc/src/multiplex.rs`, `requests-handler/src/handler.rs`, `bob/src/serve.rs`, `Cargo.lock`). `monitoring/src/lib.rs` was correctly omitted per the Work Log decision.

**Stage 2 — Code quality**

- Correctness: Policy allow/deny semantics are byte-for-byte preserved. Monitoring failures cannot alter control flow (verified at code and test level). `verdict.reason.clone()` is used for the monitoring call; the original `verdict` is sent on the wire.
- Tests: 35 extension-ipc tests, 14 requests-handler tests, 21 bob serve tests — all pass. New tests cover AC-1, AC-2 (both paths), AC-3, and AC-4. Test doubles (`CapturingMonitoringHandle`) correctly updated with the new `record_verdict` method.
- Security: No hardcoded credentials. The `AuditRecord` id uses a timestamp; no external input flows into record construction without extraction via `.get("event").and_then(|v| v.as_str())`.
- Readability: Names are clear and follow project conventions. `MonitoringBackedHandle` is well-documented. Comments in `handle_frame` and `run_preflight` correctly describe the failure-tolerance intent.
- Performance: No unnecessary loops. `chrono::Utc::now()` is called twice per record (id and timestamp); this is a minor observation, not a blocking concern.

Minor observation (non-blocking): `chrono::Utc::now()` is called twice when constructing each `AuditRecord` (once for the id, once for the timestamp). This is harmless but could theoretically produce an id and a timestamp that differ by a millisecond boundary. No impact on correctness or audit semantics.
