---
id: T-125
title: Add --cwd flag to bob schedule add and render cwd in schedule list
status: pending
priority: high
assigned-role: developer
created: '2026-07-05'
spec: S-009
---

# Add --cwd flag to bob schedule add and render cwd in schedule list

## Description

Expose the per-entry cwd on the CLI. Add an optional `--cwd <dir>` flag to `bob
schedule add` (`crates/bob/src/cli/mod.rs`), validated to be an **absolute** path
and mapped to the `schedule.add` `cwd` parameter; do **not** require the directory
to exist at add time (existence is a fire-time concern). Thread the value through
the dispatch runtime trait/impls (`crates/bob/src/lib.rs`), the command args
(`crates/bob/src/cli/commands.rs`), and the schedule command
(`crates/bob/src/cli/commands/schedule.rs`), and render each entry's `cwd` in both
the human and `--json` output of `bob schedule list`. Follow the existing
`--prompt`/`--file` handling as the pattern.

## Acceptance Criteria

AC-1: `bob schedule add` shall expose an optional `--cwd <dir>` flag mapped to the
      `schedule.add` `cwd` parameter.
AC-2: IF `--cwd` is given a relative path THEN THE SYSTEM SHALL fail the command
      with a clear error without contacting the service.
AC-3: WHEN `bob schedule list` renders an entry that has a `cwd` THE SYSTEM SHALL
      include that cwd in both the human and `--json` output.

## Dependencies

- `T-124` — `schedule.add` `cwd` parameter and `schedule.list` `cwd` output

## Files to Touch

- `crates/bob/src/cli/mod.rs` — add the `--cwd` argument to `schedule add`
- `crates/bob/src/cli/commands/schedule.rs` — validate + pass `cwd`; render in list
- `crates/bob/src/cli/commands.rs` — thread `cwd` through the command args
- `crates/bob/src/lib.rs` — thread `cwd` through the dispatch runtime trait/impls

## Verification

```bash
cd the-intern/service && cargo build -p bob && cargo test -p bob cli
```

## Work Log

### Session 1 — 2026-07-05

Implemented all three acceptance criteria for T-125 in three TDD cycles, each committed separately on `task/T-125-add-cwd-flag-to-bob-schedule-add-and-render-cwd-in-schedule-list`.

**AC-1 (optional `--cwd` flag mapped to `schedule.add`):** Added `--cwd: Option<String>` to `ScheduleCommand::Add` in `cli/mod.rs`, following the doc-comment style of the existing `--file` field. Threaded it as `Option<&str>` through the `DispatchRuntime` trait and both its impls (`ProductionRuntime` and the test `FakeRuntime`) in `lib.rs`, through `cli::commands::schedule_add`, and into `schedule::run_add` → `run_add_with_config` → `run_add_with_caller`, where it's merged into the `schedule.add` JSON params only when present (so omitting `--cwd` still omits the `cwd` key entirely, matching T-124's server-side contract). Wrote clap-parsing tests confirming the flag parses to `Some(...)` and defaults to `None`, plus caller-level tests confirming the RPC params include/omit `cwd` correctly.

**AC-2 (relative `--cwd` fails without contacting the service):** Added a small `validate_cwd` pure function in `schedule.rs`, mirroring the existing `resolve_add_source` pattern (which validates `--file` before `load_config()` is ever called). It checks `Path::is_absolute()` only — no canonicalization and no existence check, per the task's explicit "do not require the directory to exist at add time" instruction. Wired it into `run_add` right after `resolve_add_source`, before `load_config()`/any RPC call. Tested `validate_cwd` directly for accept-absolute, accept-none, and reject-relative (asserting the error message mentions both "cwd" and "absolute"). This mirrors the project's existing test rigor for `--file` (which is also only unit-tested at the resolver level, not via a full "did we hit the socket" integration test) rather than inventing a new integration-test style not otherwise used in this file.

**AC-3 (render `cwd` in `schedule list` output):** Added a test confirming the `--json` path already includes `cwd` via passthrough of the `schedule.list` RPC response (it does — T-124 added `cwd` server-side already), so no production change was needed there; this is now a regression test. For the human-readable path, updated `write_human_schedule` to append `  cwd: <path>` to the line when the entry has a `cwd`, and to omit it otherwise (verified with two tests: one with `cwd` set, one without).

**Rejected approaches:** Considered making `cwd` part of the `AddSource` enum (like `Prompt`/`File`) since the task said "follow the existing `--prompt`/`--file` pattern," but rejected this because `cwd` is explicitly independent/orthogonal to the prompt source (not mutually exclusive with anything, can combine with either `--prompt` or `--file`), which matches how the admin-rpc dispatch handler already treats it (`raw_cwd` is read and applied separately from the prompt/file mutual-exclusion block). Kept `cwd: Option<&str>` as a separate parameter threaded alongside `AddSource` instead.

**Remaining work:** None for this task. Full `cargo test --workspace` passes (all crates green) and `cargo fmt --all -- --check` is clean. Only the four files listed under "Files to Touch" were modified.

**Obstacles Encountered:** None. `pi` binary was not needed for this CLI-only task (no `serve`/e2e tests touched); dependency T-124 was already completed and merged, so the `schedule.add`/`schedule.list` RPC layer already supported `cwd` — only the CLI needed wiring.

## Review
