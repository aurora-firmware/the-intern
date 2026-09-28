---
id: T-226
title: Pass the pi-agent model to every spawn path and warn when it is unset
status: pending
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

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->
