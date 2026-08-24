---
id: T-185
title: Add bob task list, status, and note subcommands
status: in-progress
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

### Session 1 — 2026-08-24

Implemented the remaining `bob task` CLI surface on `task/T-185-add-bob-task-list-status-and-note-subcommands`: `list`, `status`, and `note` subcommands extending the `new`/`show` pair from T-184.

`list` takes a repeatable `--status` filter (mirroring the `audit tail --filter` pattern already in the codebase). With no filter it shows `todo`/`doing`/`blocked` grouped by canonical status order and hides `done`; with an explicit filter (including `done`) it shows only the requested statuses. Text output prints `"<status>:"` group headers followed by `"  <id>  <title>"` lines; JSON output is a flat `{"tasks": [{id, title, status, path}, ...]}` array, since the spec only requires the JSON form to carry the same facts, not mirror the text grouping.

`status <id> <status> [--reason <text>]` validates the identifier and new status locally (before touching the board, consistent with `task new`'s pattern), resolves the board with `BoardOperation::Move` (fails on a missing board rather than creating one, per the spec's read/move-vs-write asymmetry), reads the task's current status, rewrites the frontmatter `status` field via the existing `FrontmatterField::Status` path, then appends a log entry: `"Status changed from {old} to {new}."` or, when a reason is supplied, `"Status changed from {old} to {new}: {reason}"`. No validation was added for the target status beyond the existing `TaskStatus::parse` allow-list, and no Definition-of-Done or reason enforcement was added — verified directly with tests that a move to `blocked` with no reason and a move to `done` with unticked DoD items both succeed and leave the checklist untouched, matching the spec's explicit rejection of discipline enforcement.

`note <id> <text>` validates a non-empty id and non-empty text, resolves the board with `BoardOperation::Read` (same missing-board-fails semantics; `note` doesn't create anything either), resolves the partial identifier, and appends the note text verbatim as a dated log entry via the store's existing `append_log_entry`, leaving the status field untouched.

I considered adding a dedicated `BoardOperation` variant to distinguish "must-exist mutation" from "must-exist read" more precisely for `note` vs `status`, but `Read` and `Move` are implemented identically in `board.rs` today (both fail the same way on a missing board), and `task_board/board.rs` isn't in this task's file list, so I reused the existing variants rather than touching that file for a distinction with no current behavioral difference.

I wired the new subcommands through the same three-layer dispatch pattern T-184 established: parser variants in `cli/mod.rs`, thin wrapper functions in `cli/commands.rs`, and `DispatchRuntime` trait/`ProductionRuntime`/dispatch-match additions in `lib.rs` (including the test `FakeRuntime`). Those last two files aren't in the task's `Files to Touch` list, but the same gap existed in T-184 and was reviewed and passed as necessary and appropriately scoped; I followed that precedent rather than re-raising it.

Testing: added CLI parser tests for all three subcommands (repeatable `--status`, optional `--reason`, positional `id`/`text` for `note`), and handler-level tests in `cli/commands/task.rs` covering AC-1 (hide-done-by-default, explicit status filter including `done`, repeated filters, JSON shape, invalid-filter rejection), AC-2 (default breadcrumb, reason-carrying breadcrumb, JSON `previous_status`/`status`, unknown-status rejected before the file is touched), AC-4 (blocked-with-no-reason and done-with-unticked-DoD both succeed), and AC-3/AC-5 for `note` (log entry appended without a status change, JSON output, empty-text rejected before the file is touched). `cargo test -p bob task` (the task's Verification command) and `cargo test --workspace` both pass; `cargo fmt --all -- --check` and `cargo clippy -p bob --all-targets` are clean on the touched files. Nothing remains for implementation; next is reviewer validation.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->
