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

### Session 2 — 2026-07-05

Implemented T-119 end-to-end via two TDD cycles on `task/T-119-add-pi-agent-cwd-service-wide-worker-working-directory-config-key`.

**Cycle 1 (AC-1, AC-3, AC-4 — config surface and parsing):** Wrote four tests first (`pi_agent_cwd_is_none_when_unset`, `loads_pi_agent_cwd_absolute_path_from_config_file`, `loads_successfully_when_pi_agent_cwd_names_a_nonexistent_directory`, and the AC-2 relative-path test) in `crates/bob/src/config.rs`. Confirmed the AC-1/3/4 tests failed to compile without the field. Added `pi_agent_cwd: Option<PathBuf>` to `BobConfig` and `RawBobConfig` (with `#[serde(default)]` on the raw field so an absent TOML key resolves to `None` rather than a figment extraction error), wired it through `test_base()`, `defaults_with_runtime_root`, and the `load_with_sources` raw→cfg mapping. This broke an unrelated `BobConfig` struct literal in `crates/bob/tests/shell_e2e.rs` (a test helper building a minimal config for the admin-client e2e test) — fixed with a one-line `pi_agent_cwd: None` addition, the same mechanical-fix pattern the sibling task T-121 already documents for `serve.rs`. Ran `cargo test -p bob config`: AC-1/3/4 tests passed, AC-2 test failed as expected (no validation yet). Committed as `feat(config): add optional pi_agent_cwd worker working-directory key`.

**Cycle 2 (AC-2 — absolute-path validation):** Added the absolute-path check to `BobConfig::validate()`, returning a `Configuration` error naming `pi_agent_cwd` when the path is relative (mirrors the existing relative-cwd/relative-file validation style already used for schedule entries in `bob-core/src/types/schedule.rs`). Ran `cargo fmt --all` (one formatting fix needed in the new test block) and reran `cargo test -p bob config` — all 47 tests green. Committed as `fix(config): reject a relative pi_agent_cwd at load time`.

**Verification:** Ran the task's own verification command (`cargo test -p bob config`) and the full workspace suite (`cargo test --workspace`) — both green, no failures anywhere in the workspace. `cargo fmt --all -- --check` is clean.

**What was tried and rejected:** Considered gating on directory existence at load time, but the task description and S-002 amendment are explicit that existence must remain unchecked (lazy/spawn-time posture) — no test was written for that behavior since AC-4 explicitly requires the opposite.

**What remains:** Nothing within this task's scope. Wiring `pi_agent_cwd` into the pi-agent supervisor (setting `current_dir` on spawned workers) is explicitly deferred to T-121/T-126 per the task description and is out of scope here.

**Obstacles Encountered:** Adding the new struct field broke an unrelated `BobConfig` literal in `crates/bob/tests/shell_e2e.rs` (a test helper, not in the task's `Files to Touch`). Fixed it with a one-line addition (`pi_agent_cwd: None`) since it was purely a compile-consequence of the additive field, not a scope change — mirrors the exact same pattern already documented in the sibling task T-121 for `serve.rs`.

## Review
