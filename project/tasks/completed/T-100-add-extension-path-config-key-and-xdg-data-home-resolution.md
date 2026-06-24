---
id: T-100
title: Add extension_path config key and XDG_DATA_HOME resolution
status: completed
priority: high
assigned-role: developer
created: '2026-06-23'
spec: CR-003
---

# Add extension_path config key and XDG_DATA_HOME resolution

## Description

Per CR-003 and ADR-009, bob must resolve the pi extension's filesystem path.
Add an `extension_path` field to `BobConfig` and `RawBobConfig` in
`crates/bob/src/config.rs`. Default resolution (Linux): `$XDG_DATA_HOME/bob/
extensions/bob.ts`, falling back to `~/.local/share/bob/extensions/bob.ts` when
`XDG_DATA_HOME` is unset — mirror the existing `default_config_path` /
`default_monitoring_audit_log_path_for_env` resolution helpers, including the
macOS Application-Support branch. The `config.toml` key `extension_path`
overrides the default. This task is resolution only; the existence check and the
`--extension` spawn argument are T-101.

## Acceptance Criteria

AC-1: WHEN no `extension_path` is configured THE SYSTEM SHALL resolve the
      extension path to `$XDG_DATA_HOME/bob/extensions/bob.ts`, falling back to
      `~/.local/share/bob/extensions/bob.ts` when `XDG_DATA_HOME` is unset.

AC-2: WHEN `extension_path` is set in `config.toml` THE SYSTEM SHALL use that
      value as the resolved extension path.

AC-3: The system shall expose the resolved extension path as a field on
      `BobConfig`.

AC-4: The system shall pass `cargo test -p bob` with unit tests covering the
      default, the `XDG_DATA_HOME`-unset fallback, and the override.

## Dependencies

- None.

## Files to Touch

- `the-intern/service/crates/bob/src/config.rs` — add `extension_path` to
  `BobConfig` / `RawBobConfig`, a `default_extension_path*` resolver, and tests.
- `the-intern/service/crates/bob/tests/chat_e2e.rs` — provide the required field
  in the existing `BobConfig` test literal without changing test behavior.
- `the-intern/service/crates/bob/tests/shell_e2e.rs` — provide the required field
  in the existing `BobConfig` test literal without changing test behavior.

## Verification

```bash
cd the-intern/service && cargo test -p bob config
```

## Work Log

<!-- Mandatory. Append one entry per session boundary. -->

### Session 1 — 2026-06-23

Mapped the criteria to XDG default, HOME fallback, and TOML override tests. The
tests initially failed because `extension_path` was absent. Minimal
implementation then exposed compile failures in `crates/bob/tests/chat_e2e.rs`
and `shell_e2e.rs`, whose `BobConfig` literals require the new field. Those
files were outside the original declared scope, so no out-of-scope changes were
made and the branch was restored clean. The Architect confirmed these edits are
necessary compile-fix fallout within the approved specification, and the task's
file list now includes them. Implementation remains to be completed.

### Session 2 — 2026-06-23

Added `extension_path` to raw and resolved configuration, including XDG
data-home resolution, Linux HOME fallback, macOS Application Support fallback,
and TOML override support. Added tests for all required paths and stand-in
values to the authorized E2E config literals. The sandbox test run was rejected
as environmental because Unix sockets were denied; both targeted and full
`bob` suites passed outside the sandbox. Implementation is complete; only
review and integration remain.

## Review

<!-- Reviewer: append verdict here after each review cycle. -->

### Review Verdict — 2026-06-23

PASS

Stage 1 passed: AC-1 is covered by the XDG data-home and HOME/Application
Support fallback resolver tests; AC-2 is covered by the TOML override test;
AC-3 is satisfied by the resolved `BobConfig::extension_path` field; and AC-4
passes with both the targeted and full `bob` test suites. The diff is limited
to the three authorized files and adds no behavior beyond path resolution.

Stage 2 passed: the resolver follows the established configuration-layering
pattern, the tests independently cover the required paths, and no correctness,
security, readability, or performance issues were found. Formatting, targeted
config tests, and the full `cargo test -p bob` suite pass. The tests were run
outside the restricted sandbox because its Unix-socket policy causes unrelated
`Operation not permitted` failures.

Next owner: active Development Loop.
