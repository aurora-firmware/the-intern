---
id: T-015
title: Implement bob configuration loader with layered sources
status: pending
priority: high
assigned-role: unassigned
created: '2026-05-16'
spec: S-001
---

# Implement bob configuration loader with layered sources

## Description

Fill `crates/bob/src/config.rs` (stubbed in T-014) with the layered
configuration loader S-002 §Configuration describes. Precedence: safe defaults
→ optional TOML file (`$XDG_CONFIG_HOME/bob/config.toml` on Linux,
`~/Library/Application Support/bob/config.toml` on macOS) → environment
variables prefixed `BOB_` → CLI overrides (via `--config-key=value`).
Validate once at startup; fail fast with `ServiceError::Configuration`.

`BobConfig` fields land in this task: `admin_sock_path`, `extension_sock_path`,
`admin_allowed_uids: Vec<u32>`, `admin_allowed_gid: Option<u32>`,
`request_queue_capacity: usize`, `request_submit_timeout: Duration`,
`shutdown_drain_deadline: Duration`, `shutdown_reap_deadline: Duration`,
`tracing_level: String`, `tracing_format: String`,
`allowed_user_ids: Vec<UserId>`. Default socket paths:
`$XDG_RUNTIME_DIR/bob/admin.sock` and `…/extension.sock` on Linux;
`$TMPDIR/bob-$UID/admin.sock` and `…/extension.sock` on macOS.

## Acceptance Criteria

AC-1: The system shall provide `bob::config::BobConfig::load()` returning a populated `BobConfig` from layered sources in this precedence: defaults → optional TOML file → `BOB_`-prefixed environment variables → CLI overrides.
AC-2: WHEN no configuration sources are present THE SYSTEM SHALL return defaults whose `admin_sock_path` and `extension_sock_path` resolve under `$XDG_RUNTIME_DIR/bob/` on Linux and `$TMPDIR/bob-$UID/` on macOS.
AC-3: IF any configuration value fails validation (e.g., non-positive `request_queue_capacity`) THEN `BobConfig::load` SHALL return `Err(ServiceError::Configuration { detail })`.
AC-4: The system shall NOT include any field value flagged as secret-bearing in `tracing::*!` log output emitted by the loader.

## Dependencies

- `T-014` — binary skeleton and `BobConfig` stub already present

## Files to Touch

- `the-intern/service/crates/bob/src/config.rs` — replace stub; full loader and field set
- `the-intern/service/crates/bob/Cargo.toml` — touch; add `figment` (with `toml` and `env` features) and `serde` (with `derive`)

## Verification

```bash
cd the-intern/service && cargo test -p bob config::tests
cd the-intern/service && BOB_REQUEST_QUEUE_CAPACITY=0 cargo run -p bob -- serve 2>&1 | grep -q 'Configuration'
```

## Work Log

### Session 1 — 2026-05-17

Implemented the `bob` configuration loader in `config.rs` from the previous stub into a fully typed layered loader with startup validation. I added all required `BobConfig` fields, platform-aware socket defaults, optional TOML loading, `BOB_` environment overrides, and `--config-key=value` CLI overrides. I preserved public loader compatibility by keeping `config::load()` delegating to `BobConfig::load()`. I also adapted startup parsing in `main.rs` to strip `--config-*` flags from Clap parsing while keeping them visible to `BobConfig::load()` via raw process args.

For TDD, I added tests in `config::tests` for defaults, precedence order, validation failure, and tracing safety. I ran failing tests first where behavior was missing (env/cli precedence and validation), then implemented minimal merges and parsing to pass. I rejected a brittle log-content assertion that required a specific emitted message because it was unstable under full test execution; I kept the AC-4 assertion focused on absence of secret-bearing value leakage. I also adjusted runtime-root resolution to use `temp_dir()` fallback when `XDG_RUNTIME_DIR`/`TMPDIR` is unavailable so existing non-serve behavior remains intact.

Remaining work in this session: none in code. Branch is clean, all required verification commands pass, and commits were made per red->green->refactor cycles.

## Review
