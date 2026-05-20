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

### Diagnosis 1 — 2026-05-20

Reproduction status:
Confirmed. Reproduced consistently on this bug branch with both target commands.

Evidence captured:
- `cd the-intern/service && cargo test -p bob config::tests` fails compiling `requests-handler` with:
  - `E0432`: unresolved import `bob_core::types::AuditKind` at `crates/requests-handler/src/handler.rs:5`
  - `E0560`: `AuditRecord` has no field `description` at `crates/requests-handler/src/handler.rs:54`
- `cd the-intern/service && cargo test -p bob serve::tests` fails with the same two compile errors.
- `cd the-intern/service && cargo check -p requests-handler` fails with the same two errors.
- Current `bob-core` canonical types export `AuditRecordKind`/`AuditRecordPayload` and `AuditRecord { id, timestamp, kind, session_id, payload }` (no `AuditKind`, no `description`) in `crates/bob-core/src/types/mod.rs` and `crates/bob-core/src/types/records.rs`.

Isolated fault:
`requests-handler` preflight denial audit construction still uses legacy audit API shape (`AuditKind::PreflightDenied` and `description`) in `crates/requests-handler/src/handler.rs` (production and tests), while `bob-core` now defines canonical envelope/payload types.

Root cause or fault hypothesis:
Root cause: incomplete migration after the audit model change introduced in bob-core (`AuditKind` removed; `AuditRecord` structure changed). `requests-handler` was not updated to the new `AuditRecordKind` + `AuditRecordPayload` contract, causing compile-time type mismatch.

Planned verification:
1. Update `requests-handler` audit imports and `AuditRecord` construction to canonical types.
2. Update affected `requests-handler` tests to assert against canonical payload/kind.
3. Run:
   - `cd the-intern/service && cargo test -p requests-handler`
   - `cd the-intern/service && cargo test -p bob config::tests`
   - `cd the-intern/service && cargo test -p bob serve::tests`

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

### Session 1 — 2026-05-20

Implemented B-007 from the recorded Diagnosis Log by aligning `requests-handler` preflight denial auditing with the canonical `bob-core` envelope/payload model. I first executed a red phase by updating handler tests to assert verdict-style audit records (`AuditRecordKind::Verdict` and `AuditRecordPayload::Verdict` with denied `allow=false`) and reason-based secret-safety checks, then confirmed failure with the diagnosed compile errors (`AuditKind` import missing and removed `description` field). I then applied the minimal production fix: replaced legacy audit imports, constructed `AuditRecord` with `id`, `timestamp`, `kind`, `session_id`, and typed verdict payload, and preserved denial reason text without including raw event payload. Verified green with `cargo test -p requests-handler`, then ran bug verification commands for `bob` config and serve tests. One attempt to run serve tests inside sandbox failed with Unix socket `PermissionDenied`; rerun outside sandbox passed. I briefly tried `cargo fmt --all -- <file>` for local formatting and rejected keeping the unrelated formatting output, restoring those files so only the intended handler fix remained. Remaining work: reviewer validation and integration by the loop on `dev-agent`.

Evidence:
- Red phase failure:
  - `cd the-intern/service && cargo test -p requests-handler`
  - Failed with:
    - `E0432`: unresolved import `bob_core::types::AuditKind`
    - `E0560`: `AuditRecord` has no field `description`
- Green regression + package tests:
  - `cd the-intern/service && cargo test -p requests-handler` (passed, 13 tests)
- Bug file verification commands:
  - `cd the-intern/service && cargo test -p bob config::tests` (passed)
  - `cd the-intern/service && cargo test -p bob serve::tests` (passed when rerun outside sandbox due socket bind permissions in sandbox)
- Branch state:
  - Clean working tree after commit; no bug lifecycle file edits on this branch.

Obstacles Encountered:
- `cargo test -p bob serve::tests` failed in sandbox with `PermissionDenied` on Unix socket bind; resolved by rerunning with escalation.
- `cargo fmt --all -- crates/requests-handler/src/handler.rs` unexpectedly touched unrelated files; discarded those unrelated changes and kept only the B-007 fix.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that diagnosis, fix, verification, and code quality passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->
