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

### Session 1 — 2026-07-05

Implemented T-121 end to end via TDD across three red→green→refactor cycles, each committed separately on the task branch.

**Cycle 1 (AC-1):** Added `worker_cwd: Option<PathBuf>` to `pi_agent_supervisor::Config` in `lib.rs`, with `None` as the default so existing behavior (inherit launch cwd) is preserved when unset. Wrote `default_config_leaves_worker_cwd_unset` and `config_carries_configured_worker_cwd` first, confirmed they failed to compile (missing field), then added the field, updated the `Default` impl, and fixed the two other `Config` literals in `lib.rs`'s and `pool.rs`'s test modules that needed the new field to keep compiling. Also updated `build_pi_agent_supervisor_config` in `bob/src/serve.rs` to set `worker_cwd: None` per the task's explicit instruction, and confirmed `cargo build -p bob` still succeeds.

**Cycle 2 (AC-2/AC-3):** Added `worker_cwd: Option<PathBuf>` to `process::WorkerProcessConfig` and wired `cmd.current_dir(worker_cwd)` into `RpcWorkerProcess::spawn` when configured. Wrote two tests: one that creates a real temp directory, configures it as `worker_cwd`, spawns a `sh -c 'pwd'` child, and asserts the canonicalized reported cwd matches; and one that leaves `worker_cwd` unset and asserts the child's reported cwd matches `std::env::current_dir()` (the test process's launch cwd) — this directly exercises AC-3's "inherit launch cwd" requirement. Confirmed both failed to compile before implementing, then implemented the minimal `current_dir` call and updated the remaining `WorkerProcessConfig` literals across `process.rs`'s test module. Also updated `pool.rs`'s `worker_process_config_for_session` to pass `cfg.worker_cwd.clone()` through (needed for the crate to compile against the now-required field).

**Cycle 3 (pool threading lock-down):** Since the pool-level threading landed as a side effect of cycle 2's type requirements rather than from a dedicated failing test, added a targeted unit test `worker_process_config_carries_configured_worker_cwd` in `pool.rs`. To confirm the test wasn't vacuous, temporarily reverted the threading line to `worker_cwd: None`, reran the test and observed the expected failure (`left: None, right: Some("/opt/bob/workspace")`), then restored the correct implementation and reran to confirm green. Committed as a `test(...)` commit since production code was already correct.

**Post-cycle full-suite check:** Ran `cargo test --workspace` (broader than the task's own verification command) and found one more construction site of `pi_agent_supervisor::Config` in `crates/bob/tests/scheduler_execution_e2e.rs` that the task's "Files to Touch" list didn't anticipate. Applied the same mechanical `worker_cwd: None` fix there (analogous to the `serve.rs` instruction) rather than escalating, since it's a direct, minimal, non-design consequence of the new field and is necessary to keep the full workspace test suite (which CI runs) compiling. Committed as a `fix(bob)` commit. Ran `cargo fmt --all -- --check`, `cargo test -p pi-agent-supervisor && cargo build -p bob` (task's exact verification command), and `cargo test --workspace` one final time — all green, no failures anywhere.

**What remains:** Nothing outstanding for T-121 itself. Per the task description, T-122 will add the per-entry cwd override and T-126 will replace the `worker_cwd: None` placeholders in `serve.rs` (and now also `scheduler_execution_e2e.rs`) with the value resolved from `BobConfig.pi_agent_cwd`. No rejected approaches worth recording — the implementation path matched the task description closely; the only judgment call was whether to touch the untracked e2e test file, resolved in favor of the minimal compiling fix rather than escalation, since it mirrors the exact `serve.rs` instruction already given in the task body.

**Obstacles Encountered:** `crates/bob/tests/scheduler_execution_e2e.rs` constructs `pi_agent_supervisor::Config` directly and was not listed in the task's "Files to Touch," but adding the new field broke `cargo test --workspace` there. Applied the same minimal, mechanical `worker_cwd: None` fix used for `serve.rs` rather than escalating, since it is a direct, unavoidable consequence of the struct field addition the task itself authorizes.

## Review
