---
id: T-121
title: Spawn pi-agent pool workers with an explicit service-wide working 
  directory
status: completed
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

### Review Verdict — 2026-07-05

PASS

**Stage 1 — Acceptance Criteria:**
- AC-1 (Config carries an optional worker working directory): met. `pi_agent_supervisor::Config` in `crates/pi-agent-supervisor/src/lib.rs` gained `pub worker_cwd: Option<PathBuf>`, defaulted to `None` in `impl Default for Config`. Covered by `tests::default_config_leaves_worker_cwd_unset` and `tests::config_carries_configured_worker_cwd`.
- AC-2 (spawn sets `current_dir` when a worker cwd is configured): met. `RpcWorkerProcess::spawn` in `crates/pi-agent-supervisor/src/process.rs` calls `cmd.current_dir(worker_cwd)` only when `cfg.worker_cwd` is `Some`. `SessionPool::worker_process_config_for_session` in `pool.rs` threads `cfg.worker_cwd.clone()` into `WorkerProcessConfig`, and this helper is shared by both the warm-worker spawn path and the on-demand acquire-session spawn path, so the behavior applies uniformly. Covered by a real-spawn test (`process::tests::spawn_sets_current_dir_on_child_when_worker_cwd_is_configured`, spawns `sh -c pwd` into a temp dir and asserts the canonicalized reported cwd matches) and a pool-level threading test (`pool::tests::worker_process_config_carries_configured_worker_cwd`).
- AC-3 (unconfigured worker cwd inherits launch cwd): met. When `worker_cwd` is `None`, `current_dir` is never called on the `Command`, so the child inherits the parent's cwd unchanged, matching today's behavior. Covered by `process::tests::spawn_inherits_launch_cwd_when_worker_cwd_is_not_configured`, which asserts the child's reported cwd equals `std::env::current_dir()`.
- No unspecified behavior or functionality was added. `build_pi_agent_supervisor_config` in `crates/bob/src/serve.rs` sets `worker_cwd: None` exactly as the task instructs, with a comment pointing at T-126.
- One file outside "Files to Touch" was modified: `crates/bob/tests/scheduler_execution_e2e.rs`, which also constructs `pi_agent_supervisor::Config` directly and needed `worker_cwd: None` to keep compiling under `cargo test --workspace`. This is the same mechanical, minimal, non-design fix the task explicitly authorizes for the analogous `serve.rs` site, not scope creep, and was called out plainly in the Work Log.

**Stage 2 — Code Quality:**
- Correctness: `current_dir` is only invoked conditionally on `Some`, preserving exact prior behavior for the unset case; existence of the directory is intentionally left unchecked per the task description, surfacing through the normal child-spawn error path.
- Tests: both success (configured cwd honored) and default (inherits launch cwd) paths are covered with real child-process spawns, which is an appropriate use of the "boundary under test" exception in `coding-guidelines-rust.md` section 10. Tests use unique temp-directory names (keyed off a fresh `SessionId`) so they do not share mutable state. The pool-level test was confirmed non-vacuous by an intentional revert-and-rerun cycle recorded in the Work Log.
- Security: no secrets, no unvalidated external input introduced.
- Readability: new field and parameters are documented with doc comments explaining the `None` semantics; no dead code.
- Performance: no added loops or blocking calls; `current_dir` is a cheap, synchronous builder call on `tokio::process::Command` before spawn.

**Verification performed independently:** built a git worktree at the reviewed branch tip (`fda80cc`) and ran `cargo fmt --all -- --check` (clean), `cargo test -p pi-agent-supervisor` (56 passed, including all new AC tests), `cargo build -p bob` (succeeds), and `cargo test --workspace` (all crates green, no failures) — matching and extending the task's own verification command.

**Minor, non-blocking observation:** three of the four task-branch commit subject lines (`test(pi-agent-supervisor): lock down warm-worker cwd threading through pool`, `feat(pi-agent-supervisor): set child current_dir from configured worker cwd`, `feat(pi-agent-supervisor): add optional service-wide worker cwd to Config`) run 73-75 characters, slightly over the git-conventions ≤72-char guideline. This is not flagged as a failing criterion because the same overage (and considerably larger, up to 85 chars) is already present in commits merged into `dev-agent`'s recent history, so it is consistent with established project practice rather than a regression introduced here.
