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

### Session 1 — 2026-07-05

Implemented T-124 via three TDD cycles, all on `task/T-124-surface-per-entry-cwd-in-schedule-add-and-schedule-list-admin-rpc-handlers`, touching only `crates/admin-rpc/src/dispatch.rs` as scoped.

Cycle 1 (AC-1): Wrote `dispatch_schedule_add_with_absolute_cwd_persists_cwd_field`, confirmed it failed (`cwd` was `None` after add), then added `raw_cwd` parsing in `handle_schedule_add` following the exact trim/filter-blank style already used for `raw_prompt`/`raw_file`, and attached it to the newly built `ScheduleEntry` via the T-118 `with_cwd` setter (as the task explicitly directs) rather than setting the field directly. Full `admin-rpc` suite green (106 tests) after.

Cycle 2 (AC-3/AC-4): Wrote both the "emits cwd when set" and "omits cwd when unset" tests together since they're two sides of one conditional-insert change in `handle_schedule_list`. The "emits" test failed as expected (`cwd` came back `Null`); the "omits" test passed trivially before implementation (there was no cwd emission at all yet), which is expected for a negative assertion on unimplemented behavior — kept it since it guards against regressions in the follow-up change. Implemented a one-line conditional insert (`if let Some(cwd) = &e.cwd { obj.insert("cwd", ...) }`) mirroring the existing `prompt`/`file` pattern. Suite green (108 tests) after.

Cycle 3 (AC-2): Wrote `dispatch_schedule_add_with_relative_cwd_returns_error_and_writes_nothing`, expecting to see it fail before any dedicated validation. It passed immediately with no further production code change: `write_and_reload` calls `write_schedule_store`, which calls T-118's `validate_schedule_store` before ever touching disk, and that function already rejects a relative (or blank) `cwd` for any entry in the store — including the one just appended by `handle_schedule_add`. This is the same mechanism that already (implicitly, with no dedicated dispatcher-level check) enforces the `file` field's absolute-path requirement, so relying on it for `cwd` is consistent with the task's instruction to "follow the existing prompt/file parameter handling in the same handlers" rather than adding a redundant pre-check with a different code/message shape. Verified this wasn't a false-positive by confirming the test's assertions (`error.data` present, `reason` containing "relative"/"absolute") actually exercised the `DispatchOutcome::Err` branch rather than a panic being silently absorbed. Kept the test as the regression guard for AC-2 and committed it as a test-only commit.

Rejected approaches: considered adding an explicit `Path::new(cwd).is_absolute()` pre-check inside `handle_schedule_add` before the cron-parse step (mirroring the pattern used for cron validation), but rejected it because (a) the task explicitly says to follow existing `prompt`/`file` handling, and the `file` field has no such pre-check today — it also relies solely on `validate_schedule_store` at write time; (b) adding a second, differently-worded validation path for the same invariant would create two error shapes for what is the same underlying rule and add untested drift risk between the dispatcher and `bob-core`'s schedule module.

Nothing remains for this task; all four acceptance criteria have passing tests, `cargo test -p admin-rpc` (109 tests) and `cargo test --workspace` are both green, and `cargo fmt --all -- --check` is clean.

**Obstacles Encountered:** The AC-2 test (relative `cwd` rejected, nothing written) passed on first run without any additional production code change, because attaching the raw `cwd` value via `with_cwd` in cycle 1 already flows into `write_schedule_store`'s pre-write call to `validate_schedule_store` (T-118), which rejects relative/blank `cwd` before any disk write occurs — the same mechanism that already (implicitly) enforces the `file` field's absolute-path rule in this handler. Per the tdd skill's guidance, kept the test as a regression guard for AC-2 rather than adding a redundant pre-check, since the task explicitly instructs to "follow the existing prompt/file parameter handling in the same handlers."

## Review
