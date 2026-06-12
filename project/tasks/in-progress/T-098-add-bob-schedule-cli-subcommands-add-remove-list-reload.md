---
id: T-098
title: Add bob schedule CLI subcommands (add/remove/list/reload)
status: pending
priority: high
assigned-role: developer
created: '2026-06-12'
spec: S-009
---

# Add bob schedule CLI subcommands (add/remove/list/reload)

## Description

S-009 Component 4: add `bob schedule` to the CLI, following the exact pattern
of `bob policy` (a thin admin-RPC client).

**Subcommands:**

- `bob schedule add --id <ID> --cron <EXPR> --prompt <TEXT>` — calls
  `schedule.add` RPC; prints confirmation or error.
- `bob schedule remove --id <ID>` — calls `schedule.remove`; prints
  confirmation or error.
- `bob schedule list [--json]` — calls `schedule.list`; prints a table of
  jobs (human-readable by default, JSON with `--json`).
- `bob schedule reload` — calls `schedule.reload`; prints confirmation.

**Changes:**

1. `crates/bob/src/cli/mod.rs` — add `Schedule { command: ScheduleCommand }`
   variant to `Command` enum; define `ScheduleCommand` enum with `Add`,
   `Remove`, `List`, `Reload` variants and their clap fields.

2. `crates/bob/src/cli/commands/schedule.rs` — new file; implement `run()`
   and `run_with_caller()` following the `policy.rs` / `sessions.rs` pattern,
   with unit tests for each subcommand verifying the correct RPC method and
   params are called.

3. `crates/bob/src/cli/commands.rs` — add `pub fn schedule_*` dispatch
   functions routing to `schedule::run()`.

4. `crates/bob/src/lib.rs` — three additions (do **not** edit `main.rs`,
   which only calls `run_cli()` and needs no changes):
   - Add `fn schedule_add`, `fn schedule_remove`, `fn schedule_list`,
     `fn schedule_reload` methods to the `DispatchRuntime` trait.
   - Add default implementations on `ProductionRuntime` that delegate to
     the new `commands::schedule_*` functions.
   - Add `Command::Schedule { command }` arm to `run_cli_with_runtime`,
     matching on `ScheduleCommand::Add`, `Remove`, `List`, `Reload`.
   - Add stub implementations to the test `MockRuntime` struct so existing
     tests continue to compile.

The `--prompt` value for `add` may contain spaces; ensure clap treats it as a
single argument (use `#[arg(long)]` without `num_args`; quoting is the shell's
responsibility).

## Acceptance Criteria

AC-1: The system shall parse `bob schedule add --id foo --cron "* * * * *" --prompt "check mail"`
      without error and call the `schedule.add` RPC with params
      `{ "id": "foo", "cron": "* * * * *", "prompt": "check mail" }`.

AC-2: The system shall parse `bob schedule remove --id foo` and call
      `schedule.remove` with `{ "id": "foo" }`.

AC-3: WHEN `bob schedule list` is run without `--json` THE SYSTEM SHALL print
      one human-readable line per job showing id, cron, and prompt.

AC-4: WHERE `--json` is passed to `bob schedule list` THE SYSTEM SHALL print
      the raw JSON response as a single line.

AC-5: The system shall pass `cargo test -p bob` (including the new schedule
      command unit tests) with no new failures.

## Dependencies

- `T-097` — the RPC methods must exist before the CLI client calls them

## Files to Touch

- `the-intern/service/crates/bob/src/cli/mod.rs` — add `Schedule` command
  and `ScheduleCommand` enum
- `the-intern/service/crates/bob/src/cli/commands/schedule.rs` — new file
- `the-intern/service/crates/bob/src/cli/commands.rs` — add schedule dispatch
  functions
- `the-intern/service/crates/bob/src/lib.rs` — add `DispatchRuntime` trait
  methods, `ProductionRuntime` implementations, and `Command::Schedule` arm

## Verification

```bash
cd the-intern/service
cargo test -p bob
cargo run -p bob -- schedule --help
```

## Work Log

### Session 1 — 2026-06-12

**What was done**

Implemented all four `bob schedule` CLI subcommands following the exact `policy.rs` / `sessions.rs` pattern.

1. **`commands/schedule.rs`** — new file; `run_add`, `run_remove`, `run_list`, `run_reload` public entry points with inner `*_with_caller` layers for testability. 8 unit tests covering correct RPC method, correct params, and human/JSON output for every subcommand.

2. **`commands.rs`** — added `mod schedule;` and four `pub fn schedule_*` dispatch functions.

3. **`cli/mod.rs`** — added `Schedule { command: ScheduleCommand }` to `Command` enum; `ScheduleCommand` enum with `Add { id, cron, prompt }`, `Remove { id }`, `List { json }`, `Reload`, all `#[arg(long)]`.

4. **`lib.rs`** — added `schedule_add/remove/list/reload` to `DispatchRuntime` trait; `ProductionRuntime` implementations delegating to `commands::schedule_*`; `Command::Schedule` arm in `run_cli_with_runtime`; `NotImplemented` stubs in `FakeRuntime`.

**What was tried and rejected**

Nothing. The `policy.rs` pattern was directly applicable.

**What remains**

Nothing. All five acceptance criteria satisfied.

**Obstacles Encountered**

Minor: `cargo fmt` reformatted several multi-line assertions; applied before committing.

**Final branch state:** commit `86dd2fa`, 115 bob tests pass, formatting clean.

## Review
