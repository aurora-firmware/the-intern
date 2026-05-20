---
id: B-007
title: bob build fails in requests-handler due to audit type mismatch
severity: high
status: in-progress
created: '2026-05-20'
task: T-061
---

# bob build fails in requests-handler due to audit type mismatch

## Summary

After `T-059` replaced the legacy audit placeholders with canonical
`AuditRecord` payload types, `requests-handler` still imports the removed
`AuditKind` symbol and constructs `AuditRecord` with a removed `description`
field. This breaks `cargo test -p bob ...` before `T-061` monitoring config
tests can run.

## Reproduction Status

Status: confirmed

Reproduced while starting `T-061` from `dev-agent` plus the task branch red
tests.

## Evidence

- Failing command:
  - `cd the-intern/service && cargo test -p bob config::tests`
- Error highlights:
  - `unresolved import bob_core::types::AuditKind` in `crates/requests-handler/src/handler.rs:5`
  - `AuditRecord has no field named description` in `crates/requests-handler/src/handler.rs:54`
- Source branch that exposed the blocker:
  - `task/T-061-add-monitoring-configuration-and-startup-wiring`

## Reproduction Steps

1. Check out `dev-agent` after `T-059` and `T-060` are integrated.
2. Run `cd the-intern/service`.
3. Run `cargo test -p bob config::tests`.

## Expected Behavior

The `bob` crate should compile so its config tests can execute.

## Actual Behavior

The workspace fails during compilation because `requests-handler` references
stale audit API shapes removed by `T-059`.

## Environment

- OS / platform: Linux development workspace
- Language / runtime version: Rust workspace under `the-intern/service`
- Relevant dependencies: `bob`, `requests-handler`, `bob-core`
- Branch / commit: discovered during `T-061` on `task/T-061-add-monitoring-configuration-and-startup-wiring`

## Related

- Task: `T-061`
- Specification: `S-005`

## Suspected Area

`the-intern/service/crates/requests-handler/src/handler.rs`

## Fix Verification

```bash
cd the-intern/service
cargo test -p bob config::tests
cargo test -p bob serve::tests
```

## Diagnosis Log

<!-- Mandatory before implementation. Append one entry before changing production code. Format:
### Diagnosis N — YYYY-MM-DD
Reproduction status:
Evidence captured:
Isolated fault:
Root cause or fault hypothesis:
Planned verification:
-->

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
- For PASS: brief confirmation that diagnosis, fix, verification, and code quality passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->
