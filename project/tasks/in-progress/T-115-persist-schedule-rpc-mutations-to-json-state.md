---
id: T-115
title: Persist schedule RPC mutations to JSON state
status: pending
priority: high
assigned-role: unassigned
created: '2026-06-30'
---

# Persist schedule RPC mutations to JSON state

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

Update the `schedule.add`, `schedule.remove`, `schedule.list`, and
`schedule.reload` admin-RPC path so runtime schedule mutations persist to the
ADR-012 JSON schedule store instead of rewriting `config.toml`.

The existing concurrency lock, cron validation, duplicate-id checks, and live
reload behavior should remain. `schedule.add` and `schedule.remove` must read
the JSON store, modify the whole entry set, write it atomically using the core
helper from T-113, then reload the scheduler actor. `schedule.reload` must
re-read the JSON store so direct authorized file edits can be applied.

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

AC-1: WHEN `schedule.add` succeeds THE SYSTEM SHALL persist the new job to
      `schedules.json` and reload the scheduler actor with the full updated job
      table.
AC-2: WHEN `schedule.remove` succeeds THE SYSTEM SHALL remove the job from
      `schedules.json` and reload the scheduler actor with the full updated job
      table.
AC-3: WHEN `schedule.reload` succeeds THE SYSTEM SHALL re-read `schedules.json`
      and replace the scheduler actor's live job table with that file's
      entries.
AC-4: IF a schedule mutation would create a duplicate id, remove a missing id,
      or write an invalid cron expression THEN THE SYSTEM SHALL return the same
      typed invalid-request errors as the current RPC surface.
AC-5: WHILE concurrent schedule mutations are in flight THE SYSTEM SHALL
      serialize the read-modify-write-reload sequence so updates are not lost.

## Dependencies

- `T-113` — JSON schedule-store read/write helpers.
- `T-114` — `BobConfig` exposes the resolved schedule-store path and startup
  loads JSON schedule entries.

## Files to Touch

- `the-intern/service/crates/admin-rpc/src/lib.rs` — rename/configure the
  schedule persistence path from config path to schedule-store path.
- `the-intern/service/crates/admin-rpc/src/dispatch.rs` — update schedule RPC
  handlers to read/write/reload `schedules.json`.
- `the-intern/service/crates/bob/src/serve.rs` — pass the resolved
  schedule-store path into admin-RPC.

## Verification

```bash
cd the-intern/service && cargo test -p admin-rpc -p bob serve::tests
```

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

### Session 1 — 2026-06-30

**TDD Cycle 1 — Red/Green/Refactor**

All five acceptance criteria implemented in a single TDD cycle.

**Red phase:** Added test `dispatch_schedule_add_with_schedule_store_path_persists_entry_to_json_store` that calls `.with_schedule_store_path()` and verifies the JSON store is written. Confirmed it failed to compile because `with_schedule_store_path` did not yet exist.

**Green phase — structural changes:**

- `admin-rpc/Cargo.toml`: removed the `toml = "0.8"` dependency. It was only used by `load_schedule_entries_from_config` which we replaced.
- `admin-rpc/src/lib.rs`: renamed `Config.config_path` → `schedule_store_path`; updated `start()` to call `dispatcher.with_schedule_store_path(p)` instead of `with_config_path`.
- `admin-rpc/src/dispatch.rs`:
  - Renamed `Dispatcher.config_path` → `schedule_store_path`.
  - Removed `with_config_path()`; added `with_schedule_store_path()`.
  - Replaced `load_schedule_entries_from_config()` (parsed TOML config) with `load_schedule_entries_from_store()` (calls `bob_core::types::schedule::read_schedule_store`). The new helper is simpler because `read_schedule_store` already handles the "missing file = empty Vec" case.
  - Updated `write_and_reload()` to call `bob_core::types::schedule::write_schedule_store` for atomic JSON writes.
  - Updated `schedule_handles()` and all three handler methods (`handle_schedule_add`, `handle_schedule_remove`, `handle_schedule_reload`) to use `schedule_store_path`. Error messages updated to say "schedule store" instead of "config path".
  - `BobConfig::config_path` is NOT touched — it remains for policy-control hot-reload; only the admin-rpc `Config` field changed.
- `bob/src/serve.rs`: updated `try_start_subsystems()` to populate `admin_rpc::Config { schedule_store_path }` from `cfg.schedule_store_path` (skipping the empty-path sentinel from `BobConfig::test_base()`).
- Updated all 7 existing schedule tests that used `with_config_path` and TOML fixtures to use `with_schedule_store_path` and JSON store helpers (`write_temp_schedule_store`, `temp_schedule_store_path`). Updated `dispatch_schedule_add_config_parse_error_preserves_request_id` to write malformed JSON and assert the new error message `"failed to read schedule store"`.
- `cargo fmt --all` applied.

**Decisions:**

- AC-5 (concurrency lock) required no changes — `schedule_write_lock: Arc<Mutex<()>>` was already in place and locked in `handle_schedule_add` and `handle_schedule_remove`; it was preserved unchanged.
- Chose to keep `write_temp_bob_toml` replaced by two helpers (`temp_schedule_store_path` for empty/missing-file cases, `write_temp_schedule_store` for pre-populated cases) because the semantics are meaningfully different and separate names make the intent clear.

**Outcome:** All workspace tests pass (zero failures across 20+ test suites). Format check passes. Committed as `feat(admin-rpc): persist schedule mutations to JSON store (T-115)` (`7199a03`) on branch `task/T-115-persist-schedule-rpc-mutations-to-json-state`.

**Reviewer attention:**
- The `BobConfig.config_path` field in `bob/src/config.rs` is intentionally unchanged — it serves the policy-control hot-reload path and is unrelated to the schedule store.
- `serve.rs` skips injecting the store path when `cfg.schedule_store_path.as_os_str().is_empty()` (the `test_base()` sentinel); in production this path is always non-empty because `BobConfig::build()` resolves it from XDG_STATE_HOME.

_Loop note: the Developer originally committed this Work Log and a stray `completed/` copy of the task file on the task branch (commit `4540185`); that lifecycle commit was reset off the source branch and the Work Log was re-recorded here on `dev-agent` per the git model._

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->
