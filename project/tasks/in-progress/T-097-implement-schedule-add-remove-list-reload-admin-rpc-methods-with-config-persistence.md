---
id: T-097
title: Implement schedule.add/remove/list/reload admin-RPC methods with config persistence
status: pending
priority: high
assigned-role: developer
created: '2026-06-12'
spec: S-009
---

# Implement schedule.add/remove/list/reload admin-RPC methods with config persistence

## Description

S-009 Component 3: implement the four `schedule.*` admin-RPC methods in
`dispatch.rs`. These replace the T-096 placeholder arms.

**Method contracts:**

- `schedule.add { id, cron, prompt }` — validate the entry (unique id, valid
  5-field `croner` expression, non-empty prompt); if valid: (1) read current
  entries from `bob.toml`, (2) append the new entry, (3) write back atomically,
  (4) send the full updated `Vec<ScheduleEntry>` over `ReloadHandle` so the
  actor reloads in-process (per the reload design established in T-096 — the
  actor does **not** re-read disk). Return `{ "ok": true }` on success or a
  JSON-RPC error on validation failure.

- `schedule.remove { id }` — read current entries, remove the entry with the
  given id, write back atomically, send the updated vec over `ReloadHandle`.
  Return `{ "ok": true }` if found, error if not.

- `schedule.list` — return the current live job table from the actor's
  `watch::Receiver<Vec<ScheduleEntry>>` (set up in T-096 as part of
  `ReloadHandle`). No disk read. Returns JSON array:
  `[{ "id": "...", "cron": "...", "prompt": "..." }, …]`.

- `schedule.reload` — read `[[schedule]]` entries from `bob.toml` and send the
  full `Vec<ScheduleEntry>` over `ReloadHandle`. This is the only method that
  re-reads disk; it exists so the operator can reconcile the live table with
  a hand-edited config file.

**Config persistence:** Add a `write_schedule_entries(path, entries)` helper
to `crates/bob/src/config.rs` (or a new `config_writer.rs` module). It must:
1. Read the existing TOML file.
2. Replace only the `[[schedule]]` array.
3. Write atomically (write to a temp file in the same directory, then rename).

**`ReloadHandle` extension:** T-096 created `ReloadHandle` with a
`watch::Sender<Vec<ScheduleEntry>>`. Extend it here to also expose a
`watch::Receiver<Vec<ScheduleEntry>>` clone for `schedule.list` to read the
live table without an extra round-trip. Add a `subscribe()` method to
`ReloadHandle` that returns this receiver.

## Acceptance Criteria

AC-1: WHEN `schedule.add` is called with a valid entry THE SYSTEM SHALL
      persist the entry to `bob.toml` and return `{ "ok": true }`.

AC-2: IF `schedule.add` is called with a duplicate `id` or invalid cron
      expression THEN THE SYSTEM SHALL return a JSON-RPC error and leave
      `bob.toml` unchanged.

AC-3: WHEN `schedule.remove` is called with a known `id` THE SYSTEM SHALL
      remove the entry from `bob.toml`, signal reload, and return `{ "ok": true }`.

AC-4: WHEN `schedule.list` is called THE SYSTEM SHALL return the live job
      table as a JSON array with `id`, `cron`, and `prompt` fields for each entry.

AC-5: The system shall pass `cargo test -p admin-rpc` and `cargo test --workspace`
      with no new failures.

## Dependencies

- `T-096` — Dispatcher must hold the `ReloadHandle` before methods can use it

## Files to Touch

- `the-intern/service/crates/admin-rpc/src/dispatch.rs` — implement the four
  method handlers
- `the-intern/service/crates/bob/src/config.rs` — add `write_schedule_entries`
  helper (or new `config_writer.rs`)
- `the-intern/service/crates/scheduler-adapter/src/lib.rs` — expose live job
  query handle (watch receiver or query method)

## Verification

```bash
cd the-intern/service
cargo test -p admin-rpc
cargo test --workspace
```

## Work Log

### Session 1 — 2026-06-12

**What was done**

Four TDD cycles across three crates:

1. **`scheduler-adapter/src/lib.rs`** — Added `subscribe()` to `ReloadHandle` returning a `watch::Receiver<Vec<ScheduleEntry>>` clone for `schedule.list`. One new test.

2. **`bob/src/config.rs`** + `Cargo.toml` — Added `write_schedule_entries(path, entries)`: reads existing TOML, replaces only `[[schedule]]` via `toml_edit`, writes atomically (temp file + rename). Three new tests.

3. **`admin-rpc/src/dispatch.rs`** + `Cargo.toml` — Replaced T-096 placeholder with four real handlers:
   - `schedule.add`: validates id/cron/prompt, checks duplicates in live table, writes and reloads
   - `schedule.remove`: checks existence, filters out, writes and reloads
   - `schedule.list`: reads from watch receiver (no disk)
   - `schedule.reload`: reads disk via `toml` crate, signals reload
   Added `config_path: Option<PathBuf>` field and `with_config_path()` builder. Eight new tests.

4. **`admin-rpc/src/lib.rs`** + **`bob/src/serve.rs`** — Added `config_path: Option<PathBuf>` to `admin_rpc::Config`, wired into dispatcher, passed from `serve.rs`.

**What was tried and rejected**

- Calling `bob::config::write_schedule_entries` from `dispatch.rs` — rejected because `admin-rpc` cannot depend on `bob` (circular). Solution: inline the same TOML-editing logic in `dispatch.rs` using `toml_edit` directly.
- Moving `write_schedule_entries` to `bob-core` — rejected; `bob-core` is a lean types/error crate and TOML I/O would bloat it.

**What remains**

Nothing. All acceptance criteria met.

**Obstacles Encountered**

Circular dependency `admin-rpc` → `bob` required duplicating TOML write logic inline in `dispatch.rs`.

**Final branch state:** 5 implementation commits + 1 fmt cleanup. `cargo test --workspace` passes with zero failures. `cargo fmt --check` clean. (admin-rpc: 119 tests, scheduler-adapter: 7 tests, workspace all green)

## Review
