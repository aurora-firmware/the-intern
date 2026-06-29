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

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->
