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

### Session 1 — 2026-08-30

Implemented Component 2 of S-015, the worklog entry file store, as a new `worklog` module in the `bob` binary crate mirroring `task_board/`. New files: `crates/bob/src/worklog/mod.rs` (declares `pub mod store;`) and `crates/bob/src/worklog/store.rs`; `crates/bob/src/lib.rs` gains `pub mod worklog;`. No CLI wiring and no reconciliation logic — those are T-193 and T-191. All work is on `task/T-190-add-the-worklog-entry-file-store` across seven commits, one per red→green→refactor cycle.

Public surface of `worklog::store`:
- `WorklogStore::new(working_dir)` — joins `worklog` onto the caller-supplied directory and nothing else. Per ADR-015 there is no upward search and no override, a deliberate divergence from `task_board::board::resolve_board_path`; I did not reuse that resolver or copy its `explicit_override`/`env_override` parameters.
- `WorklogStore::append(now: NaiveDateTime, &WorklogEntry) -> ServiceResult<AppendOutcome>` — the injected time source is a `chrono::NaiveDateTime` function parameter, mirroring the `today: NaiveDate` injection style in `cli/commands/task.rs`. `now.date()` drives the `<YYYY-MM-DD>.md` filename; `now` formatted `%H:%M` drives the `## <HH:MM> — <item>` header. Creates `worklog/` (Unix 0700 via `DirBuilder::mode`) and the day file (Unix 0600 via `OpenOptions::create_new().mode()`) when absent; appends via `OpenOptions::append` plus a computed blank-line separator rather than rewriting the whole file.
- `WorklogStore::read_day(date) -> ServiceResult<Vec<RecordedEntry>>` — errors (naming `<cwd>/worklog/`) and never creates the directory when it is missing; returns an empty vec when the directory exists but the day file does not; parses `## HH:MM — item` headers plus `- Done:/- Left:/- Next:` bullets, ignoring stray lines so hand-authored notes do not break reading; returns entries sorted by `recorded_time` with a stable sort so time ties keep physical file order.
- `item_open_state(&[RecordedEntry], item) -> Option<bool>` — pure function (kept off the filesystem so T-191 can reuse it against prior-day files without re-reading, and so AC-5's normalization cases are testable without I/O). `None` when the slice has no entry for the item; otherwise open unless the item's most recent entry's `Left`, after `trim()` then stripping at most one trailing `.` then a case-insensitive compare, equals `nothing`.
- `AppendOutcome { path, warnings }`. A pre-existing more-permissive `worklog/` is left unchanged and reported through `warnings: Vec<String>` (naming the directory and its mode), not a failure.

Decisions and rejected alternatives:
- Warnings are returned as data, not emitted via `tracing::warn!`. Filesystem-only subcommands return before `init_telemetry` (see `run_cli_with_runtime`), so a `tracing` warning could vanish and would not be unit-testable in-file as the task requires. `task_board` has no warning channel here to mirror; the spec only says "a warning is the appropriate response." T-193 will render `AppendOutcome.warnings` per S-015's text/JSON Output form.
- `item_open_state` returns `Option<bool>` rather than `bool` so T-191 can tell "no entry in the prior file" apart from "closed in the prior file"; AC-5 only speaks to items that have an entry.
- Append uses `OpenOptions::append` + separator prefix instead of read-modify-write of the whole file, so near-simultaneous writers only add bytes.
- Cycle 2 (0700/0600 modes) and the AC-3 read-guard tests (Cycle 5) went green without their own red phase because the minimal implementation of the preceding cycle already had to establish the seam (`create_dir_owner_only`/`create_file_owner_only`; `require_worklog_dir`). They are kept as regression coverage for those ACs.

What remains (out of scope here): T-191 reconciliation step (consumes `read_day` + `item_open_state`), T-193 `bob worklog append`/`list` CLI plus `DispatchRuntime` wiring, and the later skill/doc tasks.

Reviewer note on clippy: `cargo clippy` cannot produce a clean run for `bob` due to pre-existing `clippy::all`-deny debt in `task_board/store.rs` and `pi-agent-supervisor/src/pool.rs` (CLAUDE.md documents clippy is not yet a gate). Scoped `cargo clippy -p bob --lib --no-deps` shows the new code triggers only three `clippy::pedantic` (warn-level) `assigning_clones` notes on the `parse_entries` bullet assignments; I kept the plain `field = value.trim().to_owned()` form to match `task_board/store.rs` style. No `clippy::all` issues in the new code. `cargo fmt --all -- --check`, `cargo build -p bob`, `cargo doc -p bob`, and `cargo test --workspace` are all clean.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->
