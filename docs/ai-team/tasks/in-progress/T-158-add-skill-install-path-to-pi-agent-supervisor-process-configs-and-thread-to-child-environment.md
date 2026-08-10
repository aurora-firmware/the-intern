---
id: T-158
title: Add skill_install_path to pi-agent-supervisor process configs and thread 
  to child environment
status: pending
priority: high
assigned-role: developer
created: '2026-08-09'
spec: S-011
---

# Add skill_install_path to pi-agent-supervisor process configs and thread to child environment

## Description

S-011 Implementation Order Phase 4. Add a `skill_install_path:
Option<PathBuf>` field to the pi-agent-supervisor crate's per-spawn-path
config structs (`WorkerProcessConfig` and `InteractiveProcessConfig` in
`the-intern/service/crates/pi-agent-supervisor/src/{lib.rs,process.rs}`) and
set it as a new `BOB_SKILL_INSTALL_PATH` environment variable on the spawned
child in both `RpcWorkerProcess::spawn` and `InteractiveProcess::spawn`
(`process.rs`), mirroring exactly how `BOB_EXTENSION_SOCK_PATH` is already
conditionally set from `extension_sock_path`. When the resolved path is
empty/unset, the env var must be omitted rather than set to an empty
string, so the extension (T-160) can distinguish "not configured" from
"configured but empty" — matching ADR-014 §4's fail-open behaviour (missing
path → no skills, not a spawn failure). This task is independent of
`BobConfig` itself (T-157); it only extends the supervisor crate's own
config surface, the same split T-119/T-121 used for `pi_agent_cwd`.

**Interactive path note (verified against current code):** the
`pi_agent_cwd`/`extension_path` precedent does not fully carry over here.
`InteractiveProcessConfig` is constructed in `Actor::run`'s
`Command::StartInteractiveSession` arm (`lib.rs`) from caller-supplied
parameters routed through `Handle::start_interactive_session` from
`admin-rpc`, which never consults the actor's own `Config` on that path
(CR-005 precedent). T-159's `serve.rs` wiring alone therefore cannot reach
interactive sessions — this task must have the actor's
`StartInteractiveSession` handler populate `InteractiveProcessConfig.skill_install_path`
directly from the actor's own `Config.skill_install_path` (AC-4 below),
without adding a new parameter to `start_interactive_session` or touching
`admin-rpc`.

## Acceptance Criteria

AC-1: The system shall add an optional `skill_install_path` field to both
      `WorkerProcessConfig` and `InteractiveProcessConfig`.
AC-2: WHEN `skill_install_path` is set and non-empty on either config THE
      SYSTEM SHALL set `BOB_SKILL_INSTALL_PATH` on the spawned child's
      environment to that value.
AC-3: WHILE `skill_install_path` is unset or empty THE SYSTEM SHALL NOT set
      `BOB_SKILL_INSTALL_PATH` on the spawned child's environment, and
      spawning shall still succeed.
AC-4: WHEN the actor handles `Command::StartInteractiveSession` THE SYSTEM
      SHALL populate the resulting `InteractiveProcessConfig.skill_install_path`
      from the actor's own `Config.skill_install_path`, so interactive
      sessions carry the service-wide value without a new RPC parameter.

## Dependencies

- None

## Files to Touch

- `the-intern/service/crates/pi-agent-supervisor/src/process.rs` — add the
  field to both config structs and set the env var in both `spawn`
  implementations
- `the-intern/service/crates/pi-agent-supervisor/src/lib.rs` — thread the
  field through the crate's own `Config` type and populate it on the
  `StartInteractiveSession` handling path (AC-4)
- `the-intern/service/crates/pi-agent-supervisor/src/pool.rs` — map the new
  field in `SessionPool::worker_process_config_for_session` and the
  dedicated-worker variant, mirroring the existing `worker_cwd` mapping

## Verification

```bash
cd the-intern/service && cargo test -p pi-agent-supervisor
```

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

### Session 1 — 2026-08-10

Implemented T-158 end to end via TDD across two red→green→refactor cycles, each committed separately on the task branch (`f6fb312`, `b9a54e5`).

**Cycle 1 (AC-1/AC-2/AC-3, worker path):** Added `skill_install_path: Option<PathBuf>` to `process::WorkerProcessConfig` and to the crate's own `Config` in `lib.rs`. Wrote three `RpcWorkerProcess::spawn` tests first (`spawn_sets_bob_skill_install_path_when_path_is_non_empty`, `spawn_omits_bob_skill_install_path_when_unset`, `spawn_omits_bob_skill_install_path_when_path_is_empty`) mirroring the existing `extension_sock_path` test trio exactly, confirmed they failed to compile (missing field), then added the field and the conditional `cmd.env("BOB_SKILL_INSTALL_PATH", ...)` call guarded on `Some(path) if !path.as_os_str().is_empty()`. Because Rust's exhaustive struct literals mean a new field on `WorkerProcessConfig` immediately breaks `pool.rs`'s `worker_process_config_for_session`, which in turn needs the field on `Config`, the `Config` field addition (with its own two tests: `default_config_leaves_skill_install_path_unset`, `config_carries_configured_skill_install_path`) and the `pool.rs` mapping (with `worker_process_config_carries_configured_skill_install_path`) were bundled into this same cycle rather than treated as artificially separate steps — the compiler forced this atomicity. Updated every other `WorkerProcessConfig`/`Config` literal in `process.rs`, `lib.rs`, and `pool.rs`'s test modules to keep compiling. Discovered the field addition also broke `cargo build -p bob` (`serve.rs`'s `build_pi_agent_supervisor_config`) and `cargo test --workspace` (`scheduler_execution_e2e.rs`, 4 sites) — see Obstacles below for how this was resolved by following the T-121 precedent rather than escalating.

**Cycle 2 (AC-1/AC-2/AC-3 interactive path + AC-4):** Added the mirrored `skill_install_path` field to `InteractiveProcessConfig` and the same conditional env-setting call to `InteractiveProcess::spawn`. Wrote two new tests first (`interactive_spawn_sets_bob_skill_install_path_when_path_is_non_empty`, `interactive_spawn_omits_bob_skill_install_path_when_unset`), confirmed compile failure, implemented. For AC-4, wrote `start_interactive_session_populates_skill_install_path_from_actor_config` in `lib.rs` — an actor-level test using `Handle::start_interactive_session` with a script that echoes `$BOB_SKILL_INSTALL_PATH` to a redirected file — confirmed it failed to compile (field missing on the construction site inside `Actor::run`'s `StartInteractiveSession` arm), then wired `skill_install_path: self.cfg.skill_install_path.clone()` there. Verified the test was non-vacuous by temporarily reverting that line to `None`, confirming the expected assertion failure, then restoring the correct wiring. Updated the remaining `InteractiveProcessConfig` literals across `process.rs`'s and `pool.rs`'s test modules.

**Post-cycle full-suite check:** Ran `cargo test -p pi-agent-supervisor` (74 passed), `cargo build -p bob`, `cargo test --workspace` (all crates green, 0 failures), and `cargo fmt --all -- --check` (clean) — all green.

**What remains:** Nothing outstanding for T-158 itself. T-159 (already pending, depends on T-157 and T-158) will replace the `skill_install_path: None` placeholders in `serve.rs` and `scheduler_execution_e2e.rs` with the value resolved from `BobConfig.skill_install_path`, exactly as its task file already describes. No rejected implementation approaches worth recording beyond the file-scope judgment call documented below — the implementation matched the task description and the T-121/pi_agent_cwd precedent very closely throughout.

Obstacles Encountered:
- The task's "Files to Touch" list (`process.rs`, `lib.rs`, `pool.rs`) did not include `crates/bob/src/serve.rs` or `crates/bob/tests/scheduler_execution_e2e.rs`, but both construct `pi_agent_supervisor::Config` with exhaustive struct literals (no `..Default::default()`), so adding the field broke `cargo build -p bob` and `cargo test --workspace`. This is the exact situation the TDD skill's escalation criteria describe ("modifying a file not listed under Files to Touch"). However, T-121's completed Work Log (`docs/ai-team/tasks/completed/T-121-...md`) documents identical precedent for the analogous `worker_cwd` field: the task explicitly authorized a `worker_cwd: None` placeholder fix at `serve.rs`, and the Developer applied the same mechanical, non-design fix at an unlisted `scheduler_execution_e2e.rs` site rather than escalating, on the grounds that it is a direct, minimal, unavoidable consequence of the very field addition the task authorizes. Also confirmed via `docs/ai-team/tasks/pending/T-159-...md` that T-159 (depends on T-158) explicitly owns the real `BobConfig.skill_install_path` → `build_pi_agent_supervisor_config` mapping. Given this direct in-repo precedent for the identical pattern, the same minimal `skill_install_path: None` placeholder was applied at both sites rather than escalating.
- No other obstacles; the `pi` binary was not needed for this task (unit/integration tests spawn `sh`, not `pi`).

Next Owner:
- Reviewer (via Development Loop)

Next Action:
- Confirm during review that the two files outside the task's stated "Files to Touch" (`crates/bob/src/serve.rs`, `crates/bob/tests/scheduler_execution_e2e.rs`) were touched only with minimal `skill_install_path: None` placeholders mirroring documented T-121 precedent, not scope creep.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->

### Review Verdict — 2026-08-10

PASS

**Stage 1 — Acceptance Criteria:**
- AC-1 (optional `skill_install_path` field on both configs): met. `pub skill_install_path: Option<PathBuf>` added to `process::WorkerProcessConfig` and `process::InteractiveProcessConfig` (`process.rs`), and to the crate's own `Config` (`lib.rs`), each documented and defaulted to `None`. Covered by `default_config_leaves_skill_install_path_unset` and `config_carries_configured_skill_install_path`.
- AC-2 (set `BOB_SKILL_INSTALL_PATH` when configured and non-empty): met. `RpcWorkerProcess::spawn` and `InteractiveProcess::spawn` (`process.rs`) each gained `if let Some(skill_install_path) = &cfg.skill_install_path { if !skill_install_path.as_os_str().is_empty() { cmd.env("BOB_SKILL_INSTALL_PATH", skill_install_path); } }`, placed immediately after the existing `BOB_EXTENSION_SOCK_PATH` block and following the identical conditional-set shape. Covered by `spawn_sets_bob_skill_install_path_when_path_is_non_empty` and `interactive_spawn_sets_bob_skill_install_path_when_path_is_non_empty` (both real-child-process tests reading the env var back via the child's stdout).
- AC-3 (unset/empty omits the var, spawn still succeeds): met. Both spawn paths leave the env var untouched when `skill_install_path` is `None` or `Some(empty path)`; no other branch of the spawn logic changes. Covered by `spawn_omits_bob_skill_install_path_when_unset`, `spawn_omits_bob_skill_install_path_when_path_is_empty`, and `interactive_spawn_omits_bob_skill_install_path_when_unset`, each asserting the child observes the var as genuinely absent (`${VAR+x}` test) and that spawn returns `Ok`.
- AC-4 (`StartInteractiveSession` handler populates the field from the actor's own `Config`, no new RPC parameter): met. In `Actor::run`'s `Command::StartInteractiveSession` arm (`lib.rs`), `InteractiveProcessConfig.skill_install_path` is set to `self.cfg.skill_install_path.clone()` while every other field on that literal continues to come from the command's caller-supplied parameters, matching the CR-005 precedent the task description calls out. Confirmed no `admin-rpc` files were touched (`git diff` against the admin-rpc crate is empty), so no new RPC parameter was added. Covered end-to-end by `start_interactive_session_populates_skill_install_path_from_actor_config`, which spawns a real interactive child via `Handle::start_interactive_session` and reads `$BOB_SKILL_INSTALL_PATH` back from redirected stdout; the Work Log records this test was confirmed non-vacuous by a temporary revert-and-rerun.
- No unspecified behavior or functionality was added beyond what the four ACs require.
- Files to Touch (`process.rs`, `lib.rs`, `pool.rs`) were all touched as described; `pool.rs`'s `worker_process_config_for_session` maps `cfg.skill_install_path.clone()` exactly mirroring the existing `worker_cwd` mapping, covered by `worker_process_config_carries_configured_skill_install_path`.

**Unlisted-file precedent check (`serve.rs`, `scheduler_execution_e2e.rs`):** Verified directly. Both files construct `pi_agent_supervisor::Config` via exhaustive struct literals with no `..Default::default()`, so the new field breaks `cargo build -p bob` and `cargo test --workspace` unless a value is supplied at each site. The diff at both sites is a single mechanical `skill_install_path: None,` line added next to the existing `worker_cwd: None,`/`worker_cwd: Some(...)` line, with a comment in `serve.rs` pointing at T-159 (already a pending, dependent task that explicitly owns replacing this placeholder with the real `BobConfig.skill_install_path`-resolved value) — no other line in either file changed. I confirmed the cited precedent in `docs/ai-team/tasks/completed/T-121-...md`: T-121's own Work Log independently discovered and mechanically fixed the same unlisted `scheduler_execution_e2e.rs` site for the analogous `worker_cwd` field (that file was *not* in T-121's "Files to Touch" either, unlike `serve.rs`, which T-121 did list explicitly), and T-121's Review Verdict explicitly passed it with the finding "this is the same mechanical, minimal, non-design fix the task explicitly authorizes for the analogous `serve.rs` site, not scope creep." T-158 extends the identical reasoning to `serve.rs` itself (unlisted this time) in addition to the e2e file, but the underlying situation — a new `Option<PathBuf>` field on an exhaustively-constructed `Config`, forced to `None` at unlisted construction sites purely to keep the workspace compiling, with a dependent pending task already slated to replace the placeholder — is identical in kind, not just cited by analogy. This is a mechanical, non-design, behavior-preserving change (both sites end up with the field unconfigured, i.e., no `BOB_SKILL_INSTALL_PATH`, which is exactly today's behavior since the variable doesn't exist yet), not scope creep.

**Stage 2 — Code Quality:**
- Correctness: the conditional guard (`Some(..) if non-empty`) is applied identically at both spawn sites and mirrors the pre-existing `BOB_EXTENSION_SOCK_PATH` pattern exactly, as the task required. `Option<PathBuf>` threading through `Config` → `WorkerProcessConfig`/`InteractiveProcessConfig` has no gaps.
- Tests: both spawn paths have dedicated success (non-empty path set), unset (`None`), and empty-path (`Some("")`) cases; the pool-mapping and actor-wiring paths each have a dedicated test verified non-vacuous by revert-and-rerun (per the Work Log). Tests use unique per-test session IDs/temp file names, so no shared mutable state.
- Security: no secrets; the path is passed through as an opaque environment value, consistent with how `worker_cwd`/`extension_sock_path` are already handled.
- Readability: new fields carry doc comments explaining `None`/empty semantics and the ADR-014 §4 fail-open rationale; the AC-4 wiring site has an explanatory comment referencing the CR-005 precedent. No dead code.
- Performance: no added loops or blocking calls; the new logic is a cheap conditional `Command` builder call before spawn, identical in cost profile to the existing `worker_cwd`/`extension_sock_path` handling.

**Verification performed independently:** built a git worktree at the reviewed branch tip (`b9a54e5`) and ran `cargo test -p pi-agent-supervisor` (74 passed, matching the Work Log), `cargo build -p bob` (succeeds), `cargo fmt --all -- --check` (clean), and `cargo test --workspace` (26 test binaries, all green, 0 failures) — matching and extending the task's own verification command.

**Minor, non-blocking observation:** both task-branch commit subjects (`feat(pi-agent-supervisor): thread skill_install_path to interactive sessions`, 76 chars; `feat(pi-agent-supervisor): add skill_install_path to worker config and env`, 74 chars) run slightly over the git-conventions ≤72-char guideline, consistent with the same non-blocking overage already noted and accepted in T-121's review.
