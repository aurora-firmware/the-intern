---
id: T-114
title: Load scheduler entries from JSON state at startup
status: pending
priority: high
assigned-role: unassigned
created: '2026-06-30'
---

# Load scheduler entries from JSON state at startup

<!--
Task Quality Rules (see the new-task skill for full details):
  - Atomic — one clear outcome.
  - One-shottable — ≤ 3–4 files touched, ≤ 5 ACs, Description ≈ 20 lines.
  - Verifiable — concrete Verification command or explicit manual steps.
  - Self-contained — Description is enough to start without follow-up questions.
  - EARS — every AC matches one of the five EARS patterns below.
  - Dependency-honest — list every prior task this one reads from or modifies.
-->

## Description

Wire the ADR-012 schedule-store path into `BobConfig` and startup. The scheduler
must load entries from persistent JSON state, not from `[[schedule]]` in
`config.toml`.

Add a resolved `schedule_store_path` using `$XDG_STATE_HOME/bob/schedules.json`
on Linux with fallback to `~/.local/state/bob/schedules.json`; keep test
overrides consistent with the existing XDG/runtime config helpers. At startup,
read that JSON store via the core helper from T-113 and pass those entries to
the scheduler actor. A missing schedule store means no jobs. `config.toml`
should no longer deserialize `[[schedule]]` as the authoritative source.

## Acceptance Criteria

<!-- EARS pattern reference. Every criterion must match one pattern:
  1. Ubiquitous            — The system shall [outcome]
  2. Event-driven          — WHEN [trigger] THE SYSTEM SHALL [outcome]
  3. Unwanted-behaviour    — IF [fault] THEN THE SYSTEM SHALL [outcome]
  4. State-driven          — WHILE [state] THE SYSTEM SHALL [outcome]
  5. Optional              — WHERE [feature included] THE SYSTEM SHALL [outcome]

Examples:
  AC-1: WHEN the user submits valid credentials THE SYSTEM SHALL
        redirect to /dashboard within 200ms.
  AC-2: IF the password is incorrect THEN THE SYSTEM SHALL return 401
        and display "Invalid credentials".
  AC-3: The system shall log every authentication attempt with user id
        and outcome.
-->

AC-1: WHEN `BobConfig::load()` runs without an explicit schedule-store override
      THE SYSTEM SHALL resolve the Linux default schedule store to
      `$XDG_STATE_HOME/bob/schedules.json` with the XDG fallback path when the
      environment variable is absent.
AC-2: WHEN `bob serve` starts THE SYSTEM SHALL initialize the scheduler adapter
      from `schedules.json` rather than from `[[schedule]]` in `config.toml`.
AC-3: IF the schedule store is missing THEN THE SYSTEM SHALL start with an empty
      scheduler job table.
AC-4: IF the schedule store exists but is malformed THEN THE SYSTEM SHALL fail
      startup with a configuration error.
AC-5: The system shall stop treating `[[schedule]]` in `config.toml` as the
      scheduler source of truth.

## Dependencies

- `T-113` — JSON schedule-store read/write helpers.

## Files to Touch

- `the-intern/service/crates/bob/src/config.rs` — add schedule-store path
  resolution and startup loading; remove or retire `[[schedule]]` config
  deserialization tests.
- `the-intern/service/crates/bob/src/serve.rs` — pass JSON-loaded schedule
  entries and schedule-store path through startup wiring.

## Verification

```bash
cd the-intern/service && cargo test -p bob config::tests serve::tests
```

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

### Session 1 — 2026-06-30

Implemented all five acceptance criteria in two red→green→refactor TDD cycles.

**Cycle 1 (AC-1)**: Added `schedule_store_path: PathBuf` to both `BobConfig` and `RawBobConfig`, added `default_schedule_store_path_for_env` (following the same XDG pattern used by the audit-log path), and computed the default in `defaults_with_runtime_root` so it participates in figment's layered override chain. The env var `BOB_SCHEDULE_STORE_PATH` and a `schedule_store_path` key in `config.toml` both override it automatically. Two AC-1 tests cover XDG_STATE_HOME presence and HOME fallback.

**Cycle 2 (AC-2/3/4/5)**: Replaced the `validate_schedule_entries` call in `load_with_sources` with a call to `bob_core::types::schedule::read_schedule_store`. A missing store returns `Ok(Vec::new())` (AC-3); malformed JSON returns `ServiceError::Configuration` which surfaces from `BobConfig::load()` before serve.rs runs (AC-4). Removed `RawScheduleEntry`, `validate_schedule_entries`, and the `schedule: Vec<RawScheduleEntry>` field from `RawBobConfig`; serde's default `#[derive(Deserialize)]` silently ignores unknown TOML fields, so any `[[schedule]]` section in `config.toml` is now ignored without error (AC-5). Retired six `[[schedule]]` TOML deserialization tests. Added five new tests: two AC-1 path-resolution tests, three AC-2/3/4 config-level tests, one AC-5 regression guard (verifying `[[schedule]]` in TOML is silently ignored), and one AC-2 serve-level wiring test confirming `cfg.schedule.entries` (now populated from the JSON store) reaches the scheduler adapter.

**Trade-off considered**: Loading in `load_with_sources` (config.rs) rather than in `try_start_subsystems` (serve.rs) ensures malformed-store errors are `ServiceError::Configuration` before any actor starts. The alternative (loading in serve.rs) would have wrapped the error in `ServiceError::ServiceDown`. Loading in config.rs is consistent with the existing pattern where config values are validated once at load time.

**Minor structural fix**: `shell_e2e.rs` builds `BobConfig` without the `..test_base()` shorthand and required a one-line addition for the new `schedule_store_path` field.

**What remains**: Admin-RPC's `schedule.*` methods still write to the TOML `config_path` (via `write_schedule_entries`). Wiring the JSON `schedule_store_path` to admin-RPC for persistent writes is deferred to T-115 — it requires modifying the `admin_rpc::Config` struct, which is out of this task's scope.

Verification note: the task's verification command must be run as two separate invocations with `--lib` — `cargo test -p bob --lib config::tests` (31 passed) and `cargo test -p bob --lib serve::tests` (32 passed); the combined single-command form does not resolve both filters. Full workspace green.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->

### Review Verdict — 2026-06-30

FAIL

**Stage 1 — Acceptance Criteria**

- AC-1 (XDG path resolution): PASS. `default_schedule_store_path_for_env` correctly resolves `$XDG_STATE_HOME/bob/schedules.json` with fallback to `$HOME/.local/state/bob/schedules.json`. Two dedicated tests pass.
- AC-2 (scheduler wired from JSON store): PASS. `BobConfig::load_with_sources` populates `cfg.schedule.entries` from `read_schedule_store`, and the serve-layer test `scheduler_adapter_is_initialized_with_schedule_entries_from_config` confirms those entries reach the scheduler adapter.
- AC-3 (missing store → empty table): PASS. `read_schedule_store` returns `Ok(Vec::new())` when the path does not exist; dedicated test `starts_with_empty_schedule_entries_when_json_store_is_missing` passes.
- AC-4 (malformed store → configuration error): PASS. `read_schedule_store` returns `ServiceError::Configuration` for invalid JSON; the `?` in `load_with_sources` surfaces it before any actor starts; test `returns_configuration_error_when_schedule_store_is_malformed` passes.
- AC-5 (`[[schedule]]` no longer source of truth): PASS in implementation. `RawScheduleEntry`, `validate_schedule_entries`, and the `schedule: Vec<RawScheduleEntry>` field are removed. The `schedule_section_in_config_toml_is_silently_ignored` regression guard passes.

Test results: `cargo test -p bob --lib config::tests` — 31 passed; `cargo test -p bob --lib serve::tests` — 32 passed; `cargo test --workspace` — all green.

**Stage 2 — Code Quality**

One blocking issue found.

**Issue 1 (blocking): Stale doc comment on `BobConfig::schedule` field**

- File: `the-intern/service/crates/bob/src/config.rs`, `BobConfig` struct, `schedule` field.
- What is wrong: The doc comment still reads "Schedule configuration sourced from the `[[schedule]]` TOML section." After T-114, entries are loaded from the JSON schedule store (`read_schedule_store`), not from any TOML section. The second line "An absent or empty section yields an empty entries vec (no jobs)." likewise refers to a TOML section that is no longer the source. This directly contradicts the task's own AC-5 and will mislead future readers about where schedule data originates.
- What should change: Update the doc comment to reflect that entries are now loaded from the JSON schedule store at `schedule_store_path`. For example: "Schedule entries loaded from the JSON schedule store at `schedule_store_path` during `BobConfig::load()`. A missing or empty store yields an empty entries vec (no jobs)."

**Non-blocking observation: Unused `croner` dependency in `Cargo.toml`**

- File: `the-intern/service/crates/bob/Cargo.toml`.
- What was found: `croner = "3"` remains listed but is no longer imported in any `.rs` file within the `bob` crate after `validate_schedule_entries` (its sole consumer) was removed. This will not cause a build or test failure (clippy is not yet a clean gate), but the dependency is now dead weight. Consider removing it as a cleanup alongside the doc-comment fix.
