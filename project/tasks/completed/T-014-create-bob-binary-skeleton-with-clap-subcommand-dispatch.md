---
id: T-014
title: Create bob binary skeleton with clap subcommand dispatch
status: completed
priority: high
assigned-role: unassigned
created: '2026-05-16'
spec: S-001
---

# Create bob binary skeleton with clap subcommand dispatch

## Description

Create the `bob` binary crate under `the-intern/service/crates/bob/`. Picked
up by the workspace's `crates/*` glob from T-007. The binary uses `clap`
derive to define every subcommand named in S-002 §Component 7: `serve`,
`status`, `sessions list`, `sessions kill <id>`, `audit tail`, `policy reload`,
`chat [--session <id>]`. Every subcommand accepts a global `--json` flag.

`src/main.rs` is the entry point: it parses arguments, calls
`bob::config::load()`, `bob::telemetry::init(&cfg)`, then dispatches the
subcommand. The `serve` arm calls `bob::serve::run(cfg).await` under
`#[tokio::main]`; every other arm currently calls a stub in
`bob::cli::commands::*` that returns "not implemented" so the binary
compiles and behaves predictably. Placeholders are wired so that T-015,
T-016, T-017, and T-024 each fill in one module without touching `main.rs`.

`BobConfig` is exposed as `bob::config::BobConfig` (full fields land in T-015;
T-014 provides a stub struct with defaults).

## Acceptance Criteria

AC-1: The system shall provide a binary crate `bob` under `the-intern/service/crates/bob/` with subcommands `serve`, `status`, `sessions`, `audit`, `policy`, and `chat` defined via `clap` derive.
AC-2: WHEN `bob --help` is invoked THE SYSTEM SHALL list every subcommand named in AC-1 and a global `--json` flag.
AC-3: WHEN `bob serve` is invoked THE SYSTEM SHALL call `bob::config::load()`, then `bob::telemetry::init(&cfg)`, then `bob::serve::run(cfg)` in that order.
AC-4: WHEN any non-`serve` subcommand is invoked while the placeholders are still in place THE SYSTEM SHALL exit with code 1 and print "not implemented" to stderr.
AC-5: The system shall expose a public type `bob::config::BobConfig` (stub fields acceptable) used by `serve::run`.

## Dependencies

- `T-007` — workspace
- `T-009` — `ServiceError` used in stub return types

## Files to Touch

- `the-intern/service/crates/bob/Cargo.toml` — new; deps: `clap` (derive), `tokio` (rt-multi-thread, macros, signal), `bob-core`, `tracing`
- `the-intern/service/crates/bob/src/main.rs` — new; entry + dispatch
- `the-intern/service/crates/bob/src/cli/mod.rs` — new; clap definitions
- `the-intern/service/crates/bob/src/config.rs` — new; `BobConfig` stub
- `the-intern/service/crates/bob/src/telemetry.rs` — new; `init` stub
- `the-intern/service/crates/bob/src/serve.rs` — new; `run` stub
- `the-intern/service/crates/bob/src/cli/commands.rs` — new; placeholder dispatcher

## Verification

```bash
cd the-intern/service && cargo build -p bob
cd the-intern/service && cargo run -p bob -- --help | grep -E 'serve|status|sessions|audit|policy|chat'
cd the-intern/service && cargo run -p bob -- status 2>&1 | grep -q 'not implemented'
```

## Work Log

### Session 1 — 2026-05-17

Implemented `T-014` by creating the new `bob` crate and driving it through two TDD cycles. In cycle 1, I added a failing CLI help test for global `--json` and full subcommand coverage, then implemented clap derive command structures for `serve`, `status`, `sessions list`, `sessions kill <id>`, `audit tail`, `policy reload`, and `chat --session <id>`, plus stub module files and base crate wiring. In cycle 2, I added failing tests for serve bootstrap/dispatch order and non-serve binary behavior, then introduced a testable dispatch structure (`DispatchRuntime` + `run_cli_with_runtime`) and production runtime wiring so execution order is `config::load()` -> `telemetry::init(&cfg)` -> dispatch, with `serve` calling `serve::run(cfg).await`. Non-serve paths now return `ServiceError::NotImplemented`, and `main` maps errors to stderr + exit code 1. I tried running formatter commands, but `cargo fmt`/`rustfmt` are unavailable in this environment, so formatting was kept consistent manually. No remaining implementation work for this task's acceptance criteria.

## Review

### Review Verdict — 2026-05-17
PASS

Stage 1 (acceptance criteria) passed:
- AC-1 met: `bob` crate exists at `the-intern/service/crates/bob/` with clap derive subcommands `serve`, `status`, `sessions`, `audit`, `policy`, `chat` in `src/cli/mod.rs`.
- AC-2 met: help output includes all required subcommands and global `--json` (validated by unit test and command check).
- AC-3 met: `run_cli_with_runtime` executes `load_config` -> `init_telemetry` -> dispatch, and `serve` dispatch calls `serve::run(cfg)`; ordering covered by `serve_dispatch_calls_load_then_telemetry_then_serve`.
- AC-4 met: non-serve command handlers return `ServiceError::NotImplemented`; `main` prints error to stderr and exits with code 1; covered by `tests/non_serve.rs`.
- AC-5 met: public `bob::config::BobConfig` exists and is used by `serve::run(cfg: BobConfig)`.

Stage 2 (code quality) passed:
- Correctness, test coverage for key paths, readability, and performance are appropriate for skeleton scope.
- No security concerns identified in the reviewed scope.

Next owner: Development Loop.
