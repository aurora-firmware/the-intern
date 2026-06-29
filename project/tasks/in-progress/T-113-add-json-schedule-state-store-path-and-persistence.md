---
id: T-113
title: Add JSON schedule state store path and persistence
status: pending
priority: high
assigned-role: unassigned
created: '2026-06-30'
---

# Add JSON schedule state store path and persistence

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

ADR-012 moves scheduler persistence out of `config.toml` and into a dedicated
versioned JSON state document. Add the core schedule-store read/write API for
that document while preserving the existing `ScheduleEntry` domain type.

The new store shape is `{ "version": 1, "entries": [...] }`, where each entry
has `id`, `cron`, and `prompt`. The writer must replace the whole file
atomically with a same-directory temp file and rename, create missing parent
directories, and enforce owner-only file mode for new stores on Unix. Existing
TOML schedule writer behavior can be removed or left only as dead-free
migration support if a later task needs it, but new code should use JSON.

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

AC-1: The system shall expose a schedule-store reader and writer that round-trip
      version `1` JSON documents containing `ScheduleEntry` values.
AC-2: WHEN the schedule-store writer is called THE SYSTEM SHALL write a complete
      JSON document by temp-file-and-rename replacement in the same directory.
AC-3: IF the schedule-store file is missing THEN THE SYSTEM SHALL read it as an
      empty schedule entry list.
AC-4: IF the schedule-store document has an unsupported version or malformed
      entries THEN THE SYSTEM SHALL return a `ServiceError::Configuration`
      describing the schedule-store problem.
AC-5: WHERE Unix file permissions are available THE SYSTEM SHALL create new
      schedule-store files with mode `0600` and preserve an existing restrictive
      file mode across rewrites.

## Dependencies

- None

## Files to Touch

- `the-intern/service/crates/bob-core/src/types/schedule.rs` — add the JSON
  schedule-store document type plus read/write helpers and unit tests.
- `the-intern/service/crates/bob-core/Cargo.toml` — remove TOML-only dependency
  usage if it becomes unused, or keep dependencies minimal after the JSON store
  replaces the TOML writer.

## Verification

```bash
cd the-intern/service && cargo test -p bob-core types::schedule
```

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

### Session 1 — 2026-06-30

Implemented the JSON schedule-store API for AC-1 through AC-5 in a single session across five TDD cycles, all on `task/T-113-add-json-schedule-state-store-path-and-persistence`.

The core addition is two public functions — `read_schedule_store` and `write_schedule_store` — plus a private `ScheduleStoreDoc` serialisation wrapper and a `SCHEDULE_STORE_VERSION` constant. The on-disk format is `{ "version": 1, "entries": [...] }` where each entry carries the existing `ScheduleEntry` fields (`id`, `cron`, `prompt`). Parsing goes through `serde_json::from_str::<ScheduleStoreDoc>` in one pass, which means a missing `cron` or `prompt` field in an entry is caught by serde and surfaces as `ServiceError::Configuration` automatically — no hand-rolled entry validation was needed.

The writer follows the same temp-file-and-rename pattern used by the pre-existing TOML writer. On Unix, `std::fs::metadata(path).ok()` reads the current mode before the temp file is created; the result is used as `existing_mode.unwrap_or(0o600)` so new files land at `0600` and existing files keep their mode.

The pre-existing `write_schedule_entries` (TOML writer) was left in place because `admin-rpc/dispatch.rs` still calls it and that file is outside the task's files-to-touch boundary. As a consequence `toml_edit` stays in `Cargo.toml`. The task description explicitly allows this ("can be removed or left only as dead-free migration support"), and removing it would require a separate follow-up task that touches admin-rpc.

Twelve new unit tests were added covering: missing-file empty return (AC-3), three round-trip and document-shape tests (AC-1), three error-path tests for unsupported version and malformed content (AC-4), three writer behaviour tests for complete output / parent-directory creation / full replacement (AC-2), and two Unix-only permission tests (AC-5). The full workspace suite continues to pass with zero failures.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->

### Review Verdict — 2026-06-30

PASS

Stage 1 — all five acceptance criteria met:

- AC-1: `read_schedule_store` and `write_schedule_store` are both public and round-trip
  version 1 JSON `{ "version": 1, "entries": [...] }` documents containing `ScheduleEntry`
  values. Verified by `round_trips_multiple_entries_through_json_store`,
  `round_trips_empty_entry_list_through_json_store`, and `json_store_document_contains_version_field`.
- AC-2: Writer serializes to a temp file at `parent/.bob-schedule-tmp-{nanos}` (same
  directory as target) and renames it over the destination. Verified by
  `writer_produces_complete_readable_json_document` and `writer_replaces_existing_store_file_completely`.
- AC-3: `if !path.exists() { return Ok(Vec::new()); }` returns an empty list for a missing
  file. Verified by `read_schedule_store_returns_empty_list_when_file_is_missing`.
- AC-4: Malformed JSON and missing required entry fields both fail at serde deserialization
  and surface as `ServiceError::Configuration`. A version mismatch after successful
  deserialization also returns `ServiceError::Configuration` with the version number in the
  message. Verified by three dedicated error-path tests.
- AC-5: On Unix, `existing_mode.unwrap_or(0o600)` applies 0600 for new files and the
  pre-existing mode for rewrites, on the temp file before the rename. Verified by
  `new_json_store_file_is_created_with_mode_0600` and `rewrite_preserves_restrictive_file_mode_on_json_store`.

Only `the-intern/service/crates/bob-core/src/types/schedule.rs` was modified.
`serde_json` was already a workspace dependency so no `Cargo.toml` change was required.
The pre-existing TOML writer was left in place, which the task description explicitly permits.

Stage 2 — code quality passes:

- Correctness: logic handles expected inputs and edge cases (empty list, missing file,
  version mismatch, malformed JSON, malformed entries) correctly. Error taxonomy follows
  project conventions (`Persistence` for I/O failures, `Configuration` for format errors).
  Temp-file cleanup on failure paths is handled.
- Tests: 12 new tests covering both success and failure paths, each with its own tempdir
  fixture (no shared mutable state). 17 schedule tests pass, full workspace suite passes
  with zero failures.
- Security: no hardcoded secrets; error messages include path identifiers but not entry
  content, consistent with the coding guidelines.
- Readability: descriptive names, focused functions, complete `# Errors` / `# Atomicity` /
  `# Permissions` doc-comment sections on all public functions, no dead code.
- Performance: no unnecessary allocations or blocking calls beyond what the I/O requires.
  `serde_json::to_string_pretty` is appropriate for an operator-readable state file.

Minor observation (non-blocking): the reader uses `path.exists()` before `read_to_string`,
which introduces a narrow TOCTOU window. A permissions-denied filesystem would return
`Ok(Vec::new())` rather than a `Persistence` error. This is a pre-existing pattern in the
codebase and does not violate any acceptance criterion.
