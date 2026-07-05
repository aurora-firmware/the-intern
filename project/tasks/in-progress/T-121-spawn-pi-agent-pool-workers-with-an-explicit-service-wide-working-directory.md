---
id: T-121
title: Spawn pi-agent pool workers with an explicit service-wide working 
  directory
status: pending
priority: high
assigned-role: developer
created: '2026-07-05'
spec: S-002
---

# Spawn pi-agent pool workers with an explicit service-wide working directory

## Description

The supervisor sets no working directory today, so workers inherit `bob serve`'s
launch cwd implicitly. Add an optional worker working directory to the supervisor
`Config` (`crates/pi-agent-supervisor/src/lib.rs`) and make `RpcWorkerProcess`
spawning (`crates/pi-agent-supervisor/src/process.rs`) set the child's
`current_dir` when it is configured; thread it through warm-worker spawning
(`crates/pi-agent-supervisor/src/pool.rs`). When unset, workers inherit the
launch cwd exactly as today. This is the **service-wide** cwd carried by
warm-pool workers; the per-entry override lands in T-122.

`pi_agent_supervisor::Config` derives no `Default` and is built with a full
struct literal in `build_pi_agent_supervisor_config`
(`crates/bob/src/serve.rs`, ~line 101), so adding the field breaks that site:
set `worker_cwd: None` there to keep the workspace compiling (T-126 replaces it
with the value resolved from `pi_agent_cwd`). Existence is not checked here — a
missing directory surfaces through the normal child-spawn error path.

## Acceptance Criteria

AC-1: The supervisor `Config` shall carry an optional worker working directory.
AC-2: WHEN the supervisor spawns a pool worker and a worker working directory is
      configured THE SYSTEM SHALL set that directory as the child process's
      current directory.
AC-3: WHILE no worker working directory is configured THE SYSTEM SHALL spawn
      workers that inherit the service's launch cwd.

## Dependencies

- None

## Files to Touch

- `crates/pi-agent-supervisor/src/lib.rs` — add the optional worker cwd to `Config`
- `crates/pi-agent-supervisor/src/process.rs` — set `current_dir` on spawn when set
- `crates/pi-agent-supervisor/src/pool.rs` — thread the cwd into warm-worker spawn
- `crates/bob/src/serve.rs` — set `worker_cwd: None` at the `Config` literal in
  `build_pi_agent_supervisor_config` (~line 101) to keep `bob` compiling

## Verification

```bash
cd the-intern/service && cargo test -p pi-agent-supervisor && cargo build -p bob
```

## Work Log

## Review
