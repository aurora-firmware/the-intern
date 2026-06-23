---
id: T-101
title: Pass --extension to pi spawn and fail closed when the extension file is 
  missing
status: in-progress
priority: high
assigned-role: developer
created: '2026-06-23'
spec: CR-003
---

# Pass --extension to pi spawn and fail closed when the extension file is missing

## Description

Per CR-003 and the amended S-003, the pi-agent supervisor must pass the resolved
extension to pi via `pi --extension <path>` on every spawn, and must fail closed
if the extension file is absent (the extension is the S-004 `tool_call` authz
membrane — a session must not run without it). Plumb the resolved
`extension_path` (T-100) into `pi_agent_supervisor::Config` (new field), build it
in `build_pi_agent_supervisor_config` in `crates/bob/src/serve.rs`, and add the
`--extension <path>` argument in the spawn command. Before spawning, check the
path exists; if not, the spawn fails with a clear error naming the expected path.

## Acceptance Criteria

AC-1: WHEN the supervisor spawns a pi process THE SYSTEM SHALL include
      `--extension <resolved extension_path>` in the pi command line.

AC-2: IF the resolved extension file does not exist THEN THE SYSTEM SHALL refuse
      to spawn pi and return an error that names the expected path.

AC-3: The system shall plumb the resolved extension path from `BobConfig` into
      the supervisor `Config`.

AC-4: The system shall pass `cargo test -p pi-agent-supervisor` and
      `cargo test -p bob`.

## Dependencies

- `T-100` — provides the resolved `extension_path` on `BobConfig`.

## Files to Touch

- `the-intern/service/crates/pi-agent-supervisor/src/lib.rs` — add
  `extension_path` to `Config`.
- `the-intern/service/crates/pi-agent-supervisor/src/process.rs` — add
  `--extension`, add the fail-closed existence check.
- `the-intern/service/crates/bob/src/serve.rs` — pass `extension_path` into the
  supervisor config.

## Verification

```bash
cd the-intern/service && cargo test -p pi-agent-supervisor && cargo test -p bob serve
```

## Work Log

<!-- Mandatory. Append one entry per session boundary. -->

## Review

<!-- Reviewer: append verdict here after each review cycle. -->
