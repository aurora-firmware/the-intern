---
id: T-225
title: Add the pi_agent_model config key and reject model flags in pi_agent_args
status: in-progress
priority: high
assigned-role: developer
created: '2026-09-29'
---

# Add the pi_agent_model config key and reject model flags in pi_agent_args

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

Add the service-wide `pi_agent_model` configuration key and the
`pi_agent_args` restriction (CR-015; S-002 v0.2, Configuration → "pi-agent
process settings"). Motivation: GitHub issue #104 — without an explicit
`--model`, pi picks its model from its own saved settings and silently falls
back when that model disappears; with an explicit `--model` it fails loudly.

In `crates/bob/src/config.rs`, `BobConfig` and the raw deserialized struct gain
an optional `pi_agent_model` (top-level `snake_case` key, ADR-002; the existing
`env_overrides` mapping makes `BOB_PI_AGENT_MODEL` work automatically). The
value is a pi model pattern passed through verbatim — bob does not interpret,
list, default, or check it against pi. `validate()` additionally rejects any
`pi_agent_args` entry that selects a model: `--model`, `--models`, or
`--provider`, whether as a separate argument or in `--flag=value` form, so the
model is settable in exactly one place.

Also add the **single shared builder** S-002 requires: one `BobConfig` method
returning the pi arguments shared by pool workers and interactive sessions —
`["--model", <value>]` when set, empty when unset. T-226 wires it into both
spawn paths; this task only adds and unit-tests it. The unset-model startup
warning is T-226's, not this task's.

Rejecting a blank value (AC-2) guards against `--model ""`, which pi could
treat as no model and silently fall back; say so in a one-line code comment.
`crates/bob/tests/shell_e2e.rs` `client_cfg()` builds `BobConfig` field by
field (it cannot use the `#[cfg(test)]` `test_base()`), so it must gain
`pi_agent_model: None` or the integration test stops compiling.

## Acceptance Criteria

AC-1: The system shall parse an optional top-level `pi_agent_model` key (also
      settable through `BOB_PI_AGENT_MODEL`) into `BobConfig`, verbatim.
AC-2: IF `pi_agent_model` is set to an empty or whitespace-only value THEN THE
      SYSTEM SHALL fail configuration loading with an error naming
      `pi_agent_model`.
AC-3: IF `pi_agent_args` contains `--model`, `--models`, or `--provider`, as a
      separate argument or in `--flag=value` form, THEN THE SYSTEM SHALL fail
      configuration loading with an error that names the offending flag and
      says to set the model with `pi_agent_model`.
AC-4: The system shall provide one `BobConfig` method returning the shared pi
      arguments: `--model <value>` when `pi_agent_model` is set, and no
      arguments when it is unset.
AC-5: WHILE `pi_agent_model` is unset THE SYSTEM SHALL load configuration
      successfully with the model left unset.

## Dependencies

- None

## Files to Touch

- `the-intern/service/crates/bob/src/config.rs` — `pi_agent_model` field
  (`BobConfig`, raw struct, defaults, test base), validation of the value and
  of `pi_agent_args`, the shared-arguments method, and unit tests
- `the-intern/service/crates/bob/tests/shell_e2e.rs` — add
  `pi_agent_model: None` to `client_cfg()`

## Verification

```bash
cd the-intern/service && cargo test -p bob config && cargo fmt --all -- --check
```

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

### Session 1 — 2026-09-29

Implemented T-225 in three TDD cycles, each committed on `task/T-225-pi-agent-model-config-key`.

Cycle 1 (AC-1, AC-5) added the optional `pi_agent_model: Option<String>` field to `BobConfig` and `RawBobConfig`, wired it through `test_base()`, `defaults_with_runtime_root()`, and `load_with_sources()`, and updated `shell_e2e.rs`'s `client_cfg()` (the one other call site that builds `BobConfig` field-by-field rather than through `..BobConfig::test_base()`) so the integration test binary keeps compiling. Every other `BobConfig { .. }` literal in the crate (admin_rpc.rs, chat.rs, serve.rs, telemetry.rs) uses struct-update syntax against `test_base()` and needed no change. Tests cover parsing from `config.toml`, from `BOB_PI_AGENT_MODEL`, and the unset default.

Cycle 2 (AC-2, AC-3) added two `validate()` checks: a blank/whitespace-only `pi_agent_model` fails with an error naming the key (comment explains why: `--model ""` could look like "no model" to pi and silently fall back, defeating the point of setting it explicitly); and a new `model_selecting_flag_in()` helper scans `pi_agent_args` for `--model`, `--models`, or `--provider` in either bare or `--flag=value` form, failing config load with an error that names the offending flag and tells the operator to use `pi_agent_model` instead. Tests cover both value forms across all three flags, plus a control test confirming `pi_agent_args` without any model flag still loads.

Cycle 3 (AC-4) added `BobConfig::pi_agent_shared_args()` — the single shared-argument builder S-002 calls for: returns `["--model", <value>]` when `pi_agent_model` is set, empty otherwise. This is deliberately unwired in this task; T-226 (pending, depends on T-225) consumes it in both `build_pi_agent_supervisor_config`'s `worker_args` and `build_interactive_session_config`'s `args`, and adds the unset-model startup warning.

Considered and rejected: returning the exact matched argument text (e.g. `--model=gpt-4`) instead of just the flag name (`--model`) in the AC-3 error — the AC only requires naming "the offending flag," and returning the bare flag name from a `&'static str` table kept the helper simple and avoided formatting/allocation for a value that could itself carry another operator's model string as noise in the error.

Verification: `cargo test -p bob config` (task's exact command) and the full `cargo test -p bob --lib` (312 passed, 1 pre-existing ignore, 0 failed) both green; `cargo fmt --all -- --check` clean. The `loads_schedule_entries_from_json_store_when_store_exists` test that CLAUDE.md documents as sandbox-flaky actually passed here, so no skip was needed this session — worth re-checking if it flips in a future session, but out of scope for T-225.

Nothing remains for T-225's own scope. Next: T-226 wires `pi_agent_shared_args()` into the supervisor/interactive spawn paths and adds the startup warning; T-227–T-230 (stderr forwarding, invalid-model verification, docs) follow.

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

Stage 1 (acceptance criteria), checked against `the-intern/service/crates/bob/src/config.rs` and `tests/shell_e2e.rs` on `task/T-225-pi-agent-model-config-key`:
- AC-1: `RawBobConfig` gains `#[serde(default)] pi_agent_model: Option<String>` and it is copied verbatim into `BobConfig`; `env_overrides()` strips `BOB_` and lowercases, so `BOB_PI_AGENT_MODEL` maps to the key automatically with no extra wiring, as the task description asserts. Covered by `loads_pi_agent_model_from_config_file` and `loads_pi_agent_model_from_env_override`. Met.
- AC-2: `validate()` rejects `pi_agent_model.trim().is_empty()` with an error containing `"pi_agent_model"`, comment explains the `--model ""` rationale as required. Covered by `returns_configuration_error_when_pi_agent_model_is_empty` and `..._is_whitespace_only`. Met.
- AC-3: new `model_selecting_flag_in()` scans `pi_agent_args` for `--model`, `--models`, `--provider` as an exact token or `--flag=value` prefix; verified the matcher does not false-positive `--model` against `--models` (exact-match plus `"{flag}="` prefix check). Error names the offending flag and points to `pi_agent_model`. Covered for both argument forms across all three flags, plus a control test with no model flag present. Met.
- AC-4: `BobConfig::pi_agent_shared_args()` returns `["--model", value]` when set, empty otherwise; confirmed by grep it is intentionally unwired anywhere else in the crate (T-226's job per the task description). Covered by both branches. Met.
- AC-5: unset `pi_agent_model` loads successfully as `None`, covered by `pi_agent_model_is_none_when_unset`. Met.
- No unspecified behavior added; only `config.rs` and `shell_e2e.rs` touched, matching Files to Touch. `client_cfg()` in `shell_e2e.rs` gained `pi_agent_model: None` as required so the integration binary keeps compiling.

Stage 2 (code quality): logic is correct and handles the separate-argument and `--flag=value` forms without false-positiving `--models`/`--provider`-prefixed strings; tests cover both success and failure paths and are independent (each builds its own env/config); no hardcoded secrets or unvalidated external-input risk beyond the existing config-parsing pattern; names and doc comments are clear, no dead code; the new validation runs once at config load, not a hot path, so the per-flag `format!` allocation in `model_selecting_flag_in` is immaterial.

Verification run on `task/T-225-pi-agent-model-config-key`:
- `cargo test -p bob config` from `the-intern/service`: 79 passed, 0 failed (includes the `shell_e2e`, `non_serve`, `queue_load`, `scheduler_execution_e2e`, `session_state_roundtrip` integration binaries compiling with 0 tests run each — expected, per the known sandbox socket-test limitation).
- `cargo test -p bob --lib`: 312 passed, 1 ignored, 0 failed (matches the Developer's Work Log figures).
- `cargo fmt --all -- --check`: clean.

Commits (`e94135b`, `9ac8b5d`, `61e31ea`) follow `git-conventions`: `feat(bob): ...`, imperative, lowercase, no period, ≤72 chars, no task ID repeated (branch carries it).

Both stages pass. No blocking or non-blocking observations beyond the above.
