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

## Review
