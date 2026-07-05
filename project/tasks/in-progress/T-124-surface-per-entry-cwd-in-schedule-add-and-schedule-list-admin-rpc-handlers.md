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

### Review Verdict — 2026-07-05

PASS

**Stage 1 — Acceptance Criteria** (branch `task/T-124-surface-per-entry-cwd-in-schedule-add-and-schedule-list-admin-rpc-handlers`, diff scoped to `crates/admin-rpc/src/dispatch.rs` only, no other files touched):

- AC-1 (met): `handle_schedule_add` parses an optional `cwd` param with the same trim/filter-blank style as `raw_prompt`/`raw_file`, then attaches it via `ScheduleEntry::with_cwd`. Absoluteness is enforced end-to-end because `write_and_reload` → `write_schedule_store` → `validate_schedule_store` (T-118/CR-005) runs before any disk write; a request with an absolute `cwd` succeeds and the entry is persisted with that `cwd`. Verified with `dispatch_schedule_add_with_absolute_cwd_persists_cwd_field` (reads the store back and asserts `job.cwd == Some("/srv/workspaces/a")`).
- AC-2 (met): A relative `cwd` is rejected before any write, since `validate_schedule_store` runs prior to serialization/rename in `write_schedule_store` and rejects the whole document (not just the bad entry) on the first invariant violation. Verified with `dispatch_schedule_add_with_relative_cwd_returns_error_and_writes_nothing`, which asserts a `DispatchOutcome::Err` with `error.data.reason` mentioning "relative"/"absolute", and separately re-reads the store to confirm the `bad-cwd-job` id was never persisted. Relying on the existing store-wide validation instead of adding a second, differently-shaped pre-check matches the task's explicit instruction to follow the existing `prompt`/`file` handling (which has no dedicated dispatcher-level pre-check either).
- AC-3 (met): `handle_schedule_list` gained `if let Some(cwd) = &e.cwd { obj.insert("cwd", ...) }`, mirroring the existing `prompt`/`file` conditional-insert pattern exactly. Verified with `dispatch_schedule_list_emits_cwd_field_when_set`.
- AC-4 (met): Same conditional-insert naturally omits the key when `cwd` is `None`. Verified with `dispatch_schedule_list_omits_cwd_field_when_unset`.
- No unspecified behavior was added (no directory-existence check, consistent with "fire-time concern" scoping in the description). Files to Touch scope respected — `git diff dev-agent..task/T-124-...` touches only `the-intern/service/crates/admin-rpc/src/dispatch.rs` (source + its inline tests); the task `.md` also differs between the two branches, but that is solely because the task branch was forked before the Work Log was committed to `dev-agent` (none of the branch's 3 commits touch the `.md` file) — not a scope violation.

**Stage 2 — Code Quality:**

- Correctness: `cwd` parsing follows the established trim/filter-blank idiom exactly; a blank `cwd` string is treated as absent, consistent with how blank `prompt`/`file` are already handled at the dispatcher layer (validation of non-blank-but-relative values still happens store-side). The struct-then-`with_cwd` construction is slightly more indirect than setting the field inline, but this is exactly what the task instructs ("attaches it ... via the T-118 `with_cwd` setter").
- Tests: `dispatch_schedule_add_with_absolute_cwd_persists_cwd_field`, `dispatch_schedule_add_with_relative_cwd_returns_error_and_writes_nothing`, `dispatch_schedule_list_emits_cwd_field_when_set`, and `dispatch_schedule_list_omits_cwd_field_when_unset` cover success and failure paths for all four ACs, each with its own isolated temp store/scheduler handle (no shared mutable state between tests).
- Security: `cwd` is validated as an absolute path before persistence (via the pre-existing `validate_schedule_store` invariant checks); JSON is built with `serde_json` macros, no string-built queries or injection surface; no secrets involved.
- Readability: new code carries a clear comment distinguishing `cwd` from the `prompt`/`file` mutual-exclusion block; test names are descriptive and annotated with the AC they cover; no dead code or commented-out blocks.
- Performance: conditional insert is O(1) per listed entry; no new loops, blocking calls, or resource leaks.

**Verification performed independently:**
- `cargo test -p admin-rpc` on the task branch: 109 passed, 0 failed (matches the Work Log).
- `cargo test --workspace` on the task branch: all crates green, 0 failed.
- `cargo fmt --all -- --check` on the task branch: clean.
- Read `validate_schedule_store` and `write_schedule_store` in `crates/bob-core/src/types/schedule.rs` to confirm the AC-1/AC-2 validation-before-write chain actually exists and behaves as the Work Log describes (not inferred from the diff alone).

No blocking issues found. Non-blocking observation: the store-level rejection mechanism for AC-2 reuses `write_and_reload`'s existing error mapping (`CODE_METHOD_NOT_FOUND` for what is semantically an invalid-request/persistence-validation failure); this pre-dates this task (shared with the `file` field) and is out of scope here, but may be worth a follow-up ticket if the response-code taxonomy is ever revisited.
