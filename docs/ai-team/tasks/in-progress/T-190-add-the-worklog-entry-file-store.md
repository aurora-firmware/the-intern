---
id: T-190
title: Add the worklog entry file store
status: pending
priority: high
assigned-role: developer
created: '2026-08-30'
---

# Add the worklog entry file store

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

S-015 replaces the `worklog` skill's raw-shell diary recipe with a real
`bob worklog` subcommand. This task adds Component 2, the **entry file
store**: the layer that owns the on-disk worklog format and resolves the
worklog location.

Create a `worklog` module in the `bob` binary crate, mirroring the existing
`task_board` module (`crates/bob/src/task_board/`). Add
`crates/bob/src/worklog/mod.rs` and `crates/bob/src/worklog/store.rs`, and
declare `pub mod worklog;` in `crates/bob/src/lib.rs`.

The store must:

- Resolve the worklog **strictly** to `<cwd>/worklog/<YYYY-MM-DD>.md`
  relative to a caller-supplied working directory. **No upward search, no
  override** — this is ADR-015 (cwd-strict resolution), a deliberate
  divergence from `task_board`'s upward-searching resolver.
- On a write: create `worklog/` and today's file if missing; on Unix set
  new directories to mode `0700` and new files to `0600`; do not weaken an
  existing more-permissive `worklog/` (warn instead), matching `task_board`.
- On a read: if `worklog/` does not exist, return an error naming the
  directory it looked for — never create it on a read.
- Append an entry in the Contract shape: header line `## <HH:MM> —
  <item-identifier>`, a blank line, then `- Done: …`, `- Left: …`,
  `- Next: …`. Take the real `HH:MM` / `YYYY-MM-DD` from an injectable time
  source (mirror how `cli/commands/task.rs` injects `today: NaiveDate`).
- Read a day's entries back sorted by the entry's `HH:MM` (ties broken by
  file order), not by physical file position.
- Provide an "is this item open in this file?" test: an item-identifier is
  open iff its most recent entry in that file has a `Left` field not equal
  to `nothing`, compared case-insensitively after trimming surrounding
  whitespace and at most one trailing period (so `nothing`, `Nothing`,
  `Nothing.` all classify as closed).

No reconciliation logic here (that is T-191). Unit-test the module in-file,
as `task_board/store.rs` and `task_board/board.rs` do.

## Acceptance Criteria

AC-1: WHEN `append` is invoked against a working directory that has no
`worklog/` directory THE SYSTEM SHALL create `<cwd>/worklog/` and
`<cwd>/worklog/<today>.md` — on Unix with modes `0700` and `0600` — and
write the entry; and IF `worklog/` already exists with more permissive
modes THEN THE SYSTEM SHALL leave its permissions unchanged and emit a
warning rather than fail.

AC-2: WHEN an entry is appended THE SYSTEM SHALL write it as
`## <HH:MM> — <item-identifier>` followed by a blank line and
`- Done:` / `- Left:` / `- Next:` bullets, with `<HH:MM>` and the filename
date taken from the injected time source.

AC-3: IF `list`/read is invoked in a working directory that has no
`worklog/` directory THEN THE SYSTEM SHALL return an error naming the
`<cwd>/worklog/` path and SHALL NOT create it.

AC-4: WHEN a day's entries are read back THE SYSTEM SHALL return them
ordered by each entry's `HH:MM` value, breaking ties by file order.

AC-5: WHERE an item-identifier's most recent entry in a file has a `Left`
value equal to `nothing` after case-folding, whitespace-trimming, and
removing at most one trailing period THE SYSTEM SHALL report that item as
closed, and otherwise as open.

## Dependencies

- None

## Files to Touch

- `the-intern/service/crates/bob/src/worklog/mod.rs` — new module (`pub mod store;`)
- `the-intern/service/crates/bob/src/worklog/store.rs` — new: `WorklogStore`, strict path resolution, append/read, permissions, open-test, unit tests
- `the-intern/service/crates/bob/src/lib.rs` — add `pub mod worklog;`

## Verification

```bash
cd the-intern/service && cargo test -p bob worklog::store
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
