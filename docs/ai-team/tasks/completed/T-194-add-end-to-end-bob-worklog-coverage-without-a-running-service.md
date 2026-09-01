---
id: T-194
title: Add end-to-end bob worklog coverage without a running service
status: completed
priority: medium
assigned-role: developer
created: '2026-08-30'
---

# Add end-to-end bob worklog coverage without a running service

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

Adds integration tests that exercise the real `bob` binary with no
`bob serve` running, in the style of the existing `bob task` cases in
`crates/bob/tests/non_serve.rs`
(`task_new_creates_board_and_task_without_an_admin_socket`,
`task_show_path_succeeds_without_an_admin_socket_and_finds_the_ancestor_board`).
Use the existing `bob_command_with_temp_state` helper and per-test
`tempfile::tempdir()` working directories set with `.current_dir(...)`.

Cover the cross-invocation guarantees the S-015 Contract makes that
in-crate unit tests cannot — in particular that carried-forward reporting
and idempotency hold across **separate process invocations** sharing a
working directory:

- `bob worklog append` in a directory `bob init` never touched creates
  `worklog/` and today's file and exits 0.
- `bob worklog list` in the same directory reads that entry back.
- `bob worklog list` in a directory with no `worklog/` exits non-zero and
  names the missing directory.
- With a hand-written prior-day worklog file containing an open item, a
  `bob worklog list` for a later day carries that item forward and reports
  it in the output.
- A second `bob worklog append` on the same day does not add a second
  carried-forward copy of that item.

## Acceptance Criteria

AC-1: WHEN `bob worklog append` runs in a fresh temp directory with no
`worklog/` and no admin socket THE SYSTEM SHALL exit 0 and create
`<dir>/worklog/<today>.md` containing the entry.

AC-2: WHEN `bob worklog list` runs in that same directory THE SYSTEM SHALL
exit 0 and print the entry just written.

AC-3: IF `bob worklog list` runs in a temp directory that has no `worklog/`
THEN THE SYSTEM SHALL exit non-zero and name the `worklog/` path it
expected.

AC-4: WHEN a prior-day file with an open item exists and `bob worklog list`
runs for a later day THE SYSTEM SHALL show a carried-forward entry for that
item and report it in the carried-forward set.

AC-5: WHEN `bob worklog append` is invoked twice for the same day after a
carry-forward THE SYSTEM SHALL leave exactly one carried-forward entry for
that item in today's file.

## Dependencies

- `T-192` — `bob worklog append`
- `T-193` — `bob worklog list`

## Files to Touch

- `the-intern/service/crates/bob/tests/non_serve.rs` — add `bob worklog` integration cases

## Verification

```bash
cd the-intern/service && cargo test -p bob --test non_serve
```

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

### Session 1 — 2026-08-30

Implemented T-194 as a test-only change: added five `bob worklog` integration cases to `the-intern/service/crates/bob/tests/non_serve.rs`, one per acceptance criterion, following the existing `bob task` non-serve pattern (real binary via `env!("CARGO_BIN_EXE_bob")`, the `bob_command_with_temp_state` helper, a per-test `tempfile::tempdir()` with a `workspace/` subdir set via `.current_dir(...)`). No production code was touched; `Cargo.toml` was not touched.

Cases added:
- `worklog_append_creates_todays_file_without_a_worklog_dir_or_admin_socket` (AC-1): asserts exit 0, parses the `path:` line from the append's stdout, checks the file's parent is `<cwd>/worklog/`, checks the file name is `<YYYY-MM-DD>.md`, and checks all four entry fields are on disk.
- `worklog_list_reads_back_an_entry_a_prior_invocation_appended` (AC-2): append then a separate `list` invocation; asserts exit 0 and all four fields in stdout.
- `worklog_list_exits_non_zero_and_names_the_missing_worklog_directory` (AC-3): asserts exit code 1, that stderr contains the full `<cwd>/worklog` path, and that the directory was not created.
- `worklog_list_carries_a_prior_day_open_item_forward_and_reports_it` (AC-4): hand-writes `worklog/2000-01-01.md` in Contract shape with `Left` != `nothing`, then `list`; asserts the rendered `- Done: Carried forward from 2000-01-01.md` line, the item name, and the `carried forward: vendor-invoice` summary line.
- `worklog_append_twice_the_same_day_keeps_exactly_one_carried_forward_entry` (AC-5): same prior-day seed, two separate `append` invocations for different items; reads the day file from the first append's `path:` line and asserts exactly one `Carried forward from 2000-01-01.md` marker and exactly one `— vendor-invoice` header, plus both own entries present.

Decisions / things tried and rejected:
- Considered computing "today" with `chrono` to assert the exact day-file name. Rejected: `chrono` is a normal (not dev) dependency of `bob` and is not reachable from the integration-test crate, and `Cargo.toml` is out of scope for this task. Instead the tests read "today" implicitly from the binary itself — the `path:` line for appends, and an ISO-shape check on the file name — which is exactly "the real current date the binary sees" per the task note.
- Used a fixed far-past prior-day date `2000-01-01` for AC-4/AC-5 rather than a computed `today - 1`. The reconciler selects the nearest prior *existing* file; since the hand-written file is the only prior file, it is always chosen, so a fixed old date keeps the tests deterministic and clock-independent.
- For AC-5, inspected the day file located from the first append's `path:` line rather than recomputing it, so the assertion stays valid even in the negligible midnight-rollover case.
- Manually exercised the binary in a scratch dir to confirm the exact stderr text (`persistence error: worklog directory <path> does not exist`), the carried-entry `Done` wording, the `— ` (U+2014) header separator, and that a second same-day append reports the carried item but writes no duplicate — all matched the assertions.

Verification: `cargo test -p bob --test non_serve` → 10 passed (5 new). `cargo fmt --all -- --check` → clean. `cargo test --workspace` → all green (1 pre-existing ignored test). No product bug found; no escalation needed. Nothing remains for this task.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->

### Review Verdict — 2026-08-30

PASS

**Stage 1 — Acceptance criteria: all five met.**

Only `the-intern/service/crates/bob/tests/non_serve.rs` changed (test-only,
+350 lines, 1 commit). No production code, no `Cargo.toml`. Each AC has a
dedicated test that drives the real `bob` binary with no `bob serve` running,
using the existing `bob_command_with_temp_state` helper and a per-test
`tempfile::tempdir()` `workspace/` set with `.current_dir(...)`.

- AC-1 `worklog_append_creates_todays_file_without_a_worklog_dir_or_admin_socket`
  — fresh temp dir, no `worklog/`, no socket; asserts exit 0, parses the
  `path:` line, checks the parent is `<cwd>/worklog/`, checks the `<YYYY-MM-DD>.md`
  name shape, and reads all four entry fields back off disk. Asserts content,
  not just the exit code.
- AC-2 `worklog_list_reads_back_an_entry_a_prior_invocation_appended` — a
  separate `append` process then a separate `list` process in the same dir;
  asserts exit 0 and every field value in stdout. Genuine cross-process read.
- AC-3 `worklog_list_exits_non_zero_and_names_the_missing_worklog_directory` —
  asserts exit 1, stderr contains the full `<cwd>/worklog` path (matches
  `require_worklog_dir`'s "worklog directory {} does not exist"), and the dir
  was not created.
- AC-4 `worklog_list_carries_a_prior_day_open_item_forward_and_reports_it` —
  hand-writes `worklog/2000-01-01.md` in Contract shape with `Left` != nothing;
  asserts both halves of the AC: the rendered `- Done: Carried forward from
  2000-01-01.md` entry line AND the `carried forward: vendor-invoice` summary
  line.
- AC-5 `worklog_append_twice_the_same_day_keeps_exactly_one_carried_forward_entry`
  — two separate `append` invocations after a carry-forward; reads today's file
  from the first append's recorded path and asserts exactly one "Carried
  forward from 2000-01-01.md" marker and exactly one "— vendor-invoice" header,
  plus both own entries still present. Exercises cross-invocation idempotency
  that the in-process `reconcile.rs` unit test cannot.

**Stage 2 — Code quality: pass.**

- Follows the existing `bob task` non_serve pattern (shared helper, per-test
  tempdir, `env!("CARGO_BIN_EXE_bob")`, UTF-8 stdout/stderr decode).
- Deterministic / not clock-flaky: AC-1..AC-3 are date-independent; AC-4/AC-5
  use a fixed far-past `2000-01-01` prior-day file that the reconciler always
  selects as the nearest prior existing file regardless of the binary's clock;
  AC-5 resolves today's file from the recorded `path:` line, robust to a
  midnight rollover. No `sleep`, no wall-clock assertions.
- Tests are independent (own tempdir, no shared mutable state), cover the
  failure path (AC-3), and assert observable behaviour (file content on disk,
  stdout/stderr text) rather than exit codes alone.
- Import change (`PathBuf`) is minimal and used. Helpers `parse_recorded_path`,
  `is_iso_dated_markdown_name`, `write_prior_day_open_item` are documented and
  focused. No dead code.

**Verification re-run on the branch:**
- `cargo test -p bob --test non_serve` → 10 passed, 0 failed (5 new).
- `cargo fmt --all -- --check` → clean.
- `cargo test --workspace` → all green; 0 failures; the single ignored test is
  the pre-existing, unrelated `serve.rs` B-028 case.
- `cargo clippy` not run — not a clean gate for the `bob` crate per CLAUDE.md.

**Minor, non-blocking:**
- `parse_recorded_path` is coupled to the text (non-JSON) append output; fine
  for these tests since they never pass `--json`.
- `is_iso_dated_markdown_name` checks digit/dash shape only, not month/day
  ranges; acceptable, as the binary owns the real date and this is only a
  shape guard.
