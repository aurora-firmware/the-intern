---
id: T-183
title: Add the task file store
status: pending
priority: high
assigned-role: developer
created: '2026-08-23'
spec: S-014
---

# Add the task file store

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

Owns S-014's file-format contract: one markdown file per task in the board
directory, and the command is what enforces it.

Identity is the file name without its extension, beginning with the creation date
in `YYYY-MM-DD` form followed by a slug derived from the title. Frontmatter
carries exactly two queryable fields — the one-line title and the status.
Creation date is deliberately absent, because it is already the filename prefix
and a fact stored twice can contradict itself. Status is exactly one of `todo`,
`doing`, `blocked`, `done`. The body carries a description, a Definition of Done
checklist, and a log of dated entries.

Provide creation from the template, in-place rewrite of a single frontmatter
field, appending a dated entry to the log section, listing, and resolution of a
partial identifier to exactly one task. The markdown files are the only source of
truth, so a hand-edited or hand-created file is a first-class input and parsing
must tolerate files this store did not write. Created files are mode `0600` on
Unix.

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

AC-1: The system shall create a task file with mode `0600` on Unix, whose
identity is its creation date followed by a slug of its title, carrying title and
status as its only frontmatter fields.
AC-2: IF a status outside `todo`, `doing`, `blocked`, or `done` is supplied THEN
THE SYSTEM SHALL reject it before writing to the filesystem.
AC-3: WHEN a frontmatter field is rewritten THE SYSTEM SHALL leave the remainder
of the file unchanged.
AC-4: IF a partial identifier matches no task or more than one THEN THE SYSTEM
SHALL fail and name the candidates it found.
AC-5: The system shall read a task file it did not write, including one whose
title requires quoting to stay valid frontmatter.

## Dependencies

- `T-182` — the store operates on a board path the resolver produces, and extends the same module.

## Files to Touch

- `the-intern/service/crates/bob/src/task_board/store.rs` — new; format, parsing, mutation, identifier resolution, unit tests.
- `the-intern/service/crates/bob/src/task_board/mod.rs` — expose the store.

## Verification

```bash
(cd the-intern/service && cargo test -p bob task_board)
```

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

### Session 1 — 2026-08-23

Added the markdown task-file store: task creation with 0600 Unix modes,
tolerant two-field frontmatter parsing, surgical status rewrites, dated log
appends, board listing, and exact/partial identity resolution. It is committed
in three TDD cycles (`92cce06`, `49a8fed`, `5c3e394`) on
`task/T-183-add-task-file-store`.

`cargo test -p bob task_board` passed 15 tests and `cargo fmt --all -- --check`
passed. A raw status string is validated at the storage boundary so invalid
input is testable; a parser dependency was rejected in favor of the focused
two-field tolerant parser. An incidental index-lock contention cleared after
serial retry. Unrelated `.github/workflows/__pycache__/` was preserved.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->

### Review Verdict — 2026-08-23
FAIL

- `the-intern/service/crates/bob/src/task_board/store.rs:409` — `append_log_entry_content` only checks that `## Log` exists somewhere, then appends the new dated entry to the end of the file. For any hand-authored task that keeps additional content after the log heading, the entry lands outside the log section, which misses the task contract and the S-014 workflow requirement to append to the task's log section. Change this helper to locate the `## Log` section boundary and insert the new `### YYYY-MM-DD` block inside that section, preserving any later content unchanged.
- `the-intern/service/crates/bob/src/task_board/store.rs:628` — the tests only cover the generated template where `## Log` is the last section, so they do not catch the acceptance gap above for hand-authored files. Add a regression test with a valid hand-authored task file that has content after `## Log`, then verify the new entry is inserted under `## Log` without moving or rewriting the trailing content.
