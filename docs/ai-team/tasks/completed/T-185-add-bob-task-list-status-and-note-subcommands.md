---
id: T-185
title: Add bob task list, status, and note subcommands
status: completed
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

I wired the new subcommands through the same three-layer dispatch pattern T-184 established: parser variants in `cli/mod.rs`, thin wrapper functions in `cli/commands.rs`, and `DispatchRuntime` trait/`ProductionRuntime`/dispatch-match additions in `lib.rs` (including the test `FakeRuntime`). `lib.rs` isn't in this task's `Files to Touch` list, but it has a direct T-184 precedent: T-184's own Work Log flagged `lib.rs` as an unlisted dispatch-layer file it had to touch, and T-184's review verdict passed that touch as necessary and appropriately scoped; I followed that precedent for `lib.rs` here. `cli/commands.rs` is different: T-184's `Files to Touch` list explicitly included `cli/commands.rs — register the module`, so it was never an unlisted exception there, and citing it as one was a mistake on my part. Touching it in this task stands on its own: it is the same thin-delegator pattern that file already establishes for `task_new`/`task_show`, extended here to expose the new `list`/`status`/`note` handlers in `cli/commands/task.rs` through the CLI's existing three-layer dispatch, with no unrelated changes bundled in.

Testing: added CLI parser tests for all three subcommands (repeatable `--status`, optional `--reason`, positional `id`/`text` for `note`), and handler-level tests in `cli/commands/task.rs` covering AC-1 (hide-done-by-default, explicit status filter including `done`, repeated filters, JSON shape, invalid-filter rejection), AC-2 (default breadcrumb, reason-carrying breadcrumb, JSON `previous_status`/`status`, unknown-status rejected before the file is touched), AC-4 (blocked-with-no-reason and done-with-unticked-DoD both succeed), and AC-3/AC-5 for `note` (log entry appended without a status change, JSON output, empty-text rejected before the file is touched). `cargo test -p bob task` (the task's Verification command) and `cargo test --workspace` both pass; `cargo fmt --all -- --check` and `cargo clippy -p bob --all-targets` are clean on the touched files. Nothing remains for implementation; next is reviewer validation.

### Session 2 — 2026-08-24

Corrected a factual error the Reviewer identified in the Session 1 Work Log's T-184 precedent claim. I checked T-184's canonical file directly: its `Files to Touch` list explicitly included `the-intern/service/crates/bob/src/cli/commands.rs — register the module`, so `commands.rs` was in-scope for T-184 from the start and was never an unlisted exception the way I'd described it. Only `the-intern/service/crates/bob/src/lib.rs` and `the-intern/service/crates/bob/tests/non_serve.rs` were flagged as omissions in T-184's own Work Log, and T-184's review verdict names only those two as the reviewed and passed exception — `commands.rs` needed no exception because it was always on the list.

I rewrote the Session 1 paragraph to reflect this accurately: `lib.rs` retains its genuine T-184 precedent (an unlisted dispatch-layer file, reviewed and passed in that task), stated as such without overreach. The `cli/commands.rs` touch in this task no longer cites a nonexistent T-184 exception; instead it's justified on its own terms — it follows the same thin-delegator pattern that file already establishes for `task_new`/`task_show`, extended here to register the new `list`/`status`/`note` handlers from `cli/commands/task.rs` through the CLI's existing three-layer dispatch, with no unrelated changes bundled in. This matches the Reviewer's own independent assessment of the diff, which already found `commands.rs` and `lib.rs` "minimal, additive, and follow the exact three-layer dispatch pattern already in the codebase."

No code, tests, or other Work Log content changed. Re-ran the task's Verification command (`cargo test -p bob task`) to confirm no regression from this documentation-only change: all tests pass, matching the state the Reviewer already validated. Nothing else remains; resubmitting for re-review.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->

### Review Verdict — 2026-08-24
FAIL

Stage 1 (acceptance criteria) — all met, with evidence:
- AC-1 (group by status, hide `done` by default, explicit request shows it): `task_list_hides_done_tasks_by_default_and_groups_by_status`, `task_list_with_status_filter_shows_requested_statuses_including_done`, `task_list_supports_repeatable_status_filters` in `cli/commands/task.rs`, backed by `group_tasks_by_status`/`canonical_status_order`.
- AC-2 (dated log entry on status change, carries supplied reason): `task_status_appends_default_breadcrumb_when_no_reason_given`, `task_status_carries_the_supplied_reason_in_the_log_entry`; `format_status_log_entry` produces `"Status changed from {old} to {new}."` or `"...: {reason}"` unconditionally on every status change.
- AC-3 (`note` appends without changing status): `task_note_appends_dated_entry_without_changing_status` asserts `status: doing` is unchanged after the note.
- AC-4 (blocked-with-no-reason and done-with-unticked-DoD both permitted): `task_status_permits_move_to_blocked_with_no_reason`, `task_status_permits_move_to_done_with_unticked_definition_of_done_items` (asserts `- [ ] observable outcome` stays unticked).
- AC-5 (JSON parity under the global flag): `task_list_json_output_reports_status_and_path_for_each_task`, `task_status_json_output_reports_previous_and_new_status`, `task_note_json_output_reports_id_and_path`.
- No unspecified behavior was added beyond the three subcommands and their tests.

Stage 1 (unexpected files modified) — FAIL. I verified the Work Log's precedent claim against T-184's actual Files to Touch list and review verdict rather than accepting it:
- **File and location**: `docs/ai-team/tasks/in-progress/T-185-...md`, Work Log → Session 1, the paragraph beginning "I wired the new subcommands through the same three-layer dispatch pattern T-184 established...".
- **What is wrong**: the paragraph claims "the same gap existed in T-184" for both `the-intern/service/crates/bob/src/cli/commands.rs` and `the-intern/service/crates/bob/src/lib.rs`. That is only true for `lib.rs`. T-184's own Files to Touch list explicitly included `the-intern/service/crates/bob/src/cli/commands.rs — register the module`, so `commands.rs` was never an off-list file in T-184 — it was in-scope from the start. T-184's Work Log only flags `lib.rs` and `tests/non_serve.rs` as the files "omitted" from its Files to Touch list, and T-184's review verdict correspondingly passes only those two as the necessary/appropriately-scoped exception ("the extra `.../src/lib.rs` and `.../tests/non_serve.rs` touches were necessary and appropriately scoped to top-level dispatch plus AC-4 verification" — `commands.rs` is not mentioned because it required no exception). So there is no actual T-184 precedent for treating an unlisted `commands.rs` touch as pre-approved; the citation misrepresents what was reviewed.
- **What should change**: correct the Work Log paragraph so it does not cite a nonexistent precedent for `commands.rs`. State plainly that `lib.rs` has a direct T-184 precedent (unlisted dispatch-layer file, reviewed and passed), and justify the `commands.rs` touch on its own terms instead — e.g., it is the same thin-delegator pattern already established in that file for `task_new`/`task_show`, required to expose the new `task.rs` handlers through the CLI's existing three-layer dispatch, with no unrelated changes bundled in. This is a Work Log correction, not a code change.

Independent assessment of the `commands.rs`/`lib.rs` diffs themselves (not relying on the flawed precedent citation): both are minimal, additive, and follow the exact three-layer dispatch pattern already in the codebase (parser variant in `cli/mod.rs` → thin wrapper in `cli/commands.rs` → `DispatchRuntime` trait method + `ProductionRuntime` impl + dispatch-match arm + `FakeRuntime` test double in `lib.rs`). No unrelated behavior was bundled in. On the merits, I would accept these touches as necessary and appropriately scoped once the Work Log accurately reflects why — but the verdict is FAIL until the mischaracterized precedent is corrected, since the Work Log is the audit trail this process relies on and it currently overstates what T-184's review actually covered.

Stage 2 (code quality) — checked in full so no second review cycle is needed for these items:
- Correctness: local validation order (id/status/text checked before board resolution or any write) is consistent with `task new`'s established pattern and is proven by `task_status_rejects_unknown_status_before_touching_the_task_file` and `task_note_rejects_empty_text_before_touching_the_task_file`, both of which assert the file is byte-for-byte unchanged on rejection. `BoardOperation::Move`/`Read` correctly fail on a missing board (verified against `task_board/board.rs`, unmodified by this task).
- Tests: both success and failure paths covered per AC, independent (each test uses its own `tempfile::tempdir()`), no shared mutable state.
- Security: no external/network input, no secrets, no shell/SQL involved; note text is written verbatim to the task's own log section by design (matches AC-3), no injection surface introduced.
- Readability: names and helpers (`group_tasks_by_status`, `format_status_log_entry`, `parse_status_filter`) are focused and descriptive; no dead code.
- Verification: `cargo test -p bob task` (the task's Verification command) passes — 46 tests in the filtered set, including the two `non_serve` integration tests. `cargo test --workspace` passes with no failures. `cargo fmt --all -- --check` is clean. `cargo clippy -p bob --all-targets` produces no new warnings in any of the touched files (`cli/mod.rs`, `cli/commands.rs`, `cli/commands/task.rs`, `lib.rs`); all pre-existing warnings are pedantic/doc-style debt in unrelated crates, consistent with the documented non-gating status of clippy for this workspace.
- `task_board/store.rs` and `task_board/board.rs` are unmodified — confirmed the Developer's claim of reusing existing `TaskStore`/`BoardOperation` primitives verbatim rather than adding a new `BoardOperation` variant.

Next: Developer corrects the Work Log's T-184 precedent citation for `commands.rs` (or supplies an accurate independent justification) and resubmits. No code changes are expected based on this review.

### Review Verdict — 2026-08-24
PASS

This is re-review cycle 2, scoped to the two open items from the prior FAIL: the corrected Work Log citation and confirmation that no code changed.

1. Work Log correction verified against T-184's canonical file (`docs/ai-team/tasks/completed/T-184-add-bob-task-new-and-bob-task-show-subcommands.md`):
   - T-184's `Files to Touch` list explicitly includes `the-intern/service/crates/bob/src/cli/commands.rs — register the module` (line 76). T-184's own Work Log names only `lib.rs` and `tests/non_serve.rs` as the files omitted from that list, and T-184's review verdict passes only those two as the necessary/appropriately-scoped exception.
   - The rewritten Session 1 paragraph in this task's Work Log now matches that record exactly: `lib.rs` is stated as a genuine, direct T-184 precedent (unlisted dispatch-layer file, reviewed and passed); `cli/commands.rs` no longer claims any T-184 exception and is instead justified on its own terms (same thin-delegator pattern already established in that file for `task_new`/`task_show`, extended for the new `list`/`status`/`note` handlers, no unrelated changes bundled in). No false precedent remains.
   - Diffed the correction directly (`git diff 0816653 9746249`): the only change is the Session 1 paragraph rewrite plus the new Session 2 entry explaining it. No other Work Log content, code, or tests were touched.

2. Branch-tip confirmation: `task/T-185-add-bob-task-list-status-and-note-subcommands` is still at `49841cb` (`test(bob): cover task list, status, and note handlers`, 2026-08-24 14:48:33), the same commit reviewed in the prior cycle — timestamped before the prior review verdict commit (`0816653`, 14:57:13) and unchanged since. `git diff --stat` against the branch point confirms the same four touched files as before (`cli/mod.rs`, `cli/commands.rs`, `cli/commands/task.rs`, `lib.rs`), same line counts (903 insertions, 2 deletions). The Session 2 correction commit (`9746249`) touches only the canonical task `.md` file — documentation-only, no code or test changes, consistent with the Developer's own claim.

Combined with the prior cycle's already-passed Stage 1 acceptance-criteria checks and fully-checked Stage 2 (correctness, tests, security, readability, verification commands all clean on this same commit), both stages now pass with no open items.

Next: ready for integration.
