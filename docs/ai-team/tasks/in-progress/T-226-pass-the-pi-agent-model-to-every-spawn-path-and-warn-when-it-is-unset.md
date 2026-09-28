---
id: T-226
title: Pass the pi-agent model to every spawn path and warn when it is unset
status: in-progress
priority: high
assigned-role: developer
created: '2026-09-29'
---

# Pass the pi-agent model to every spawn path and warn when it is unset

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

Wire the shared pi arguments from T-225 into every way bob starts pi, and log
the unset-model warning (CR-015; S-002 v0.2: Configuration → "pi-agent process
settings", Component 7, and the service-start and interactive-chat workflows).

In `crates/bob/src/serve.rs`:
- `build_pi_agent_supervisor_config`: `worker_args` becomes `pi_agent_args`
  followed by the shared arguments. Warm, overflow, and dedicated per-entry-cwd
  workers all build their process config from `worker_args`
  (`pool.rs` `worker_process_config_for_session`, and
  `worker_process_config_for_cwd_session` via struct update), so no pool change
  is needed — only a test proving the dedicated path inherits them.
- `build_interactive_session_config`: `args` (today `Vec::new()`) becomes the
  shared arguments. `pi_agent_args` must never reach interactive sessions.
- Add `warn_if_pi_agent_model_unset(cfg)` next to
  `warn_if_skill_install_path_missing` (called at `serve.rs` ~229), tested the
  same way (existing tests at `serve.rs` ~1340/1372). The warning, logged once
  at startup, must name the missing `pi_agent_model` key, say pi will choose
  the model from its own saved settings, which can change or fall back to a
  different model without notice, and say to set `pi_agent_model` in the
  service configuration.

## Acceptance Criteria

AC-1: WHILE `pi_agent_model` is set THE SYSTEM SHALL give the supervisor
      `worker_args` equal to `pi_agent_args` followed by `--model <value>`.
AC-2: WHILE `pi_agent_model` is set THE SYSTEM SHALL give interactive sessions
      exactly `--model <value>` as arguments, and never `pi_agent_args`.
AC-3: WHILE `pi_agent_model` is unset THE SYSTEM SHALL leave `worker_args`
      equal to `pi_agent_args` and interactive arguments empty.
AC-4: WHEN `bob serve` starts with `pi_agent_model` unset THE SYSTEM SHALL log
      exactly one warning naming `pi_agent_model`, stating that pi will choose
      the model from its own saved settings which can change or fall back
      without notice, and telling the operator to set the key; with the key
      set, no such warning is logged (test both, as `serve.rs` ~1356 does for
      the skill path).
AC-5: The system shall include a pool test showing a dedicated per-entry-cwd
      worker's process config carries the same arguments as a service-wide
      worker's.

## Dependencies

- `T-225` — provides `pi_agent_model` and the shared-arguments method

## Files to Touch

- `the-intern/service/crates/bob/src/serve.rs` — both config builders, the
  startup warning, and tests
- `the-intern/service/crates/pi-agent-supervisor/src/pool.rs` — test only
  (dedicated-worker args inheritance)

## Verification

```bash
cd the-intern/service && cargo test -p bob serve::tests && cargo test -p pi-agent-supervisor && cargo fmt --all -- --check
```

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

### Session 1 — 2026-09-29

Implemented T-226 in four TDD cycles on `task/T-226-pi-agent-model-spawn-paths`, each committed separately. Cycle 1 (AC-1/AC-3, commit `f59faff`): changed `build_pi_agent_supervisor_config` in `serve.rs` so `worker_args` is `pi_agent_args.clone()` extended with `cfg.pi_agent_shared_args()`; added a test asserting the appended `--model <value>` when `pi_agent_model` is set, and a second test asserting `worker_args` stays exactly `pi_agent_args` when it is unset (the latter already passed before the code change, confirming the unset-case default was already correct via `pi_agent_shared_args()` returning `Vec::new()`). Cycle 2 (AC-2, commit `b2d3e9f`): changed `build_interactive_session_config` so `args: Vec::new()` became `args: cfg.pi_agent_shared_args()`, with a test proving interactive sessions get exactly the `--model` flag and never `pi_agent_args`. Cycle 3 (AC-4, commit `7de8e52`): added `warn_if_pi_agent_model_unset(cfg)` beside `warn_if_skill_install_path_missing`, wired into `try_start_subsystems` right after the skill-path warning call; added a warn/no-warn test pair using the existing `CaptureWriter`/tracing-subscriber harness. Had to fix the first "exactly one warning" assertion — it counted substring occurrences of `"pi_agent_model"`, which appears twice in the single warning message's text, so it wrongly failed on a correctly-single-logged warning; switched to counting non-empty log lines. Cycle 4 (AC-5, commit `5744da8`): per the task's own note that `worker_process_config_for_cwd_session`'s struct-update pattern already inherits `worker_args` from `worker_process_config_for_session`, added a pool.rs-only test (`worker_process_config_for_cwd_session_inherits_same_args_as_service_wide_worker`) that passed immediately with no production change, confirming AC-5 by construction rather than driving new behavior.

Verification: `cargo test -p bob serve::tests` (63 passed, 1 pre-existing unrelated ignore — B-028), `cargo test -p pi-agent-supervisor` (77 passed), `cargo fmt --all -- --check` (clean) — all run per the task's exact Verification command. Only `crates/bob/src/serve.rs` and `crates/pi-agent-supervisor/src/pool.rs` were touched, matching "Files to Touch." Nothing remains outstanding for this task; ready for review.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->

### Review Verdict — 2026-09-29

PASS

**Stage 1 — Acceptance Criteria:**
- AC-1 (worker_args = pi_agent_args + shared args when set): met. `build_pi_agent_supervisor_config` in `serve.rs` appends `cfg.pi_agent_shared_args()` to `cfg.pi_agent_args.clone()`; test `pi_agent_supervisor_config_worker_args_appends_shared_args_when_pi_agent_model_set` verifies the exact `["--mode","rpc","--model","<value>"]` ordering.
- AC-2 (interactive sessions get exactly `--model <value>`, never `pi_agent_args`): met. `build_interactive_session_config`'s `args` field is now `cfg.pi_agent_shared_args()`; test `interactive_session_config_gives_shared_args_not_pi_agent_args_when_pi_agent_model_set` confirms `pi_agent_args` does not leak through even when both are set.
- AC-3 (unset model leaves worker_args = pi_agent_args, interactive args empty): met. `pi_agent_supervisor_config_worker_args_unchanged_when_pi_agent_model_unset` covers the pool side; the pre-existing `interactive_session_config_maps_bob_spawn_settings_without_rpc_args` test (`interactive_cfg.args.is_empty()`, `pi_agent_model` unset via `BobConfig::test_base()`) still passes and covers the interactive side.
- AC-4 (exactly one startup warning naming `pi_agent_model`, silent when set): met. `warn_if_pi_agent_model_unset` is wired into `try_start_subsystems` right after `warn_if_skill_install_path_missing`; wording matches S-002 verbatim (names the key, says pi falls back to its own saved model which can change/fall back without notice, tells the operator to set `pi_agent_model`). `warns_when_pi_agent_model_is_unset` and `does_not_warn_when_pi_agent_model_is_set` follow the existing `CaptureWriter` pattern used for the skill-install-path warning and both pass.
- AC-5 (dedicated per-entry-cwd worker inherits the same args as a service-wide worker): met. New `pool.rs` test `worker_process_config_for_cwd_session_inherits_same_args_as_service_wide_worker` confirms the struct-update pattern in `worker_process_config_for_cwd_session` flows `worker_args` through unchanged; no production code needed, matching the task's own note.
- No unspecified behavior added; only `crates/bob/src/serve.rs` and `crates/pi-agent-supervisor/src/pool.rs` were touched, matching "Files to Touch" exactly.

**Stage 2 — Code Quality:**
- Correctness: verified against `S-002-bob-service-shell-architecture.md` "pi-agent process settings" section — the warning wording and the pool/interactive argument split match the spec exactly, including that `pi_agent_args` is pool-only and must never reach interactive sessions.
- Tests: each new test is independent (fresh `BobConfig`/`Config` per test, no shared mutable state), covers both the set and unset paths per AC, and asserts the exact expected values rather than loose substring checks (the "exactly one warning" assertion correctly counts non-empty log lines, not substring occurrences, avoiding a false pass/fail on a message that happens to repeat the key name).
- Security: no external input handled in this diff (all config comes through the already-validated `BobConfig`); no secrets.
- Readability: doc comments on both new/changed functions cite CR-015/S-002 and explain *why* (e.g., why `pi_agent_args` must not reach interactive sessions), consistent with the file's existing style.
- Performance: no new loops, blocking calls, or resource leaks; argument building is a single `Vec::extend`.
- Grep across `crates/bob`, `crates/pi-agent-supervisor`, and `crates/admin-rpc` confirms `build_pi_agent_supervisor_config` and `build_interactive_session_config` are the only two production sites that construct these configs — no other spawn path was missed.

**Verification run on `task/T-226-pi-agent-model-spawn-paths` (commit `5744da8`):**
- `cargo test -p bob serve::tests`: 63 passed, 1 ignored (pre-existing B-028, unrelated), 0 failed.
- `cargo test -p pi-agent-supervisor`: 77 passed, 0 failed.
- `cargo fmt --all -- --check`: clean.

All matches the Work Log's reported results. Both stages pass.

Next owner: Development Loop.
