---
id: T-185
title: Add bob task list, status, and note subcommands
status: pending
priority: high
assigned-role: developer
created: '2026-08-23'
spec: S-014
---

# Add bob task list, status, and note subcommands

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

Completes the `bob task` surface.

`list` groups tasks by status, hiding completed ones unless they are explicitly
asked for, and supports repeatable status filters. Completed tasks stay on the
board rather than moving to an archive, so a task's location never changes.

`status <id> <status>` moves a task and appends a dated log entry. When no reason
is supplied it still leaves a transition breadcrumb, so the file always shows how
it reached its current state; a reason may be supplied and is recorded instead.
`note <id> "<text>"` appends a dated entry without moving the task.

Structure is enforced, discipline is not. A move to `blocked` without a stated
reason, and a move to `done` with unticked Definition-of-Done items, are both
permitted: a rule that can fail mid-run turns a documentation problem into a
broken session. The shipped skill documents why both are bad practice.

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

AC-1: WHEN `bob task list` is invoked THE SYSTEM SHALL group tasks by status and
hide completed ones unless they are explicitly requested.
AC-2: WHEN a task's status changes THE SYSTEM SHALL append a dated log entry
recording the transition, carrying the supplied reason when one is given.
AC-3: WHEN `bob task note` is invoked THE SYSTEM SHALL append a dated entry
without changing the task's status.
AC-4: The system shall permit a move to `blocked` with no reason and a move to
`done` with unticked Definition-of-Done items.
AC-5: WHERE the global JSON flag is set THE SYSTEM SHALL emit machine-readable
output for each of these subcommands.

## Dependencies

- `T-184` — extends the same command module and CLI definition.

## Files to Touch

- `the-intern/service/crates/bob/src/cli/mod.rs` — the remaining subcommands and their parser tests.
- `the-intern/service/crates/bob/src/cli/commands/task.rs` — handlers, grouping, and rendering.

## Verification

```bash
(cd the-intern/service && cargo test -p bob task)
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
