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

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->
