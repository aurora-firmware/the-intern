---
id: T-182
title: Add the task board resolver
status: completed
priority: high
assigned-role: developer
created: '2026-08-23'
spec: S-014
---

# Add the task board resolver

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

S-014's `bob task` keeps a markdown board in a `tasks/` directory. This task adds
the resolver that decides which directory that is. No CLI surface yet.

Resolution order is an explicit directory override, then the `TASKS_DIR`
environment variable, then an upward search from the working directory for the
nearest ancestor `tasks/`. Relative input resolves to an absolute path before
use, so a job running in a subdirectory of a workspace attaches to that
workspace's board rather than starting a second one.

Writing must never be blocked by a missing board, and reading must never invent
one: a write operation creates the board at the location it resolved, while a
read or move operation fails and names the directory it searched upward from,
rather than reporting an empty board and concealing a wrong working directory.

Created directories are mode `0700` on Unix, matching what S-012 already requires
of workspace files, because task files are trusted context that sessions read.
The resolver never weakens the permissions of a directory that already exists.

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

AC-1: The system shall resolve the board from an explicit override, then the
environment variable, then the nearest ancestor `tasks/` directory above the
working directory.
AC-2: WHEN a write operation resolves no existing board THE SYSTEM SHALL create
it at the resolved location with mode `0700` on Unix.
AC-3: IF a read or move operation resolves no existing board THEN THE SYSTEM
SHALL fail with an error naming the directory it searched upward from.
AC-4: The system shall resolve a relative board path to an absolute path before
using it.
AC-5: The system shall leave the permissions of an already-existing board
directory unchanged.

## Dependencies

- None.

## Files to Touch

- `the-intern/service/crates/bob/src/task_board/mod.rs` — new module root.
- `the-intern/service/crates/bob/src/task_board/board.rs` — new; resolution, creation, permissions, unit tests.
- `the-intern/service/crates/bob/src/lib.rs` — expose the module.

## Verification

```bash
(cd the-intern/service && cargo test -p bob task_board::board)
```

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

### Session 1 — 2026-08-23

Added `bob::task_board` resolution with override, `TASKS_DIR`, and nearest-
ancestor precedence; write creation at 0700; read/move missing-board errors;
relative-path normalization; and existing-permission preservation. The change is
committed as `97f9245` on `task/T-182-add-task-board-resolver`.

The red stub failed eight resolver tests; the completed implementation passes
all eight. Rustfmt initially found formatting drift, which was corrected with
`cargo fmt --all`. `canonicalize` was rejected because missing write targets
must still resolve; resetting modes was rejected because existing modes must be
preserved. No work remains. Unrelated `.github/workflows/__pycache__/` remains
preserved.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->

### Review Verdict — 2026-08-23
PASS

Stage 1 passed: the diff is limited to the three task-scoped files and the
resolver behavior matches AC-1 through AC-5. Explicit override, `TASKS_DIR`,
and nearest-ancestor `tasks/` precedence are implemented in
`task_board::board::resolve_board_path`; write creation uses `0700` on Unix;
read and move missing-board failures name the upward-search starting directory;
relative paths are normalized to absolute paths before use; and existing board
permissions are left unchanged.

Stage 2 passed: the resolver logic is focused and readable, the changed module
has targeted unit coverage for precedence, ancestor search, relative-path
normalization, write creation, missing-board failure, and existing-permission
preservation, and the task verification command succeeded during review:
`cargo test -p bob task_board::board`.
