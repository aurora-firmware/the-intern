---
id: T-118
title: Add optional cwd field to ScheduleEntry with absolute-path validation
status: completed
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

### Session 1 — 2026-07-05

Implemented T-118 end-to-end via four TDD cycles, all on `task/T-118-add-optional-cwd-field-to-scheduleentry-with-absolute-path-validation`.

Cycle 1 (AC-1): Added `cwd: Option<String>` to `ScheduleEntry` with `#[serde(default, skip_serializing_if = "Option::is_none")]`, updated the `with_prompt`/`with_file` constructors to set `cwd: None`, and added a `with_cwd(mut self, cwd) -> Self` builder that consumes and returns an entry (chains onto `with_prompt`/`with_file`, matching the task's "attach a cwd to a built entry" framing for T-124's future use). Wrote tests first (`with_cwd_sets_the_cwd_field_on_a_built_entry`, `entry_without_cwd_omits_cwd_key_when_serialised`, `round_trips_an_entry_with_cwd_through_json_store`) and confirmed a compile-error red state before adding the field/method. Also had to patch two pre-existing struct-literal tests in the same file (`validate_rejects_entry_setting_both_prompt_and_file`, `validate_rejects_entry_setting_neither_prompt_nor_file`) with `cwd: None` since the struct isn't `#[non_exhaustive]`.

Cycle 2 (AC-2/AC-3): Added a `cwd` check block in `validate_schedule_store` — blank cwd rejected with an entry-id-scoped message, relative cwd rejected the same way, mirroring the existing `file` absolute-path check exactly (same trim/absolute logic, same error-message style). Tests `validate_accepts_an_entry_with_an_absolute_cwd`, `validate_rejects_a_relative_cwd_and_names_the_entry_id`, `validate_rejects_a_blank_cwd` were written first and confirmed failing (assertion panics, not compile errors, since the field already existed from cycle 1) before adding the validation block. Updated the `validate_schedule_store` and `ScheduleEntry` doc comments to describe the new invariant.

Cycle 3 (AC-4): Wrote `read_schedule_store_parses_entries_written_before_cwd_existed`, seeding a hand-written JSON store with no `cwd` key and asserting version stays `1` and the loaded entry's `cwd` is `None`. This test passed immediately — the `#[serde(default)]` attribute from cycle 1 already provides full backward compatibility. Per the tdd skill's guidance for a test that passes on first run, kept it (it is not tautological — it locks in real, load-bearing behavior against regression) and committed it as a standalone test-only commit rather than manufacturing artificial failure.

Cycle 4 (mechanical `dispatch.rs` fix): Confirmed `cargo build -p admin-rpc -p bob` failed with `E0063: missing field cwd` at the one `ScheduleEntry { .. }` literal in `schedule.add`'s handler (~line 682), exactly as flagged in the task description. Added `cwd: None` there; build went green. This is explicitly a placeholder per the task — T-124 will replace it with real `with_cwd` wiring once the CLI/RPC `cwd` parameter exists.

Verification: ran the task's exact command (`cargo test -p bob-core schedule && cargo build -p admin-rpc -p bob`) after every cycle, and `cargo test --workspace` at the end — all green, no regressions in `scheduler-adapter`, `admin-rpc`, `bob`, or any other crate. `cargo fmt --all -- --check` is clean.

Nothing was tried and rejected beyond the initial API-shape question for `with_cwd` (constructor-style `with_cwd(id, cron, cwd)` vs. builder-style `.with_cwd(cwd)` chained onto an existing entry) — chose the builder form because the task explicitly says "attach a cwd to a built entry," which only the chained/consuming-`self` form satisfies naturally.

Nothing remains for T-118 itself. Follow-on tasks (T-124 for the real `--cwd`/`schedule.add` wiring, T-127 for the fire-time missing-directory skip+warn, T-125/T-126/T-129/T-130 per the spec's changelog) depend on this field and validation and can now proceed.

**Obstacles Encountered:** Adding the `cwd` field turned `ScheduleEntry`'s two struct literals inside `schedule.rs`'s own test module into compile errors (non-exhaustive literal construction), which needed `cwd: None` added — a small, in-scope consequence of the field addition, not a boundary violation. AC-4 turned out to already hold as a natural consequence of the `#[serde(default, skip_serializing_if = "Option::is_none")]` attribute added in cycle 1 — the test for it passed immediately rather than failing first; kept it as a regression lock per the tdd skill's guidance rather than forcing an artificial red state.

## Review

### Review Verdict — 2026-07-05

PASS

**Stage 1 — Acceptance Criteria**

- AC-1 (optional `cwd`, omitted when unset): Met. `ScheduleEntry.cwd: Option<String>` carries `#[serde(default, skip_serializing_if = "Option::is_none")]` (`schedule.rs:492-493`); `entry_without_cwd_omits_cwd_key_when_serialised` confirms the key is absent on write.
- AC-2 (accept only non-blank absolute `cwd` when present): Met. `validate_schedule_store` adds an `if let Some(cwd) = entry.cwd...` block (`schedule.rs:138-152`) that mirrors the existing `file` absolute-path check exactly; `validate_accepts_an_entry_with_an_absolute_cwd` passes.
- AC-3 (reject whole store, error names the entry id, for blank/relative `cwd`): Met. Both the blank and relative branches format `entry.id` into the `ServiceError::Configuration` detail (`schedule.rs:141`, `147`); `validate_rejects_a_relative_cwd_and_names_the_entry_id` asserts the id and the path-problem wording appear in the message, `validate_rejects_a_blank_cwd` asserts the blank case is rejected with the correct error variant.
- AC-4 (backward-compatible load, version stays 1): Met. `read_schedule_store_parses_entries_written_before_cwd_existed` seeds a hand-written v1 JSON store with no `cwd` key, asserts version stays `1`, and asserts the loaded entry's `cwd` is `None`.
- `with_cwd` setter for T-124: Present as a builder (`mut self -> Self`) on `ScheduleEntry`, matching the task's "attach a cwd to a built entry" framing; covered by `with_cwd_sets_the_cwd_field_on_a_built_entry`.
- `dispatch.rs` mechanical fix: The one `ScheduleEntry { .. }` struct literal in `schedule.add`'s handler (~line 682) now sets `cwd: None`, exactly as scoped — no other wiring added, consistent with T-124 owning the real `--cwd` plumbing.
- Files touched match the task's "Files to Touch" list exactly (`bob-core/src/types/schedule.rs`, `admin-rpc/src/dispatch.rs`); no unspecified files or behavior.

**Stage 2 — Code Quality**

- Correctness: validation block correctly trims, checks blank, then checks `Path::is_absolute`, in the same order/style as the existing `file` check; no directory-existence check was added (correctly deferred to T-127).
- Tests: six new tests cover the builder, serialization omission, both validation failure paths (blank, relative) plus the identifying-error-message assertion, round-trip through the JSON store, and backward-compatible load of a pre-`cwd` store. Each test uses its own `tempfile::tempdir()`; no shared mutable state.
- Security: no secrets; `cwd` is validated (non-blank, absolute) before being trusted, matching the existing `file` field's treatment.
- Readability: descriptive test and error-message names; no dead code; doc comments for `validate_schedule_store` and `ScheduleEntry` updated to describe the new invariant.
- Performance: no additional loops or blocking calls; validation stays O(1) per entry.

**Verification performed by reviewer:**
- Checked out `task/T-118-add-optional-cwd-field-to-scheduleentry-with-absolute-path-validation` into a scratch worktree.
- `cargo test -p bob-core schedule` — 44 passed, 0 failed.
- `cargo build -p admin-rpc -p bob` — succeeds (the `dispatch.rs` struct-literal fix keeps the workspace compiling).
- `cargo test --workspace` — all crates green, no regressions.
- `cargo fmt --all -- --check` — clean.
- Confirmed via `grep -rn "ScheduleEntry {"` across the service tree that every struct-literal construction site (2 in `schedule.rs`'s own tests, 1 in `dispatch.rs`) was updated; no missed site.

No blocking issues found. Minor non-blocking observation: `validate_rejects_a_blank_cwd`'s assertion checks only the error variant, not that the message names the entry id (unlike its relative-path sibling test) — the implementation itself does include `entry.id` in the blank-cwd message, so this is a test-coverage nicety, not a defect.
