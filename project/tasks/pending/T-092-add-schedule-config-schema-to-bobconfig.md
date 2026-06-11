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
split in `config.rs` (raw = serde-deserialised from TOML; validated = what the
rest of the service sees). Validation rules:

- A missing or empty `[schedule]` section is valid — zero jobs.
- An entry with a blank `id`, blank `cron`, or blank `prompt` must be rejected
  by `BobConfig::load()` with a `ServiceError::Configuration` message naming
  the field and the offending entry.
- A valid cron expression is a 5-field standard cron string. Use the
  `cron` crate (add it to `crates/bob/Cargo.toml`) for parse-time validation.
  An invalid cron expression must be rejected at load time with a clear error;
  it must NOT silently produce zero jobs.

The `ScheduleEntry` type (id, cron string, prompt) must be `Clone` and
`Debug`. Expose `BobConfig::schedule` as `pub ScheduleConfig` containing
`pub entries: Vec<ScheduleEntry>`.

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

- `the-intern/service/crates/bob/src/config.rs` — add `ScheduleConfig`,
  `ScheduleEntry`, `RawScheduleConfig`, `RawScheduleEntry`; extend `BobConfig`
  with `pub schedule: ScheduleConfig`; wire into `load_with_sources`
- `the-intern/service/crates/bob/Cargo.toml` — add `cron` crate dependency

## Verification

```bash
cd the-intern/service
cargo test -p bob
```

## Work Log

## Review
