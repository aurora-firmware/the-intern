---
id: T-184
title: Add bob task new and bob task show subcommands
status: completed
priority: high
assigned-role: developer
created: '2026-08-23'
spec: S-014
---

# Add bob task new and bob task show subcommands

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

The first CLI surface over the board: `bob task new "<title>"` with optional
status, creation date, description, and repeatable Definition-of-Done flags, and
`bob task show <id>` with an option to print only the file path so the body can
be hand-edited.

Both are filesystem-only and must never contact the admin socket, in the shape
`bob init` already uses — no admin-RPC method, no serve-side handler. This is
what lets an operator read the board while the service is stopped.

Invalid input is rejected locally before the filesystem is touched: an unknown
status, an empty title, a creation date that is not `YYYY-MM-DD`. Output is
human-readable by default and JSON under the CLI's existing global flag, carrying
the same facts in both forms.

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

AC-1: WHEN `bob task new` is invoked with a title THE SYSTEM SHALL create a task
file and report its identity, status, and path.
AC-2: IF an empty title, an unknown status, or a malformed creation date is
supplied THEN THE SYSTEM SHALL fail before writing anything to the filesystem.
AC-3: WHEN `bob task show` is invoked with an identifier THE SYSTEM SHALL print
the task file, or only its path when asked for the path.
AC-4: WHILE no admin socket exists THE SYSTEM SHALL complete both subcommands
successfully.
AC-5: WHERE the global JSON flag is set THE SYSTEM SHALL emit the same facts the
text form reports.

## Dependencies

- `T-183` — the subcommands are a thin surface over the file store.

## Files to Touch

- `the-intern/service/crates/bob/src/cli/mod.rs` — the `task` command, its subcommand enum, and parser tests.
- `the-intern/service/crates/bob/src/cli/commands/task.rs` — new; handlers and rendering.
- `the-intern/service/crates/bob/src/cli/commands.rs` — register the module.

## Verification

```bash
(cd the-intern/service && cargo test -p bob task)
(cd the-intern/service && cargo test -p bob --test non_serve)
```

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

### Session 1 — 2026-08-24
Implemented the first `bob task` CLI surface on `task/T-184-add-bob-task-new-show`: added a top-level `task` command with `new` and `show` subcommands, a `--board` override, local validation for empty titles, invalid statuses, and malformed `--created` dates, and JSON/text renderers for creation, full-file display, and `--path`. I kept the command filesystem-only by routing `task` through the same pre-config dispatch path as `init`, so no admin-RPC client or socket lookup is involved.

I added focused unit coverage for parser behavior, board resolution, invalid-input rejection before board creation, partial-id lookup, JSON output, and human output. I also added `non_serve` integration checks that run the real `bob` binary without an admin socket to prove `task new` can create a board/task and `task show --path` can find an ancestor board while the service is stopped.

The task file's Files to Touch list omitted `the-intern/service/crates/bob/src/lib.rs`, which had to change to dispatch the new top-level command, and `the-intern/service/crates/bob/tests/non_serve.rs`, which had to change to satisfy the task's explicit verification command and AC-4. I kept those additions minimal and scoped to command dispatch plus service-down verification. Nothing remains for implementation; next is reviewer validation and integration if it passes.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->

### Review Verdict — 2026-08-24
PASS

- Stage 1 passed: `bob task new` creates board-backed markdown tasks, rejects empty titles / invalid statuses / malformed dates before filesystem mutation, `bob task show` supports full-file and `--path` output, both subcommands run successfully with no admin socket, and JSON output is covered for the same reported facts.
- Stage 1 passed: the extra `the-intern/service/crates/bob/src/lib.rs` and `the-intern/service/crates/bob/tests/non_serve.rs` touches were necessary and appropriately scoped to top-level dispatch plus AC-4 verification.
- Stage 2 passed: the implementation keeps validation local, reuses the board resolver and task store directly, and adds focused unit plus service-down integration coverage without unrelated behavior.
