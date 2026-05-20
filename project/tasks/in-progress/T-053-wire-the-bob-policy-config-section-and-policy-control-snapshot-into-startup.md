---
id: T-053
title: Wire the bob policy config section and policy-control snapshot into 
  startup
status: pending
priority: high
assigned-role: unassigned
created: '2026-05-20'
spec: S-004
---

# Wire the bob policy config section and policy-control snapshot into startup

<!--
Task Quality Rules (see the new-task skill for full details):
  - Atomic — one clear outcome.
  - One-shottable — ≤ 3–4 files touched, ≤ 5 ACs, Description ≈ 20 lines.
  - Verifiable — concrete Verification command or explicit manual steps.
  - Self-contained — Description is enough to start without follow-up questions.
  - EARS — every AC matches one of the five EARS patterns below.
  - Dependency-honest — list every prior task this one reads from or modifies.
-->

## Description

Phase 2 of S-004. Surface the policy ruleset in bob's configuration and
wire the real `policy-control` actor at startup.

In `bob/src/config.rs`:

- Add a `[policy]` section to the TOML config (through `RawBobConfig` and
  `BobConfig`) holding the admission user-id list and the action rules,
  represented by `policy_control::PolicyConfig`.
- **Relocate** the admission user-id list here: remove the legacy top-level
  `allowed_user_ids` field from `BobConfig`, `RawBobConfig`, `test_base`,
  and the defaults. Admission users now live only under `[policy]`. An
  absent `[policy]` section is valid and yields a deny-all config.

In `bob/src/serve.rs`:

- Build the initial `RulesetSnapshot` from the config's `PolicyConfig` and
  start the `policy-control` actor with a real `Config` (initial snapshot +
  resolved config file path) instead of `Config::default()`. Keep the
  `SnapshotHandle` it returns for later wiring.
- The existing pre-flight still uses `run_preflight`/`PreflightConfig`;
  keep it compiling by building `PreflightConfig` from the admission list
  now read out of the `[policy]` config. T-054 replaces this path.
- `admin-rpc` already receives `policy: Some(policy_control_handle.clone())`
  — no admin-rpc change here.

## Acceptance Criteria

AC-1: The system shall parse a `[policy]` section of bob's TOML configuration into a `policy_control::PolicyConfig` carrying the admission user-id list and the action rules.
AC-2: IF the `[policy]` section is absent THEN THE SYSTEM SHALL treat the policy config as empty (deny-all) rather than failing to load.
AC-3: The system shall remove the legacy top-level `allowed_user_ids` configuration key, sourcing admission users only from the `[policy]` section.
AC-4: WHEN `bob serve` starts THE SYSTEM SHALL build the initial ruleset snapshot from configuration and start the `policy-control` actor with that snapshot and the config file path.

## Dependencies

- `T-052` — needs the real `policy-control` `Config`, `start`, and `SnapshotHandle`.

## Files to Touch

- `the-intern/service/crates/bob/src/config.rs` — add the `[policy]` section; remove the legacy `allowed_user_ids` key.
- `the-intern/service/crates/bob/src/serve.rs` — build the snapshot, start the real `policy-control` actor, source `PreflightConfig` from `[policy]`.

## Verification

```bash
cd the-intern/service
cargo test -p bob
cargo clippy -p bob --all-targets
```

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

### Session 1 — 2026-05-20

**What was done:**

This session implemented all four acceptance criteria for T-053 in two TDD cycles.

**Cycle 1 (AC-1, AC-2, AC-3 — config.rs):**

Replaced the legacy top-level `allowed_user_ids: Vec<UserId>` field in `BobConfig` and `RawBobConfig` with `policy: PolicyConfig` from the `policy-control` crate. The field is decorated with `#[serde(default, skip_serializing)]` on `RawBobConfig` — `skip_serializing` was necessary because `PolicyConfig` only derives `Deserialize`, not `Serialize`, and `RawBobConfig` is passed to `Serialized::defaults(...)` in figment, which requires `Serialize`. The `#[serde(default)]` attribute satisfies AC-2 (absent `[policy]` section yields deny-all rather than a parse error). Added `config_path: PathBuf` to `BobConfig` so the startup path can pass it to `policy-control::Config` for hot-reload. Removed `deserialize_user_id_vec`, `UserId`, and `FromStr` imports which were only used by the now-removed `allowed_user_ids` field. Updated `serve.rs` to source `PreflightConfig.allowed_user_ids` from `cfg.policy.admitted_users` (T-054 will replace this path entirely). Updated the test in `serve.rs` that set `cfg.allowed_user_ids` to use `cfg.policy.admitted_users`.

**Cycle 2 (AC-4 — serve.rs):**

Added `policy_snapshot: policy_control::SnapshotHandle` to the `Runtime` struct. In `try_start_subsystems`, replaced `policy_control::start(Config::default())` with building a `RulesetSnapshot::from_config(cfg.policy.clone())` and starting the actor with a real `Config { initial_snapshot, config_path: cfg.config_path.clone(), command_buffer: 16 }`. The returned `SnapshotHandle` is now stored in `Runtime.policy_snapshot` for later gate-crate wiring (T-054/T-056). The shutdown protocol destructures it as `policy_snapshot: _policy_snapshot` so it compiles without unused-variable warnings.

**What was tried and rejected:**

Considered implementing `Serialize` for `PolicyConfig` in the policy-control crate, but that would have required modifying a file outside the task's `Files to Touch`. The `skip_serializing` attribute was the correct scope-bounded solution.

**Decisions made:**

- Dropped `PartialEq` and `Eq` derives from `BobConfig` since `PolicyConfig` does not implement them. None of the existing tests compared `BobConfig` instances with `==`, so this was a safe change.
- `config_path` in `BobConfig` stores whatever path the figment loader resolved (whether from override, default, or `ConfigSources`). Tests that use `test_base()` get an empty `PathBuf`, which correctly signals to `policy-control` that reload is unsupported.

**Pre-existing issues noted:**

Four `cargo clippy --all-targets` errors exist in `crates/bob/src/cli/commands/chat.rs` and `crates/bob/src/cli/commands.rs` that predate this task. They are not in the files this task touched and were present before the first commit on this branch.

**What remains:**

Nothing — all four acceptance criteria are implemented, tested, and committed.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->
