---
id: T-016
title: Implement bob tracing initialization
status: pending
priority: medium
assigned-role: unassigned
created: '2026-05-16'
spec: S-001
---

# Implement bob tracing initialization

## Description

Fill `crates/bob/src/telemetry.rs` (stubbed in T-014) with the `tracing`
subscriber initialization per Rust coding guidelines §6: a human-readable
formatter when `BobConfig.tracing_format == "pretty"`, a JSON formatter when
`"json"`. Filter level comes from `BobConfig.tracing_level`, overridable by
the `RUST_LOG` environment variable (handled by `tracing-subscriber`'s
`EnvFilter`). Initialize the global subscriber exactly once; the second call
in a process returns `Err(ServiceError::Configuration)` rather than panicking.

## Acceptance Criteria

AC-1: The system shall provide `bob::telemetry::init(cfg: &BobConfig)` that installs a global `tracing` subscriber configured by the given config.
AC-2: WHEN `cfg.tracing_format == "json"` THE SYSTEM SHALL configure `tracing_subscriber` to emit JSON-formatted records to stderr.
AC-3: WHEN `RUST_LOG` is set in the environment at startup THE SYSTEM SHALL honour it as an override of `cfg.tracing_level`.
AC-4: WHEN `bob::telemetry::init` is called twice in the same process THE SYSTEM SHALL return `Err(ServiceError::Configuration { detail })` on the second call without panicking.

## Dependencies

- `T-014` — `telemetry::init` stub already present
- `T-015` — `BobConfig` populated (uses `tracing_format`, `tracing_level`)

## Files to Touch

- `the-intern/service/crates/bob/src/telemetry.rs` — replace stub; full initialization
- `the-intern/service/crates/bob/Cargo.toml` — touch; add `tracing-subscriber` (features: `env-filter`, `json`)

## Verification

```bash
cd the-intern/service && cargo test -p bob telemetry::tests
cd the-intern/service && BOB_TRACING_FORMAT=json cargo run -p bob -- serve 2>&1 | head -1 | grep -q '"level"'
```

## Work Log

## Review
