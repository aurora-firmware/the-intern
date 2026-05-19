---
id: B-006
title: bob serve MonitoringAuditSink stringifies AuditKind via Debug and has no 
  test
severity: medium
status: resolved
created: '2026-05-19'
---

# bob serve MonitoringAuditSink stringifies AuditKind via Debug and has no test

## Summary

`bob/src/serve.rs` constructs an inline `MonitoringAuditSink` adapter that converts `AuditSink::record(AuditKind, payload)` into `monitoring::Handle::record_event(format!("{kind:?}"), payload)`. This (a) loses the typed `AuditKind` variant the rest of the system carries — downstream consumers see a debug-formatted string instead of the enum — and (b) is wired entirely inline in `serve.rs` with no unit test for the adapter. A rename of any `AuditKind` variant silently changes the wire shape on the monitoring channel.

## Reproduction Status

Status: confirmed by code review.

## Evidence

- Logs / stack traces / failing assertions: none — silent failure mode.
- Screenshots or recordings: none
- Failing command or test: n/a (no test currently covers the adapter)
- First diagnostic step if not yet reproduced: inspect `the-intern/service/crates/bob/src/serve.rs` `MonitoringAuditSink` impl; observe the `format!("{:?}", kind)` call.

## Reproduction Steps

1. Open `the-intern/service/crates/bob/src/serve.rs` and locate the `MonitoringAuditSink` impl.
2. Observe that it formats `AuditKind` with `{:?}` to produce the event-name string passed to `monitoring::record_event`.
3. Rename any `AuditKind` variant (e.g. `PreflightDenied` → `PreflightRejected`) and rebuild — observe the audit event name on the monitoring channel changes silently with no compile error and no test failure.

## Expected Behavior

The adapter should live in `monitoring` (or a small bridge module), be a typed `AuditSink` implementation, map `AuditKind` to a stable string table (not Debug format), and have a unit test that pins the mapping so renames break the test rather than the wire.

## Actual Behavior

Inline adapter in `serve.rs`, no test, debug-format strings as the wire identifier. A `Debug` impl change rewrites the audit channel silently.

## Environment

- OS / platform: Linux (Codex execution environment)
- Language / runtime version: Rust workspace under `the-intern/service` (rustc stable)
- Relevant dependencies: `bob`, `monitoring`, `bob-core::AuditKind`
- Branch / commit: `dev-agent` post-merge of T-040 (`ceb872d`)

## Related

- Task: n/a
- Specification: n/a

## Suspected Area

`the-intern/service/crates/bob/src/serve.rs` (inline adapter); `the-intern/service/crates/monitoring/` (where the typed adapter should live).

## Fix Verification

```bash
cd the-intern/service
cargo test -p monitoring
cargo test -p bob
```

A new unit test in `monitoring` must assert each `AuditKind` variant maps to its stable kebab-case string. Renaming a variant should fail that test.

## Diagnosis Log

<!-- Mandatory before implementation. Append one entry before changing production code. Format:
### Diagnosis N — YYYY-MM-DD
Reproduction status:
Evidence captured:
Isolated fault:
Root cause or fault hypothesis:
Planned verification:
-->

### Diagnosis 1 — 2026-05-19

**Reproduction status:** Confirmed by static analysis. No runtime test existed to detect it.

**Evidence captured:**
- `bob/src/serve.rs:52-63` — inline `MonitoringAuditSink` struct whose `AuditSink::append` calls `self.handle.record_event(format!("{:?}: {}", record.kind, record.description))`.
- `bob-core/src/types/records.rs` — `AuditKind` enum with 8 variants (`RequestReceived`, `PolicyDecision`, `ActionInvoked`, `ActionCompleted`, `ActionFailed`, `SessionStarted`, `SessionEnded`, `PreflightDenied`); each derives `Debug`, so `format!("{:?}", kind)` yields the variant identifier.
- `monitoring::Handle::record_event` accepts `impl Into<String>` — no typed overload, no `AuditKind` discriminant on the wire.
- No unit test covers `MonitoringAuditSink` anywhere in the workspace.

**Isolated fault:** The `format!("{:?}: {}", record.kind, record.description)` call in the inline `MonitoringAuditSink::append`. This is the sole site converting `AuditKind` to a monitoring channel event name, and it uses `Debug` formatting as a shortcut.

**Root cause or fault hypothesis:** The adapter was written inline in `serve.rs` (an assembly file) and reached for `Debug` formatting instead of a stable mapping. The `Debug` impl is derived from variant identifiers, so any rename silently rewrites the wire identifier on the monitoring channel — no compile error, no test failure.

**Planned verification:**
1. Add `audit_kind_to_event_name(&AuditKind) -> &'static str` to `monitoring/src/lib.rs` using an exhaustive `match` mapping each variant to a stable kebab-case string.
2. Add a `MonitoringAuditSink` adapter struct + `AuditSink` impl in `monitoring` that delegates to `audit_kind_to_event_name` and then `record_event`.
3. Add an exhaustive unit test pinning every variant to its expected string. Adding a new variant must require updating both the `match` and the test.
4. Remove the inline adapter from `bob/src/serve.rs`; construct `monitoring::MonitoringAuditSink::new(monitoring_handle.clone())` at the wiring site.
5. Run `cargo test -p monitoring -p bob && cargo test --workspace` — all green.

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

### Session 1 — 2026-05-19

Chose `monitoring` as the home for the typed adapter — it owns the destination side, and both the bug report and the AI review report prefer it. Added `audit_kind_to_event_name(&AuditKind) -> &'static str` with an exhaustive `match` mapping each of the 8 variants to a stable kebab-case string. Added `MonitoringAuditSink` (a public `Clone` struct with `new(Handle)`) and its `async_trait` `AuditSink` impl that delegates through `audit_kind_to_event_name` and then `record_event`. Added the unit test `audit_kind_to_event_name_maps_every_variant_to_stable_kebab_case_string` covering all 8 variants — both compile-time exhaustiveness (the `match`) and run-time assertion (the table) guard against silent renames and table drift.

Removed the inline `MonitoringAuditSink` struct and `AuditSink` impl from `bob/src/serve.rs` (~12 lines), removed the now-unused `AuditRecord` import, and replaced the construction site with `monitoring::MonitoringAuditSink::new(monitoring_handle.clone())`.

Rejected alternatives:
- Putting the adapter in `bob-core` (pure domain crate has no dependency on `monitoring`, would create a circular or bridge-trait problem).
- Snake_case event names — kebab-case is the conventional style for monitoring event identifiers in this stack and is documented in the function doc.

Evidence:
- `cargo test -p monitoring`: 3 passed, including the new mapping test.
- `cargo test -p monitoring -p bob`: 3 monitoring + 58 bob tests passed.
- `cargo test --workspace`: all crates green.

Commit `ce9208f` on `bug/B-006-typed-monitoring-audit-sink` — `fix(monitoring,bob): typed AuditKind-to-event mapping with test coverage`. Nothing remains for the next session.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that diagnosis, fix, verification, and code quality passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->

### Review Verdict — 2026-05-19

PASS

**Stage 1 — Bug Criteria**

- Diagnosis Log is present and complete: reproduction status (confirmed by static analysis), evidence (file and line of the `{:?}` call, 8-variant enum, absence of any test), isolated fault (the `format!("{:?}: {}", ...)` call), root cause (inline adapter using Debug formatting), and planned verification (5-step plan) are all recorded before the Work Log.
- Fix addresses the isolated fault exactly: the `format!("{kind:?}")` call is gone; all event names now come from an exhaustive `match`.
- No unrelated behaviour was added; commit touches only `monitoring/src/lib.rs` and `bob/src/serve.rs`.
- Fix Verification steps were executed and recorded: `cargo test -p monitoring`, `cargo test -p monitoring -p bob`, and `cargo test --workspace` all passed per the Work Log, confirmed independently during this review.

**Stage 2 — Code Quality**

- `audit_kind_to_event_name` lives in `monitoring/src/lib.rs`, not inline in `bob::serve`. All 8 `AuditKind` variants are covered with distinct kebab-case strings (`request-received`, `policy-decision`, `action-invoked`, `action-completed`, `action-failed`, `session-started`, `session-ended`, `preflight-denied`).
- `MonitoringAuditSink` is a `pub` `Clone` struct with a `pub fn new(Handle) -> Self` constructor. Its `AuditSink` impl delegates through `audit_kind_to_event_name` then `record_event`. Logic is correct.
- The new unit test `audit_kind_to_event_name_maps_every_variant_to_stable_kebab_case_string` covers all 8 variants in a table, with a descriptive `assert_eq!` message. Both compile-time exhaustiveness (the `match`) and run-time pinning (the table) guard against silent renames.
- `bob/src/serve.rs` contains no `MonitoringAuditSink` struct, no `AuditSink` impl, and no `AuditRecord` import. The construction site uses `monitoring::MonitoringAuditSink::new(monitoring_handle.clone())`.
- No dead code, no debugging artifacts, no scaffolding markers, no hardcoded secrets. Names are descriptive and follow project conventions. Function doc explains the "why" of the exhaustive `match`.
- No performance or security concerns introduced.
