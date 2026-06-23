---
id: T-104
title: Add an interactive supervised pi-spawn mode to the pi-agent supervisor
status: pending
priority: high
assigned-role: developer
created: '2026-06-23'
spec: CR-002
---

# Add an interactive supervised pi-spawn mode to the pi-agent supervisor

## Description

Per CR-002 and the brokering decision from T-103, add a second spawn mode to the
pi-agent supervisor that launches an **interactive** pi session (distinct from the
`--mode rpc` worker), using the mechanism decided in T-103, with `--extension
<path>` (T-101) and the env contract (`BOB_SESSION_ID`, `BOB_EXTENSION_SOCK_PATH`)
set. The interactive session is tracked in the supervisor's session table so it
is visible to `sessions list` and is terminated on shutdown. This task is the
supervisor-side spawn + lifecycle only; wiring it to a client is T-105.

## Acceptance Criteria

AC-1: WHEN the supervisor is asked to start an interactive session THE SYSTEM
      SHALL spawn pi in interactive mode with `--extension <path>` and
      `BOB_SESSION_ID` / `BOB_EXTENSION_SOCK_PATH` set.

AC-2: WHILE an interactive session is running THE SYSTEM SHALL include it in the
      session table reported by `sessions list`.

AC-3: WHEN the service shuts down THE SYSTEM SHALL terminate active interactive
      sessions as part of child reaping.

AC-4: The system shall pass `cargo test -p pi-agent-supervisor`.

## Dependencies

- `T-101` — the `--extension` spawn argument and supervisor `Config` field.
- `T-103` — the verified pi interface and the brokering mechanism.

## Files to Touch

- `the-intern/service/crates/pi-agent-supervisor/src/lib.rs` — interactive-mode
  entry point + session-table tracking.
- `the-intern/service/crates/pi-agent-supervisor/src/process.rs` — interactive
  spawn (per T-103 mechanism).
- `the-intern/service/crates/pi-agent-supervisor/src/pool.rs` — lifecycle/reaping.

## Verification

```bash
cd the-intern/service && cargo test -p pi-agent-supervisor
```

## Work Log

<!-- Mandatory. Append one entry per session boundary. -->

## Review

<!-- Reviewer: append verdict here after each review cycle. -->
