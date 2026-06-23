---
id: T-101
title: Pass --extension to pi spawn and fail closed when the extension file is 
  missing
status: blocked
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
- `the-intern/service/crates/pi-agent-supervisor/src/pool.rs` — propagate
  `Config::extension_path` into `WorkerProcessConfig` for warm and overflow
  workers.
- `the-intern/service/crates/bob/src/serve.rs` — pass `extension_path` into the
  supervisor config.

## Verification

```bash
cd the-intern/service && cargo test -p pi-agent-supervisor && cargo test -p bob serve
```

## Work Log

<!-- Mandatory. Append one entry per session boundary. -->

### Session 1 — 2026-06-23

Inspected the canonical task, Rust coding guidance, supervisor configuration
flow, process spawning code, and Bob configuration mapping. Confirmed that
`pi` is available at `/usr/local/bin/pi`. The new extension path must pass
through `SessionPool::worker_process_config_for_session`, requiring a change to
`the-intern/service/crates/pi-agent-supervisor/src/pool.rs`, which was omitted
from the task's “Files to Touch.” Per the TDD scope-boundary rule,
implementation was escalated before writing tests or production code. No files
or branches were modified. The Architect confirmed `pool.rs` is necessary
plumbing within CR-003 and authorized the task amendment; implementation
remains.

### Session 2 — 2026-06-23

Resumed after Architect approval added `pool.rs` to scope. Added red tests for
exact `--extension <resolved path>` argv propagation, fail-closed handling of a
missing extension file with the expected path in the error,
supervisor-to-worker path propagation, and BobConfig-to-supervisor mapping. The
initial focused run failed because the new config fields were absent.
Implemented the minimal fields, propagation, pre-spawn file check, and command
arguments; all focused tests and all 42 `pi-agent-supervisor` tests pass.
Updated existing in-scope unit fixtures to use a valid extension file. Bob
serve unit tests pass outside the restricted Unix-socket sandbox. Verification
still fails because `crates/bob/tests/shell_e2e.rs` launches `bob serve` without
installing or configuring an extension, so the new required fail-closed
behavior exits before sockets appear. The completed core cycle is preserved in
commit `fb0df8e`; remaining work requires authorization for a fixture-only
change to `shell_e2e.rs`.

## Review

<!-- Reviewer: append verdict here after each review cycle. -->
