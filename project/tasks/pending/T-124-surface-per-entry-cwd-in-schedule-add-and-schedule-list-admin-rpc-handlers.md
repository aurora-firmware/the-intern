---
id: T-124
title: Surface per-entry cwd in schedule.add and schedule.list admin-RPC 
  handlers
status: pending
priority: high
assigned-role: developer
created: '2026-07-05'
spec: S-009
---

# Surface per-entry cwd in schedule.add and schedule.list admin-RPC handlers

## Description

Add the optional `cwd` parameter to the scheduler admin-RPC methods
(`crates/admin-rpc/src/dispatch.rs`). `handle_schedule_add` accepts an optional
`cwd` param, validates it is an **absolute** path before the store is written
(rejecting a relative value with a clear error and writing nothing), and attaches
it to the built `ScheduleEntry` via the T-118 `with_cwd` setter.
`handle_schedule_list` includes each entry's `cwd` in its response when set and
omits it otherwise. Follow the existing `prompt`/`file` parameter handling in the
same handlers. Existence of the directory is not checked here (fire-time concern).

## Acceptance Criteria

AC-1: WHEN `schedule.add` is called with a `cwd` parameter THE SYSTEM SHALL
      validate it is an absolute path and persist it on the created entry.
AC-2: IF a `schedule.add` `cwd` parameter is present but not absolute THEN THE
      SYSTEM SHALL reject the request with a clear error and write nothing to the
      store.
AC-3: WHEN `schedule.list` returns an entry that has a `cwd` THE SYSTEM SHALL
      include that `cwd` in the response.
AC-4: WHERE a listed entry has no `cwd` THE SYSTEM SHALL omit the `cwd` field for
      that entry.

## Dependencies

- `T-118` — `ScheduleEntry.cwd` field, `with_cwd` setter, and validation

## Files to Touch

- `crates/admin-rpc/src/dispatch.rs` — `cwd` param in `handle_schedule_add`
  (absolute validation) and `cwd` output in `handle_schedule_list`

## Verification

```bash
cd the-intern/service && cargo test -p admin-rpc
```

## Work Log

## Review
