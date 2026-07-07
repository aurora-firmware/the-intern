---
id: T-123
title: Add optional resolved working-directory field to the event audit payload
status: pending
priority: medium
assigned-role: developer
created: '2026-07-05'
spec: S-005
---

# Add optional resolved working-directory field to the event audit payload

## Description

S-005 amendment: the event audit payload records the resolved working directory
for scheduled firings. Extend `ExtensionEventAuditPayload`
(`crates/bob-core/src/types/records.rs`) with an **optional** resolved
working-directory field annotated `#[serde(default, skip_serializing_if =
"Option::is_none")]` — `default` is required because the payload uses
`#[serde(deny_unknown_fields)]`, so existing JSONL audit records written without
the field must still deserialize. Do **not** add a new audit record kind — the
set stays `event`/`report`/`verdict`, and `report`/`verdict` payloads are
unchanged. This task adds only the model field; population for `periodic` firings
happens in T-128.

`ExtensionEventAuditPayload` is a plain struct built by full struct literals, so
every construction site must set the new field (mechanically `None`), otherwise
the workspace will not compile. One site is production —
`crates/extension-ipc/src/multiplex.rs` (~109); the other four are in
`#[cfg(test)]` modules — `crates/monitoring/src/lib.rs` (~255),
`crates/admin-rpc/src/lib.rs` (~1183/1266/1405), `crates/bob/src/serve.rs`
(~1257). Because four sites are test-only, verification MUST be `cargo test
--workspace` (a plain `cargo build` never compiles `#[cfg(test)]` code and would
false-green this task). (Optional: add an `ExtensionEventAuditPayload::new(name,
summary)` constructor that defaults the field to `None` and route sites through
it, to reduce future churn — the Developer's choice.)

## Acceptance Criteria

AC-1: The event audit payload shall include an optional resolved
      working-directory field, `#[serde(default, skip_serializing_if)]`, omitted
      from serialized output when absent.
AC-2: WHILE an event has no execution directory THE SYSTEM SHALL omit the field
      and keep the record a valid `event` record that still deserializes older
      records lacking the field.
AC-3: The system shall keep the audit record-kind set as
      `event`/`report`/`verdict` with `report` and `verdict` payloads unchanged.

## Dependencies

- `T-121` — ordering-only: both edit `crates/bob/src/serve.rs`; T-121 lands its
  serve.rs change first (no logical dependency, avoids a same-file conflict)

## Files to Touch

- `crates/bob-core/src/types/records.rs` — add the optional resolved-cwd field
- `crates/extension-ipc/src/multiplex.rs` — set the field (`None`) at the
  production construction site (~109)
- `crates/monitoring/src/lib.rs` — set the field at the test construction site (~255)
- `crates/admin-rpc/src/lib.rs` — set the field at the test construction sites
  (~1183/1266/1405)
- `crates/bob/src/serve.rs` — set the field at the test construction site (~1257)

## Verification

```bash
cd the-intern/service && cargo test --workspace
```

## Work Log

## Review
