---
id: B-020
title: Remove legacy TOML write_schedule_entries schedule-store writer (dead 
  code, would not persist cwd)
severity: low
status: in-progress
created: '2026-07-05'
---

# Remove legacy TOML write_schedule_entries schedule-store writer (dead code, would not persist cwd)

## Summary

`write_schedule_entries` (`crates/bob-core/src/types/schedule.rs`, ~line 526)
writes the schedule store as a TOML `[[schedule]]` array — the pre-ADR-012 model.
ADR-012/S-009 mandate a versioned JSON store, and the live persistence path
already uses the JSON writer `write_schedule_store` (schedule.rs ~338). The TOML
writer is dead code: it is reachable only via a `pub use` re-export
(`crates/bob/src/config.rs` ~744) and stale T-097 tests, with no production
caller. It is a latent trap — being hand-rolled TOML, it does not serialize the
serde-derived `ScheduleEntry`, so it would silently omit newer optional fields
(e.g. the CR-005 `cwd`, and already `file`). This was surfaced during the CR-005
Gate 2 preflight as a pre-existing divergence, out of CR-005 scope.

## Reproduction Status

Status: confirmed (static — verified dead code, not a runtime failure)

The live write path (`write_schedule_store`) is JSON and ADR-012-compliant;
`write_schedule_entries` has no production caller.

## Evidence

- Live JSON writer: `crates/bob-core/src/types/schedule.rs` ~338
  (`write_schedule_store`, `serde_json::to_string_pretty` of `{version, entries}`),
  called from `admin-rpc` schedule.add/remove, config load, and the e2e suite.
- Legacy TOML writer: `crates/bob-core/src/types/schedule.rs` ~526
  (`write_schedule_entries`, emits `[[schedule]]`), reachable only from the
  `pub use` re-export in `crates/bob/src/config.rs` ~744 and stale T-097 tests.
- Verified by the Architect during CR-005 Gate 2 preflight (2026-07-05).

## Expected Behavior

Only one schedule-store serialization path exists (the ADR-012 JSON writer), so
every serde-derived `ScheduleEntry` field is persisted; no dead TOML writer can
silently drop fields.

## Actual Behavior

Two writers coexist. The unused `write_schedule_entries` TOML writer would omit
serde-only fields (`file`, `cwd`) if ever called, and its stale tests still
exercise the retired `[[schedule]]` shape.

## Related

- Change request: `CR-005` (surfaced during its Gate 2 preflight)
- Specification: `S-009-scheduler-channel-adapter-and-bob-schedule-cli.md`
- Decision: `ADR-012-scheduler-admission-uses-unix-trust-boundary-and-json-state.md`

## Suspected Area

`crates/bob-core/src/types/schedule.rs` (`write_schedule_entries` and its tests);
the `pub use` re-export in `crates/bob/src/config.rs`.

## Fix Verification

```bash
cd the-intern/service && cargo test --workspace && cargo build -p bob
```

## Diagnosis Log

### Diagnosis Log — 2026-07-07

**Reproduction status:** Confirmed (static + empirical). This is a dead-code /
latent-defect bug, not a runtime failure, so "reproduction" means demonstrating
(a) the writer is unreachable from any production path and (b) it would drop
`cwd` if it were ever invoked. Both are established below with certainty, not
just hypothesis.

**Evidence captured:**
- `grep -rn "write_schedule_entries" the-intern/service` → the only call sites
  are the definition (`crates/bob-core/src/types/schedule.rs:562`), its own
  5-test unit-test module in the same file, the `pub use` re-export at
  `crates/bob/src/config.rs:767`, and that re-export's own 3 stale T-097 tests
  in `config.rs`. No call from any non-test file in `crates/bob/src/` or
  `crates/admin-rpc/src/`.
- `grep -rn "write_schedule_store" the-intern/service` → production call
  sites are `crates/admin-rpc/src/dispatch.rs:936` and `:2063` (inside
  `write_and_reload`, which backs the live `schedule.add`/`schedule.remove`
  admin-rpc handlers), plus `crates/bob/src/config.rs:1500` (config-load test
  helper) and `crates/bob/tests/scheduler_execution_e2e.rs:121` (e2e suite).
  Read `dispatch.rs:905-945` directly: `write_and_reload` calls
  `bob_core::types::schedule::write_schedule_store` (JSON) exclusively.
- Read `schedule.rs:562-652` (`write_schedule_entries` body): the per-entry
  TOML table-building loop (~lines 582-593) inserts only `id`, `cron`,
  `prompt`, `file` — `entry.cwd` is never read anywhere in the function.
  `ScheduleEntry` (line 484-494) has carried `cwd: Option<String>` since
  CR-005/T-118; `write_schedule_store`'s serde-JSON serialization (line
  356-368) already handles it automatically via
  `#[serde(skip_serializing_if = "Option::is_none")]`, but the hand-rolled
  TOML writer has no equivalent line.
- Added a temporary unit test (`diagnosis_temp_write_schedule_entries_drops_cwd_field`)
  to `schedule.rs`'s test module: called `write_schedule_entries` with a
  `with_cwd("/srv/work")` entry and asserted the written TOML has no `cwd`
  substring. `cargo test -p bob-core diagnosis_temp_write_schedule_entries_drops_cwd_field`
  → 1 passed, confirming the field is silently dropped. Removed via
  `git checkout -- crates/bob-core/src/types/schedule.rs` immediately after
  (working tree confirmed clean via `git status --porcelain` / `git diff --stat`,
  both empty — no diagnostic artifacts remain).
- Baseline `cargo test -p bob-core schedule` → 44 passed, 0 failed.
- Baseline `cargo test -p bob write_schedule_entries` → 3 passed, 0 failed
  (the stale T-097 `config.rs` tests).
- Baseline `cargo test --workspace` → all crates report `test result: ok`,
  0 failed, matching the bug's Fix Verification command.
- Baseline `cargo build -p bob` → finished cleanly.

**Isolated fault:**
`write_schedule_entries` (`crates/bob-core/src/types/schedule.rs:562-652`) —
specifically the table-building loop at lines ~582-593, which omits any
`entry.cwd` handling. The function is dead code: its only caller is the
`pub use` re-export at `crates/bob/src/config.rs:767`, which itself has no
production caller — only its own 3 stale T-097 tests (`config.rs:1765-1841`)
and the 5 stale tests colocated with the writer in `schedule.rs`
(`persists_entries_and_can_be_read_back`, `creates_missing_parent_directories`,
`preserves_other_config_keys`, `empty_entries_removes_schedule_section`,
`preserves_restrictive_file_mode`).

**Root cause:**
`write_schedule_entries` predates ADR-012/S-009's versioned JSON schedule
store and was superseded by `write_schedule_store`, but was never deleted
when the JSON writer became the sole production path. Because it hand-rolls
TOML serialization field-by-field instead of deriving it from `ScheduleEntry`
via serde, it silently diverges from the struct whenever a new optional field
(`file`, and now `cwd`) is added — the struct changes, but nothing forces the
manual TOML-writing code to change with it. It currently persists as inert
dead code reachable only through its own re-export and stale tests, but
remains a latent trap should anything ever call it (directly or via the
re-export) or should a future refactor reintroduce a call site.

**Planned fix:**
1. Delete `write_schedule_entries` (`crates/bob-core/src/types/schedule.rs:538-652`,
   including its doc comment).
2. Delete the `pub use bob_core::types::schedule::write_schedule_entries;`
   re-export and its doc comment (`crates/bob/src/config.rs:762-767`).
3. Delete the 8 stale T-097 tests exercising the removed writer: 5 in
   `schedule.rs`'s test module (`persists_entries_and_can_be_read_back`,
   `creates_missing_parent_directories`, `preserves_other_config_keys`,
   `empty_entries_removes_schedule_section`, `preserves_restrictive_file_mode`)
   and 3 in `config.rs`'s test module
   (`write_schedule_entries_persists_entries_and_can_be_read_back`,
   `write_schedule_entries_preserves_other_config_keys`,
   `write_schedule_entries_with_empty_entries_removes_schedule_section`),
   along with their now-orphaned `T-097` comment banners.
4. Remove `write_schedule_entries` from the `use super::{...}` import list in
   `schedule.rs`'s test module (line ~657) and drop the `toml_edit` import if
   it becomes otherwise unused in that crate (confirm with a workspace grep
   before removing the dependency from `Cargo.toml`).
5. Re-grep the workspace for `write_schedule_entries` after deletion to
   confirm zero remaining references.

**Planned verification:**
`cd the-intern/service && cargo test --workspace && cargo build -p bob` (the
bug's specified Fix Verification command) must pass with 0 failures and a
clean build, with the total test count reduced by exactly 8 (the deleted
stale tests) and no new failures introduced. Additionally, a
`grep -rn "write_schedule_entries" the-intern/service` after the fix must
return no matches, confirming the dead writer and every reference to it are
fully removed.

## Work Log

## Review
