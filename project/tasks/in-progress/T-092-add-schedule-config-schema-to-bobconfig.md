---
id: T-092
title: Add schedule config schema to BobConfig
status: pending
priority: high
assigned-role: developer
created: '2026-06-12'
spec: S-009
---

# Add schedule config schema to BobConfig

## Description

S-009 requires a `[schedule]` section in `bob.toml` holding zero or more named
cron jobs. Each job has a unique string `id`, a 5-field cron expression (`cron`),
and a non-empty `prompt` string. This task adds the config types and wires them
into `BobConfig` so the scheduler adapter (T-093) can read them at startup.

Follow the existing pattern: add a `RawScheduleConfig` / `ScheduleConfig`
split (raw = serde-deserialised from TOML; validated = what the rest of the
service sees). Validation rules:

- A missing or empty `[schedule]` section is valid — zero jobs.
- An entry with a blank `id`, blank `cron`, or blank `prompt` must be rejected
  by `BobConfig::load()` with a `ServiceError::Configuration` message naming
  the field and the offending entry.
- A valid cron expression is a 5-field standard cron string (`minute hour
  day-of-month month day-of-week`). Use the `croner` crate for parse-time
  validation — **not** the `cron` crate, which defaults to 6+ fields (adds a
  seconds field). Add `croner` to `crates/bob/Cargo.toml`. An invalid cron
  expression must be rejected at load time with a clear error; it must NOT
  silently produce zero jobs.

**`ScheduleEntry` placement:** Define `ScheduleEntry { id: String, cron:
String, prompt: String }` in `bob-core` (in
`crates/bob-core/src/types/mod.rs`, re-exported from there), **not** in
`bob/src/config.rs`. The scheduler-adapter crate (T-093) depends on
`bob-core` but must not depend on `bob` (circular). Placing `ScheduleEntry`
in `bob-core` makes it available to both crates without a cycle. The raw
deserialization type `RawScheduleEntry` stays in `bob/src/config.rs` and maps
to `ScheduleEntry` during validation. `ScheduleEntry` must derive `Clone`,
`Debug`, `serde::Serialize`, and `serde::Deserialize`.

Expose `BobConfig::schedule` as `pub ScheduleConfig` containing
`pub entries: Vec<bob_core::types::ScheduleEntry>`.

## Acceptance Criteria

AC-1: The system shall deserialise a `bob.toml` containing a valid `[[schedule]]`
      entry with `id`, `cron`, and `prompt` fields into a `BobConfig` with one
      matching `ScheduleEntry`.

AC-2: WHEN `BobConfig::load()` encounters a `[[schedule]]` entry with an
      invalid 5-field cron expression THE SYSTEM SHALL return a
      `ServiceError::Configuration` error whose message names the bad field.

AC-3: IF a `[[schedule]]` entry has a blank `id`, `cron`, or `prompt` THEN
      THE SYSTEM SHALL return `ServiceError::Configuration` and refuse to start.

AC-4: WHEN `bob.toml` contains no `[schedule]` section THE SYSTEM SHALL
      produce a `BobConfig` with an empty `schedule.entries` vec.

AC-5: The system shall pass `cargo test -p bob` with no new failures.

## Dependencies

- None

## Files to Touch

- `the-intern/service/crates/bob-core/src/types/mod.rs` — add `ScheduleEntry`
  (the validated domain type; re-export it from the `types` module)
- `the-intern/service/crates/bob/src/config.rs` — add `ScheduleConfig`,
  `RawScheduleConfig`, `RawScheduleEntry`; extend `BobConfig` with
  `pub schedule: ScheduleConfig`; wire into `load_with_sources`; validate
  cron strings via `croner`
- `the-intern/service/crates/bob/Cargo.toml` — add `croner` crate dependency

## Verification

```bash
cd the-intern/service
cargo test -p bob
```

## Work Log

### Session 1 — 2026-06-12

**What was done**

Implemented the full T-092 acceptance criteria in a single TDD cycle.

1. Added `croner = "3"` to `crates/bob/Cargo.toml`. Used `CronParser::builder().seconds(Seconds::Disallowed).build()` to enforce exactly 5 fields (croner's default parser accepts optional seconds, so the builder was necessary).

2. Created `crates/bob-core/src/types/schedule.rs` with `ScheduleEntry { id, cron, prompt }` deriving `Clone`, `Debug`, `Serialize`, `Deserialize`. Re-exported it from the `types` module.

3. In `crates/bob/src/config.rs`:
   - Added `RawScheduleEntry` (serde-deserialized from TOML, all fields optional with `#[serde(default)]`).
   - Added `ScheduleConfig { pub entries: Vec<ScheduleEntry> }` (public validated type).
   - Extended `BobConfig` with `pub schedule: ScheduleConfig`.
   - Added `validate_schedule_entries()` which checks for blank id/cron/prompt and invalid cron expressions, returning `ServiceError::Configuration` with a message naming the offending field.
   - Wired validation into `load_with_sources` and updated `defaults_with_runtime_root` and `test_base()`.
   - Added 6 tests covering AC-1 through AC-4 (including 3 blank-field sub-cases for AC-3).

4. Updated `tests/chat_e2e.rs` and `tests/shell_e2e.rs` — both used literal `BobConfig { ... }` struct syntax and needed `schedule: ScheduleConfig { entries: vec![] }` added.

**What was tried and rejected**

- Initially drafted `RawScheduleConfig { entries: Vec<RawScheduleEntry> }` as a TOML section wrapper. Rejected because `[[schedule]]` TOML maps directly to `Vec<RawScheduleEntry>` on `RawBobConfig` without a wrapper.

**What remains**

Nothing. All acceptance criteria are met and all tests pass.

**Obstacles Encountered**

- Two integration test files (`chat_e2e.rs`, `shell_e2e.rs`) used literal `BobConfig { ... }` struct syntax and needed the `schedule` field added.
- `croner` v3's default `CronParser` accepts optional seconds (5 or 6 fields); used `CronParser::builder().seconds(Seconds::Disallowed).build()` to enforce exactly 5-field cron expressions.

**Final branch state:** committed, clean, all tests passing (117 tests, 0 failures)

## Review
