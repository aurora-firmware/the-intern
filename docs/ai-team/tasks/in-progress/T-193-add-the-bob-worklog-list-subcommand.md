---
id: T-193
title: Add the bob worklog list subcommand
status: pending
priority: high
assigned-role: developer
created: '2026-08-30'
---

# Add the bob worklog list subcommand

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

Adds the `list` half of Component 3, extending the surface T-192 created.

**Grammar** (`crates/bob/src/cli/mod.rs`): add a `List` variant to
`WorklogCommand` with an optional `--date <YYYY-MM-DD>` flag.

**Dispatch** (`crates/bob/src/lib.rs`): add `worklog_list(&self, json,
date)` to `DispatchRuntime` + both impls (`ProductionRuntime`,
`FakeRuntime`), and route `WorklogCommand::List` through the existing
`Command::Worklog` early-return block.

**Handler** (`crates/bob/src/cli/commands.rs` +
`crates/bob/src/cli/commands/worklog.rs`): add the `worklog_list` wrapper
and `run_list`. It must: resolve the target date (`--date` if given, else
today); if `<cwd>/worklog/` does not exist, exit non-zero naming that
directory (never create it); run the T-191 reconciliation step
**unconditionally against today's file** before producing any output — this
is required on every `list` invocation regardless of `--date`, per S-015's
Design Principles ("every entry point that touches today's file performs
reconciliation first, unconditionally") and the Reconciliation-step
Responsibility row ("Runs unconditionally at the start of both `append` and
`list`"); read the target day's entries via the T-190 store and render them
ordered by `HH:MM`; emit human-readable text or, with `--json`, a JSON
object — both including today's carried-forward item-identifier set. Name
grammar tests `worklog_list_*`.

Only the *displayed past-dated file* is exempt from writes: `--date <past>`
renders that file as-is and never reconciles or modifies it, but today's
file is still reconciled first (which may itself create today's file when
`worklog/` exists and there is something open to carry forward — S-015
rejects computing the carried-forward set without writing the entries). The
reported carried-forward set is always today's, and is empty only when
nothing is open.

## Acceptance Criteria

AC-1: WHEN `bob worklog list` is parsed with or without `--date` THE SYSTEM
SHALL dispatch to the list handler without loading service configuration or
opening `admin.sock`.

AC-2: IF `<cwd>/worklog/` does not exist THEN THE SYSTEM SHALL exit
non-zero with a message naming that path and SHALL NOT create it.

AC-3: WHEN `list` runs with any `--date` value THE SYSTEM SHALL run the
reconciliation step against today's file before producing output, and
WHERE the target date is in the past THE SYSTEM SHALL render that
past-dated file's entries as-is without writing to it.

AC-4: WHEN entries are rendered THE SYSTEM SHALL order them by each entry's
`HH:MM` value.

AC-5: WHEN `list` succeeds THE SYSTEM SHALL print human-readable output by
default and a JSON object with `--json`, each including today's
carried-forward item-identifier set.

## Dependencies

- `T-192` — creates the `bob worklog` grammar, dispatch wiring, and `cli/commands/worklog.rs`
- `T-190` — worklog entry file store (called directly by `run_list`)
- `T-191` — reconciliation step (called directly by `run_list`)

## Files to Touch

- `the-intern/service/crates/bob/src/cli/mod.rs` — `WorklogCommand::List` with `--date`
- `the-intern/service/crates/bob/src/lib.rs` — `DispatchRuntime::worklog_list` + impls + `List` routing
- `the-intern/service/crates/bob/src/cli/commands.rs` — `worklog_list` wrapper
- `the-intern/service/crates/bob/src/cli/commands/worklog.rs` — `run_list` + context split

## Verification

```bash
cd the-intern/service && cargo build -p bob && cargo test -p bob worklog
```

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

### Session 1 — 2026-08-30

Implemented `bob worklog list` end to end across the four files named in the task, TDD with one commit per cycle.

**Cycle 1 — grammar + dispatch (AC-1).** Added a `List { #[arg(long)] date: Option<String> }` variant to `WorklogCommand` in `cli/mod.rs` with two parse tests (`worklog_list_parses_without_a_date_flag`, `worklog_list_parses_the_optional_date_flag`). Wired dispatch in `lib.rs`: new `DispatchRuntime::worklog_list(&self, json, date: Option<&str>)`, `ProductionRuntime` delegates to `cli::commands::worklog_list`, test `FakeRuntime` records `"worklog_list"`, and `WorklogCommand::List { date } => runtime.worklog_list(json, date.as_deref())` added to the existing `Command::Worklog` early-return block (before `load_config()`); the `unreachable!("filesystem-only commands return before config loading")` arm already covers `Command::Worklog { .. }`. Two `lib.rs` dispatch tests (with and without `--date`) assert the runtime call log is exactly `["worklog_list"]` — no `load`, no `telemetry`, no admin socket. Added the thin `worklog_list` wrapper to `cli/commands.rs` and a `run_list` / `run_list_with_context` split to `cli/commands/worklog.rs` mirroring `run_append`, injecting `now` via `Local::now().naive_local()` and taking `working_dir: &Path` + `out: &mut impl Write` for tests.

**Cycle 2 — missing worklog directory (AC-2).** `run_list_with_context` calls `reconcile_today(working_dir, now)?` (a no-op returning an empty set and creating nothing when `worklog/` is absent — verified by T-191's own tests) then `WorklogStore::new(working_dir).read_day(target_date)?`, whose `require_worklog_dir` fails with `ServiceError::Persistence` naming `<cwd>/worklog/` and never creates it. `main.rs` already maps any `Err` to exit 1. Test asserts the detail names the directory, the directory does not exist afterward, and nothing was written to `out`.

**Cycle 3 — target date + reconcile-first + past file as-is (AC-3).** Added `parse_target_date` (`NaiveDate::parse_from_str(raw, "%Y-%m-%d")`, mapped to `InvalidRequest` on failure); target date is `--date` if given else `now.date()`. Reconciliation runs unconditionally against **today's** file (keyed on `now`, not the target date) before any output. Introduced `WorklogDayOutput { date, entries, carried_forward }` + `WorklogEntryOutput` (`From<&RecordedEntry>`), and text rendering (`worklog for <date>`, then each entry as `## HH:MM — item` / `- Done/Left/Next`). Test seeds an open prior-day item, lists `--date <past>` with `now` a later day, and asserts: the past file is byte-identical before/after, the output renders the past day's entries, and today's file was created with the `Carried forward from …` marker (reconciliation ran, and ran against today).

**Cycle 4 — HH:MM ordering (AC-4).** Added `worklog_list_renders_entries_ordered_by_time_not_write_order` (seed times 14:00, 08:30, 11:15 in that write order; assert rendered positions early < midday < afternoon). This passed on first run: T-190's `WorklogStore::read_day` already returns entries sorted by `recorded_time` (stable, file-order ties) and the renderer iterates that slice without re-sorting. Kept as a regression guard at the `list` layer; committed as a `test(bob)` change.

**Cycle 5 — output forms + carried set (AC-5).** `write_worklog_day` now takes `json_output` and early-returns `write_json_line(out, &json!(day))` for `--json`; the text form gained a trailing `carried forward: <comma-joined | (none)>` line reusing T-192's `format_carried_forward`. `carried_forward` is always today's full set from `reconcile_today`, regardless of `--date` or which invocation performed the carry-forward write. Three tests: text reports the carried item; JSON is an object with `date`, a non-empty `entries` array, and `carried_forward == ["vendor-invoice"]`; and the empty case reports `carried forward: (none)` / `[]`.

**Extra coverage.** Added `worklog_list_rejects_a_malformed_date_flag_before_touching_the_filesystem` for the `--date` parse-failure path I introduced (asserts the error names `YYYY-MM-DD`, no `worklog/` created, no output).

**Tried and rejected.** An early attempt at the AC-5 parity test used a `for out in [&mut text_out, &mut json_out]` loop with a `std::ptr::eq` hack to pick the JSON branch — replaced with two straightforward single-purpose tests sharing a `seed_prior_open_vendor_invoice` helper. Considered folding the carried-forward line into cycle 3's text output; kept it in cycle 5 so each cycle maps to one AC. Considered `--date "2026-8-1"` as the malformed-date fixture; chrono's parser accepts unpadded fields, so switched to `"30 August 2026"`.

**Verification.** `cargo build -p bob` clean; `cargo test -p bob worklog` → 53 passed; `cargo fmt --all -- --check` clean; `cargo test --workspace` → 783 passed / 0 failed / 1 ignored (no sandbox UDS failures this run); `cargo doc -p bob --no-deps` clean; `cargo clippy -p bob --lib` introduces no warnings citing the touched files.

**What remains.** Nothing for this task. `cli/commands/worklog.rs` is now 857 lines (≈255 production, ≈600 tests) — consistent with the in-file `#[cfg(test)]` pattern the crate already uses (`task.rs`, and `worklog.rs` itself pre-T-193); splitting was not in scope. The non-blocking observation from T-192's review still stands: `WorklogStore::append`'s permissive-directory `warnings` are still discarded by both `run_append` and `run_list`.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->
