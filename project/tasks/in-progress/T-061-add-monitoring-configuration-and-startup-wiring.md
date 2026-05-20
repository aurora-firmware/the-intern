---
id: T-061
title: Add monitoring configuration and startup wiring
status: pending
priority: high
assigned-role: unassigned
created: '2026-05-20'
spec: S-005
---

# Add monitoring configuration and startup wiring

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

Phase 2 support for S-005. Add Monitoring configuration to bob's TOML-backed
configuration and use it when `bob serve` starts the Monitoring actor.

The config must include the JSONL audit log path and default tail visibility
kinds. If the path is omitted, bob should resolve an OS-appropriate application
state path. If the path is configured but unusable, startup must fail rather
than running without durable audit. Parent directories for the audit file must
be created with owner-only permissions where applicable. Wire
`monitoring::start` from `bob::serve` with the loaded config and preserve
existing shutdown behaviour.

## Acceptance Criteria

<!-- EARS pattern reference. Every criterion must match one pattern:
  1. Ubiquitous            — The system shall [outcome]
  2. Event-driven          — WHEN [trigger] THE SYSTEM SHALL [outcome]
  3. Unwanted-behaviour    — IF [fault] THEN THE SYSTEM SHALL [outcome]
  4. State-driven          — WHILE [state] THE SYSTEM SHALL [outcome]
  5. Optional              — WHERE [feature included] THE SYSTEM SHALL [outcome]

Examples:
  AC-1: WHEN the user submits valid credentials THE SYSTEM SHALL
        redirect to /dashboard within 200ms.
  AC-2: IF the password is incorrect THEN THE SYSTEM SHALL return 401
        and display "Invalid credentials".
  AC-3: The system shall log every authentication attempt with user id
        and outcome.
-->

AC-1: The system shall load a Monitoring config section containing an audit JSONL path and default tail filters from bob's layered TOML configuration.
AC-2: WHEN no audit log path is configured THE SYSTEM SHALL resolve a non-empty OS-appropriate default path.
AC-3: IF the configured audit log path cannot be opened for append THEN THE SYSTEM SHALL fail `bob serve` startup.
AC-4: WHEN `bob serve` starts subsystems THE SYSTEM SHALL pass the loaded Monitoring config into `monitoring::start`.
AC-5: WHEN Monitoring opens an audit log path with missing parent directories THE SYSTEM SHALL create the parent directories with owner-only permissions where applicable.

## Dependencies

- `T-060` — provides the Monitoring config and startup contract consumed by `bob serve`.

## Files to Touch

- `the-intern/service/crates/bob/src/config.rs` — load and validate the monitoring section and default audit log path.
- `the-intern/service/crates/bob/src/serve.rs` — start Monitoring with the loaded config and preserve shutdown flushing.
- `the-intern/service/crates/bob/tests/shell_e2e.rs` — extend startup coverage only if config/startup behaviour is not fully covered by unit tests.

## Verification

```bash
cd the-intern/service
cargo test -p bob config::tests
cargo test -p bob serve::tests
```

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

### Session 1 — 2026-05-20

I started T-061 by reading the canonical task file from `dev-agent` and confirmed there were no prior Work Log entries. I then mapped the existing `bob` config/startup and `monitoring` contract and added red tests in `crates/bob/src/config.rs` covering: loading a `[monitoring]` section with audit path and default tail filters, resolving a non-empty default audit path when omitted, failing config load when the audit path is not appendable, and creating missing parent directories with owner-only permissions where applicable.

I ran `cargo test -p bob config::tests` for the red step, but compilation failed before reaching new tests due pre-existing errors in `crates/requests-handler/src/handler.rs` (`AuditKind` no longer exists in `bob_core::types`, and `AuditRecord` is instantiated with a removed `description` field). This is outside T-061 files-to-touch and prevents any `bob` test execution, so I stopped implementation per boundary/escalation rules.

I attempted to file a blocker bug via the documented `new-bug` skill command and rejected that command form because the CLI does not support the documented `--title/--description` flags. I then used the actual CLI signature and created `B-007`. I also logged both CLI/skill issues in `ai-process-cli-reported-issues.md` as required by repository instructions.

Architect consultation classified the blocker as an execution issue but directed that T-061 must not absorb the `requests-handler` fix as a scope exception. T-061 is blocked by `B-007`; resume this branch only after `B-007` lands, then refresh from `dev-agent` and rerun `cd the-intern/service && cargo test -p bob config::tests && cargo test -p bob serve::tests`.

Remaining work after blocker resolution: implement minimal production changes for monitoring config loading/path preparation/startup wiring, run red→green→refactor cycles with commits, and finish verification commands for `config::tests` and `serve::tests`.

### Session 2 — 2026-05-20

I resumed after the blocker refresh and continued from the existing red tests in `config.rs`. I implemented a new `MonitoringConfig` on `BobConfig`, added `[monitoring]` extraction from layered TOML, and resolved defaults so omitted `monitoring.audit_log_path` now maps to an OS-appropriate state location while omitted tail filters default to all supported kinds (`events`, `reports`, `verdicts`). I added startup-time validation that prepares parent directories, applies owner-only permissions on newly created parent directories where applicable (Unix), and verifies the audit file is appendable. This turned the pre-existing red `config::tests` green and I committed that cycle as `feat(bob): add monitoring config loading and path checks`.

For AC-4, I added a focused red test in `serve::tests` asserting monitoring startup config is derived from `BobConfig` rather than defaults, initially failing on a missing helper. I then implemented `build_monitoring_config` and changed `try_start_subsystems` to call `monitoring::start(build_monitoring_config(cfg))`, which made the test pass; I committed this second cycle as `feat(bob): wire monitoring startup from loaded config`.

I tried running full `serve::tests` inside the sandbox and rejected that path after repeated `Operation not permitted` errors on Unix socket binds; I reran the verification command outside sandbox permissions, where the suite passed. Remaining work on this branch: none for T-061 implementation; ready for reviewer handoff.

Evidence:
- Red step observed:
  - `cargo test -p bob config::tests -- --nocapture` failed initially with `no field monitoring on type BobConfig`.
  - `cargo test -p bob serve::tests::monitoring_config_maps_audit_log_path_from_bob_config -- --nocapture` failed with missing `build_monitoring_config`.
- Green/verification:
  - `cd the-intern/service && cargo test -p bob config::tests` passed (18/18).
  - `cd the-intern/service && cargo test -p bob serve::tests -- --nocapture` passed outside sandbox (18/18).
- Git evidence:
  - `7e393c2 feat(bob): add monitoring config loading and path checks`
  - `3173d41 feat(bob): wire monitoring startup from loaded config`

Obstacles Encountered:
- `serve::tests` could not run in sandbox due Unix socket bind permission errors (`Operation not permitted`); resolved by rerunning the same command with escalated permissions.
- No code-level blockers after `B-007` resolution.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->
