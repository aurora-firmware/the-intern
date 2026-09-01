---
id: T-192
title: Add the bob worklog append subcommand
status: completed
priority: high
assigned-role: developer
created: '2026-08-30'
---

# Add the bob worklog append subcommand

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

Adds the `append` half of Component 3 (the `bob worklog` CLI surface).
`bob worklog` is **filesystem-only** — like `bob init` and `bob task`, it
must never open `admin.sock` or load service config.

**Grammar** (`crates/bob/src/cli/mod.rs`): add a `Worklog { #[command(subcommand)]
command: WorklogCommand }` arm to `Command`, and a `WorklogCommand` enum
with an `Append` variant carrying four required string flags: `--item`,
`--done`, `--left`, `--next`. Add `worklog` to the subcommand list asserted
in the `help_lists_...` test.

**Dispatch** (`crates/bob/src/lib.rs`): add `worklog_append(&self, json,
item, done, left, next)` to the `DispatchRuntime` trait; implement it on
`ProductionRuntime` (delegating to `cli::commands::worklog_append`) and on
the test `FakeRuntime`; add a `Command::Worklog` early-return block
**before** `runtime.load_config()`, mirroring the existing `Command::Init`
/ `Command::Task` blocks, and add `Command::Worklog` to the
`unreachable!("filesystem-only commands return before config loading")` arm.

**Handler** (`crates/bob/src/cli/commands.rs` + new
`crates/bob/src/cli/commands/worklog.rs`): add `mod worklog;` and a
`pub fn worklog_append(...)` wrapper; implement `run_append` in
`worklog.rs` following `cli/commands/task.rs`'s `run_*` /
`run_*_with_context` split. It must: reject a missing or empty
`--item`/`--done`/`--left`/`--next` locally before touching the filesystem;
run the T-191 reconciliation step for today's file first; append the entry
via the T-190 store; then emit human-readable text or, with `--json`, a
JSON object — both forms including today's full carried-forward
item-identifier set from the reconciliation step. Name grammar tests
`worklog_append_*` so the verification filter matches.

## Acceptance Criteria

AC-1: WHEN `bob worklog append --item I --done D --left L --next N` is
parsed THE SYSTEM SHALL dispatch to the append handler without loading
service configuration or opening `admin.sock`.

AC-2: IF any of `--item`, `--done`, `--left`, `--next` is absent or empty
THEN THE SYSTEM SHALL exit non-zero with a message naming the missing field
and SHALL NOT create or modify any file.

AC-3: WHEN the append handler runs THE SYSTEM SHALL invoke the
reconciliation step for today's file before writing its own entry.

AC-4: WHEN an append succeeds THE SYSTEM SHALL print human-readable
confirmation by default and a JSON object with `--json`, each including
today's carried-forward item-identifier set.

AC-5: The system shall list `worklog` among the subcommands asserted
present by the CLI help test.

## Dependencies

- `T-190` — worklog entry file store
- `T-191` — reconciliation step invoked before the append

## Files to Touch

- `the-intern/service/crates/bob/src/cli/mod.rs` — `Worklog` arm, `WorklogCommand::Append`, help test
- `the-intern/service/crates/bob/src/lib.rs` — `DispatchRuntime::worklog_append`, `ProductionRuntime` + `FakeRuntime` impls, `Command::Worklog` early return + `unreachable!` arm
- `the-intern/service/crates/bob/src/cli/commands.rs` — `mod worklog;`, `worklog_append` wrapper
- `the-intern/service/crates/bob/src/cli/commands/worklog.rs` — new: `run_append` + context split, local validation, output

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

Implemented `bob worklog append` end to end across the four files named in the task, using TDD with one commit per red→green→refactor cycle.

**Cycle 1 — grammar + dispatch (AC-1, AC-5).** Added `WorklogCommand` (with the single `Append` variant carrying four required `String` flags `--item/--done/--left/--next`) and a `Worklog { command: WorklogCommand }` arm to `Command` in `cli/mod.rs`. Added `worklog` to the `help_lists_...` assertion list and five grammar parse tests (`worklog_append_parses_all_four_required_flags`, plus one `worklog_append_requires_the_*_flag` per field — clap already rejects a wholly missing flag). Wired dispatch in `lib.rs`: new `DispatchRuntime::worklog_append`, a `Command::Worklog` early-return block placed before `runtime.load_config()` (mirroring the `Init`/`Task` blocks), `Command::Worklog { .. }` added to the `unreachable!("filesystem-only commands return before config loading")` arm, and implementations on `ProductionRuntime` (delegates to `cli::commands::worklog_append`) and the test `FakeRuntime` (records `"worklog_append"`). New `lib.rs` test `worklog_append_dispatch_bypasses_config_and_telemetry_loading` asserts the call log is exactly `["worklog_append"]` — no config load, no telemetry, no admin socket. Added `mod worklog;` + a thin `worklog_append` wrapper to `cli/commands.rs`, and the new `cli/commands/worklog.rs` with a `run_append` / `run_append_with_context` split following `task.rs`, injecting `now: NaiveDateTime` via `Local::now().naive_local()` and taking `working_dir: &Path` + `out: &mut impl Write` for tests.

**Cycle 2 — local field validation (AC-2).** Added `reject_empty_field(name, value)` — trims and rejects empty/whitespace with `ServiceError::InvalidRequest` naming the field (`worklog entry field --<name> must not be empty`); `main.rs` already maps any `Err` to a non-zero exit. Called for all four fields at the top of `run_append_with_context`, before any filesystem access. Tests cover each field plus a pre-seeded-day-file case proving no file is created or modified on failure.

**Cycle 3 — reconcile before append (AC-3).** Inserted `reconcile_today(working_dir, now)?` from T-191 immediately before the T-190 `WorklogStore::append`. Test seeds a prior day's open item and asserts today's file contains the `Carried forward from 2026-08-29.md` marker (only the reconciliation pass writes it) at a byte offset earlier than the handler's own `Done` text — i.e. reconciliation ran and ran first.

**Cycle 4 — carried-forward set in output (AC-4).** Captured the `Vec<String>` returned by `reconcile_today` into `AppendedEntryOutput { item, path, carried_forward }`. Default output is human-readable (`recorded worklog entry: <item>` / `path: <path>` / `carried forward: <comma-joined | (none)>`); `--json` emits the struct via the existing `write_json_line`. Tests assert the carried identifier appears in both forms, and that an empty set is still reported explicitly (`carried forward: (none)` / `[]`).

**Tried and rejected.** Considered trimming the stored field values; kept them verbatim to match `task.rs`'s treatment of `title` (validate on trimmed, store raw). Considered omitting `path` from the confirmation to stay minimal; kept it because a write confirmation naturally states where it wrote and it matches the rest of the CLI. In cycle 3 the reconcile result was briefly discarded and then wired into output in cycle 4 to keep each cycle scoped to one AC.

**Verification.** `cargo build -p bob && cargo test -p bob worklog` → 42 pass. `cargo fmt --all -- --check` clean. `cargo test -p bob` → 277 pass / 1 ignored. `cargo test --workspace` → all suites pass (no sandbox UDS failures this run). `cargo doc -p bob --no-deps` clean. `cargo clippy -p bob` introduced no new warnings in the touched files.

**What remains.** Nothing for this task. `bob worklog list` (T-193) is the sibling subcommand and will reuse `reconcile_today` the same way; `format_carried_forward` and `AppendedEntryOutput` are local to `worklog.rs` and can be lifted to a shared helper if T-193 wants them.

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

Both review stages pass.

**Stage 1 — acceptance criteria (all five met):**

- **AC-1** — `run_cli_with_runtime` (`lib.rs`) handles `Command::Worklog` in an
  early-return `if let` block placed **before** `runtime.load_config()` /
  `runtime.init_telemetry()`, mirroring the `Command::Init` / `Command::Task`
  blocks, and `Command::Worklog { .. }` is added to the
  `unreachable!("filesystem-only commands return before config loading")` arm.
  The handler (`cli/commands/worklog.rs`) touches only `env::current_dir()`,
  `WorklogStore`, `reconcile_today`, and stdout — no `AdminClient`, no config.
  `lib.rs` test `worklog_append_dispatch_bypasses_config_and_telemetry_loading`
  asserts the runtime call log is exactly `["worklog_append"]`.
- **AC-2** — clap marks all four `--item/--done/--left/--next` as required
  `String` args (missing-flag → clap error naming the flag, non-zero exit);
  `reject_empty_field` runs for all four as the first statements of
  `run_append_with_context`, before `reconcile_today` / `WorklogStore::append`,
  returning `ServiceError::InvalidRequest { detail: "worklog entry field
  --<name> must not be empty" }`, which `main.rs` renders to stderr and maps to
  exit 1. Tests cover each empty field and prove no `worklog/` dir is created
  and a pre-seeded day file is byte-for-byte unchanged on validation failure.
- **AC-3** — `let carried_forward = reconcile_today(working_dir, now)?;`
  precedes the `WorklogStore::new(working_dir).append(now, &entry)?` call. Test
  `worklog_append_runs_reconciliation_before_writing_its_own_entry` seeds a
  prior-day open item and asserts the `Carried forward from 2026-08-29.md`
  marker lands at a byte offset earlier than the handler's own `Done` text.
- **AC-4** — success prints `recorded worklog entry: <item>` / `path: <path>` /
  `carried forward: <comma-joined | (none)>` by default, and with `--json`
  emits the `AppendedEntryOutput { item, path, carried_forward }` object on one
  line via `write_json_line`. Both forms carry the full carried-forward set
  returned by `reconcile_today` (not just this call's writes). Tests assert the
  carried identifier in both forms and explicit empty-set reporting
  (`carried forward: (none)` / `[]`).
- **AC-5** — `"worklog"` is added to the subcommand list asserted by
  `cli/mod.rs` test `help_lists_global_json_flag_and_all_subcommands`.

Scope is exactly the four files named in "Files to Touch"; no unexpected files
or unspecified behaviour. The `run_*` / `run_*_with_context` split, injected
`now`/`working_dir`/`out`, and `env::current_dir()` error mapping all follow the
established `cli/commands/task.rs` pattern.

**Stage 2 — code quality:** Correctness, tests (success + failure paths, each
with its own `tempdir`, independent), security (input validated, paths strictly
scoped to `<cwd>/worklog/` by the store per ADR-015, no secrets), readability
(focused functions, descriptive names, doc comments, no dead code), and
performance all pass.

**Verification (task branch `task/T-192-...`):**
`cargo build -p bob` clean; `cargo test -p bob worklog` → 42 passed;
`cargo fmt --all -- --check` clean; `cargo test --workspace` → all suites green
(no sandbox UDS failures this run). Pre-existing `bob` clippy debt not assessed
per CLAUDE.md.

**Minor observations (non-blocking, not in scope of the five ACs):**

1. `WorklogStore::append` returns `AppendOutcome { path, warnings }`; the
   handler uses `path` and discards `warnings`, so a pre-existing
   over-permissive `worklog/` directory (S-015 "Filesystem protection" —
   "a warning is the appropriate response") produces no user-visible notice.
   T-190's own AC is still satisfied at the store layer. Worth surfacing in a
   follow-up (e.g. alongside T-193) rather than blocking here.
2. Two modules are now named `worklog` — `crate::worklog` (store + reconcile)
   and `crate::cli::commands::worklog` (CLI handler). This mirrors the
   `task_board` / `task` split but with an identical leaf name; imports use
   fully-qualified paths so there is no ambiguity.
3. The thin `run_append` wrapper (`env::current_dir()` + `Local::now()`) has no
   direct unit test, consistent with how `task.rs` leaves its `run_*` wrappers
   untested and covers `run_*_with_context` instead.
