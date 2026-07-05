---
id: T-119
title: Add pi_agent_cwd service-wide worker working-directory config key
status: pending
priority: high
assigned-role: developer
created: '2026-07-05'
spec: S-002
---

# Add pi_agent_cwd service-wide worker working-directory config key

## Description

Add the service-wide `pi_agent_cwd` configuration key (S-002 amendment).
`BobConfig` (`crates/bob/src/config.rs`) gains an optional `pi_agent_cwd` loaded
from a top-level `snake_case` `pi_agent_cwd` key in `config.toml` (ADR-002).
When set it must be an **absolute** path; a relative value is rejected at config
load with a clear configuration error naming the key. Unset → `None`, meaning
workers inherit the launch cwd of `bob serve` (pre-CR-005 behaviour, the v1
default). Directory **existence is not** checked at load (lazy / spawn-time
posture per the amendment). This task adds only the config surface + load
validation; wiring `pi_agent_cwd` into the supervisor happens in T-126.

## Acceptance Criteria

AC-1: The system shall expose an optional top-level `pi_agent_cwd` key parsed
      into `BobConfig`.
AC-2: IF `pi_agent_cwd` is set to a relative path THEN THE SYSTEM SHALL fail
      configuration loading with a clear error naming the key.
AC-3: WHILE `pi_agent_cwd` is unset THE SYSTEM SHALL leave the worker cwd unset
      so workers inherit the launch cwd.
AC-4: WHERE `pi_agent_cwd` names a non-existent directory THE SYSTEM SHALL still
      load configuration successfully (existence is not checked at load time).

## Dependencies

- None

## Files to Touch

- `crates/bob/src/config.rs` — add the `pi_agent_cwd` field, TOML parsing, and
  absolute-path load validation

## Verification

```bash
cd the-intern/service && cargo test -p bob config
```

## Work Log

## Review
