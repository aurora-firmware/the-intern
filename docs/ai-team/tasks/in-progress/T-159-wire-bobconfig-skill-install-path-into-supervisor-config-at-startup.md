---
id: T-159
title: Wire BobConfig skill_install_path into supervisor config at startup
status: pending
priority: high
assigned-role: developer
created: '2026-08-09'
spec: S-011
---

# Wire BobConfig skill_install_path into supervisor config at startup

## Description

S-011 Implementation Order Phase 4, depends on T-157 (config key) and T-158
(supervisor field). Startup wiring in
`the-intern/service/crates/bob/src/serve.rs`, mirroring exactly how T-126
mapped `BobConfig.pi_agent_cwd` into the supervisor's worker cwd in
`build_pi_agent_supervisor_config`. Map `BobConfig.skill_install_path`
(resolved, defaulting per T-157) into the pi-agent-supervisor `Config`'s new
`skill_install_path` field (T-158) at `bob serve` startup, so every
warm-pool worker the supervisor spawns after this point carries the
resolved skill path. Also implement S-011's Workflow startup step ("bob
starts and resolves the skill install path → path missing or empty: log a
warning and continue") — this is the one fail-open case not covered by
T-157 (which deliberately does not check existence at config load) or by
T-160 (which only sees whatever `BOB_SKILL_INSTALL_PATH` it's given).

Interactive-session coverage of the same `Config.skill_install_path` value
is delivered by T-158 AC-4 (the actor's `StartInteractiveSession` handler
reads its own `Config` directly) — this task's `serve.rs` mapping only
reaches the pool path, and `cargo test -p bob serve` accordingly does not
exercise the interactive case; that coverage lives in T-158's own tests.

## Acceptance Criteria

AC-1: WHEN the service starts with `skill_install_path` resolved to a value
      THE SYSTEM SHALL configure the supervisor's `Config` with that value,
      which the pool path (this task) and the interactive path (T-158 AC-4)
      both read from the same field.
AC-2: The system shall use the same resolved `skill_install_path` (explicit
      config value or the T-157 default) for every spawn path, with no
      per-path divergence.
AC-3: WHERE the resolved `skill_install_path` does not exist as a directory
      at `bob serve` startup THE SYSTEM SHALL log one warning and continue
      starting (fail-open, not a startup failure).

## Dependencies

- `T-157` — `BobConfig.skill_install_path`
- `T-158` — supervisor config `skill_install_path` field and interactive-path
  wiring (AC-4)

## Files to Touch

- `the-intern/service/crates/bob/src/serve.rs` — supervisor config mapping in
  `build_pi_agent_supervisor_config` (or equivalent) plus the missing-path
  startup warning

## Verification

```bash
cd the-intern/service && cargo build -p bob && cargo test -p bob serve
```

Note: this command covers the pool-path mapping (AC-1, AC-2) and the
startup warning (AC-3). Interactive-path coverage (AC-1's interactive half)
is verified by T-158's own test suite (`cargo test -p pi-agent-supervisor`),
not by this command.

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

### Session 1 — 2026-08-10

Implemented T-159 via two TDD red→green cycles on `task/T-159-wire-bobconfig-skill-install-path`: (1) mapped `BobConfig.skill_install_path` unconditionally into the pi-agent-supervisor `Config`'s `skill_install_path` field in `build_pi_agent_supervisor_config` (AC-1/AC-2), and (2) added `warn_if_skill_install_path_missing`, called once at `bob serve` startup, that logs one warning (and never fails startup) when the resolved path does not exist as a directory (AC-3).

All three acceptance criteria have passing tests; both cycles committed separately.

Artifacts: `the-intern/service/crates/bob/src/serve.rs` — `build_pi_agent_supervisor_config` mapping change, new `warn_if_skill_install_path_missing` function and its call site in `try_start_subsystems`, plus 4 new unit tests (`pi_agent_supervisor_config_maps_skill_install_path_from_bob_config`, `warns_when_resolved_skill_install_path_directory_is_missing`, `does_not_warn_when_resolved_skill_install_path_directory_exists`, and a local `CaptureWriter`/`CaptureWriterHandle` test harness).

Evidence: `cd the-intern/service && cargo build -p bob && cargo test -p bob serve` (the task's verification command) passes — 62 tests in the `serve` module incl. 3 new, 1 pre-existing unrelated ignore (`B-028`); also 2 `shell_e2e` tests matched by the `serve` substring filter. `cargo test --workspace` — full suite, no failures. `cargo fmt --all -- --check` — clean. Confirmed each new test failed before its implementation (`None` vs `Some(path)` mismatch for the mapping test; "function not found" compile error for the warning tests) before writing the minimal implementation.

Nothing remains for this task's own scope.

Obstacles Encountered:
- The loop's session-start note said T-158 left a `skill_install_path: None` placeholder in `the-intern/service/crates/bob/tests/scheduler_execution_e2e.rs` "for this task to replace," but the canonical task file's `## Files to Touch` names only `serve.rs`, and that test file constructs `pi_agent_supervisor::Config` directly rather than through `build_pi_agent_supervisor_config`, so nothing in this task's change requires touching it. Treated the task file as authoritative and left it untouched; flagging for the Reviewer to confirm this reading is correct.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->
