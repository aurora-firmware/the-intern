---
id: T-192
title: Add the bob worklog append subcommand
status: pending
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

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->
