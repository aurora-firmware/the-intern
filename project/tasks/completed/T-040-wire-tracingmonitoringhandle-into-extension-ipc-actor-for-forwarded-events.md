---
id: T-040
title: Wire TracingMonitoringHandle into extension-ipc actor for forwarded 
  events
status: completed
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

### Session 1 — 2026-05-19

Implemented all three acceptance criteria for T-040 in two TDD cycles.

**Cycle 1 (AC-1 + AC-2):** Added `TracingMonitoringHandle` as a unit struct in `extension-ipc/src/multiplex.rs`. It implements `MonitoringHandle::record_event` by extracting the string value of `payload["event"]`, emitting one `tracing::info!` with structured fields `session = %session` and `event = event_name`, then emitting the full payload at `tracing::debug`. The `Default` derive was requested but clippy (`default_constructed_unit_structs`) flags `UnitStruct::default()` — the `Default` trait is still derived (so callers using `..Config::default()` struct-update syntax work), but direct construction uses the bare `TracingMonitoringHandle` literal.

For the unit test, added a `TracingCapture` helper struct in the test module that installs a `tracing_subscriber::fmt` subscriber (with ANSI coloring disabled and level `TRACE`) that appends each formatted log line to a `Vec<String>`. The test calls `record_event` once and asserts: exactly one line contains " INFO ", that line contains the session UUID string, and that line contains "session.started". The first run failed because the subscriber was writing ANSI escape codes; fixed by adding `.with_ansi(false)`.

Added `tracing-subscriber = { version = "0.3", features = ["fmt"] }` to `extension-ipc/Cargo.toml` dev-dependencies. This file is not listed in "Files to Touch" but is a necessary supporting change to enable the test subscriber infrastructure without pulling in a new crate from scratch.

Re-exported `TracingMonitoringHandle` from `extension-ipc/src/lib.rs` with `pub use crate::multiplex::TracingMonitoringHandle`.

**Cycle 2 (AC-3):** Updated `try_start_subsystems` in `bob/src/serve.rs` to construct `extension_ipc::Config { monitoring_handle: Arc::new(extension_ipc::TracingMonitoringHandle), ..extension_ipc::Config::default() }` instead of `extension_ipc::Config::default()`. Added a new `#[test]` `extension_ipc_config_accepts_tracing_monitoring_handle` that constructs the same config expression — this is a compile-level structural test that would fail to compile if `TracingMonitoringHandle` were removed or if it no longer satisfied `MonitoringHandle`.

All 28 extension-ipc tests pass; all 15 bob `serve::tests` pass. Clippy is clean on extension-ipc (`--tests` profile) and the new serve.rs code emits no new clippy errors.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->

### Review Verdict — 2026-05-19

PASS

Both Stage 1 (spec compliance) and Stage 2 (code quality) passed.

**Stage 1 — Acceptance Criteria**

- AC-1: `TracingMonitoringHandle` is defined as a unit struct in `extension-ipc/src/multiplex.rs` with `#[async_trait] impl MonitoringHandle`. Re-exported from `lib.rs`. Met.
- AC-2: `record_event` extracts `payload["event"]` as a string (falling back to `"<unknown>"`), emits exactly one `tracing::info!` with `session = %session` and `event = event_name`, and one `tracing::debug!` with the full payload. The unit test `tracing_monitoring_handle_record_event_emits_one_info_event_with_session_and_event_fields` asserts: exactly one INFO line, the session UUID is present, and the event string value is present. Met.
- AC-3: `bob::serve::try_start_subsystems` now constructs `extension_ipc::Config { monitoring_handle: Arc::new(extension_ipc::TracingMonitoringHandle), ..extension_ipc::Config::default() }`. `NoopMonitoringHandle` is no longer used in that code path. Met.

**File scope note:** `extension-ipc/Cargo.toml` was modified outside the "Files to Touch" list to add `tracing-subscriber` as a `[dev-dependencies]` entry. This is minimal, dev-only, and necessary to build the test subscriber; `tracing-subscriber` was already present in `Cargo.lock` transitively, so `Cargo.lock` required no changes. The Work Log documents this decision explicitly. Accepted.

**Stage 2 — Code Quality**

- Correctness: The `unwrap_or("<unknown>")` fallback handles missing or non-string `event` fields correctly. Both the info and debug spans carry the right fields. No off-by-one or unhandled states.
- Tests: 28 extension-ipc tests pass (including the new AC-2 unit test). 52 bob unit tests pass (including `extension_ipc_config_accepts_tracing_monitoring_handle` for AC-3). The `TracingCapture` helper is self-contained and installs a thread-local subscriber guard, so tests are independent.
- Security: No credentials, no external input bypassing validation, no new permissions.
- Readability: `TracingMonitoringHandle`, `TracingCapture`, and `LineWriter` are well-named and focused. Doc comment on the struct accurately describes behaviour. No dead code or debug artifacts.
- Performance: One async call per event with no buffering or allocation beyond string extraction. No blocking operations.

**Verification evidence:** `cargo test -p extension-ipc` — 28 passed, 0 failed. `cargo test -p bob` — 55 passed across all test binaries, 0 failed. The pre-existing flaky test `pi-agent-supervisor process::tests::terminate_requests_graceful_shutdown_before_deadline` did not appear in this run.
