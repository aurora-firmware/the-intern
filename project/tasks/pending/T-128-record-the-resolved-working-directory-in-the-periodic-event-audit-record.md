---
id: T-128
title: Record the resolved working directory in the periodic event audit record
status: pending
priority: medium
assigned-role: developer
created: '2026-07-05'
spec: S-005
---

# Record the resolved working directory in the periodic event audit record

## Description

When a periodic firing's working directory is resolved at dispatch (T-127),
populate the event audit payload's resolved working-directory field (T-123) with
the **concrete absolute path used** — the value after precedence (per-entry `cwd`
→ `pi_agent_cwd` → inherited), not the raw per-entry field. Events with no
execution directory (for example forwarded pi-agent extension events) leave the
field unset. This touches the periodic dispatch/audit path in
`crates/bob/src/serve.rs`.

## Acceptance Criteria

AC-1: WHEN a `periodic` firing is dispatched and audited THE SYSTEM SHALL record
      the resolved absolute working directory used for that firing on the event
      audit record.
AC-2: The system shall record the concrete resolved path after precedence
      (per-entry `cwd` → `pi_agent_cwd` → inherited), not the raw per-entry field.

## Dependencies

- `T-127` — resolved cwd is computed at dispatch
- `T-123` — optional resolved-cwd field on the event audit payload

## Files to Touch

- `crates/bob/src/serve.rs` — populate the resolved cwd on the periodic event
  audit record

## Verification

```bash
cd the-intern/service && cargo test -p bob serve
```

## Work Log

## Review
