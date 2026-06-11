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
  5-field cron, non-empty prompt); if valid, append to the `[[schedule]]`
  section in `bob.toml` and signal the scheduler actor to reload. Return
  `{ "ok": true }` on success or a JSON-RPC error on validation failure.

- `schedule.remove { id }` — remove the entry with the given id from
  `bob.toml`; signal reload. Return `{ "ok": true }` if found, error if not.

- `schedule.list` — return the current live job table as a JSON array:
  `[{ "id": "...", "cron": "...", "prompt": "..." }, …]`. Read from the
  scheduler actor's live state (not re-read from disk).

- `schedule.reload` — signal the scheduler actor to re-read `bob.toml` and
  rebuild its job table. Return `{ "ok": true }`.

**Config persistence:** Add a `write_schedule_entries(path, entries)` helper
to `crates/bob/src/config.rs` (or a new `config_writer.rs` module). It must:
1. Read the existing TOML file.
2. Replace only the `[[schedule]]` array.
3. Write the file atomically (write to a temp file, then rename).

The `schedule.list` method requires the scheduler actor to expose a
`list_jobs()` method or channel; add this to `ReloadHandle` or as a separate
`QueryHandle`. Keep the design minimal — a `watch::Receiver<Vec<ScheduleEntry>>`
broadcast from the actor is sufficient.

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

## Review
