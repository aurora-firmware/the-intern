---
id: T-118
title: Add optional cwd field to ScheduleEntry with absolute-path validation
status: pending
priority: high
assigned-role: developer
created: '2026-07-05'
spec: S-009
---

# Add optional cwd field to ScheduleEntry with absolute-path validation

## Description

CR-005 adds an optional per-entry working directory to scheduled jobs. Extend
the schedule-store data model so an entry may carry a `cwd`. `ScheduleEntry`
(`crates/bob-core/src/types/schedule.rs`) already has `prompt`/`file`; add an
optional `cwd: Option<String>` that is skipped from serialization when unset,
and extend `validate_schedule_store` so that when `cwd` is present it must be a
non-blank absolute path (`std::path::Path::is_absolute`), mirroring the existing
absolute-`file` rule. Do **not** check directory existence — that is a fire-time
concern (T-127). The store version stays `1`; stores written before `cwd`
existed must still load unchanged (the field is optional). Provide a `with_cwd`
setter/constructor so `admin-rpc` (T-124) can attach a cwd to a built entry.
`ScheduleEntry` is a plain (non-`#[non_exhaustive]`) struct with a full struct
literal at `crates/admin-rpc/src/dispatch.rs` (~line 682); set `cwd: None` at
that one site so the workspace keeps compiling (T-124 replaces it with the real
`with_cwd` wiring).

## Acceptance Criteria

AC-1: The system shall represent a schedule entry's working directory as an
      optional `cwd` string that is omitted from serialized output when unset.
AC-2: WHEN `validate_schedule_store` processes an entry whose `cwd` is present
      THE SYSTEM SHALL accept the entry only if `cwd` is a non-blank absolute
      path.
AC-3: IF an entry's `cwd` is present but relative or blank THEN THE SYSTEM SHALL
      reject the whole store with a clear error identifying the entry id.
AC-4: WHILE loading a schedule store written without a `cwd` key THE SYSTEM SHALL
      parse every entry with `cwd` unset and keep the store version at `1`.

## Dependencies

- None

## Files to Touch

- `crates/bob-core/src/types/schedule.rs` — add optional `cwd` field, a
  `with_cwd` setter/constructor, and absolute-path validation in
  `validate_schedule_store`
- `crates/admin-rpc/src/dispatch.rs` — keep the `ScheduleEntry { .. }` struct
  literal (~line 682) compiling by setting `cwd: None` at that one site
  (mechanical; T-124 replaces it with the real `with_cwd` wiring)

## Verification

```bash
cd the-intern/service && cargo test -p bob-core schedule && cargo build -p admin-rpc -p bob
```

## Work Log

## Review
