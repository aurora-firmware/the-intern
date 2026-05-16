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

## Review
