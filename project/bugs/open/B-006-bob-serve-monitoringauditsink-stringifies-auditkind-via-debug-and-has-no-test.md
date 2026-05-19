---
id: B-006
title: bob serve MonitoringAuditSink stringifies AuditKind via Debug and has no 
  test
severity: medium
status: open
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
- For PASS: brief confirmation that diagnosis, fix, verification, and code quality passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->
