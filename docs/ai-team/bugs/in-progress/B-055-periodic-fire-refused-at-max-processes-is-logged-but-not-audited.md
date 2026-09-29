---
id: B-055
title: Periodic fire refused at max_processes is logged but not audited
severity: medium
status: in-progress
created: '2026-09-28'
---

# Periodic fire refused at max_processes is logged but not audited

## Summary

When a periodic (scheduled) fire is refused because the pi-agent pool is at
`max_processes`, bob skips the fire and logs a `tracing::warn!`, but writes
no monitoring failure record. The approved specs promise one: S-002
Component 6 ("a refused acquisition **skips that fire** with a logged
warning and a monitoring failure record") and S-010's periodic-fire workflow
("cwd missing (S-009) or max_processes exhausted (S-002): skipped with a
warning and a monitoring failure record"). The missing-cwd skip already
writes that record; the pool-exhausted skip does not. Impact: a scheduled
job that repeatedly fails to run because the pool is full is invisible in
`bob audit tail` and only shows up in raw service logs. Found during the
CR-015 architecture consistency review; pre-existing, not caused by CR-015.

## Reproduction Status

Status: not yet reproduced

Confirmed by code reading only (both skip paths traced in
`crates/bob/src/serve.rs`); not yet exercised by a live or test run.

## Evidence

- Logs / stack traces / failing assertions: n/a — the defect is a missing
  audit record, not a failure.
- Screenshots or recordings: n/a
- Failing command or test: none yet. Code evidence at `2840ce5`:
  - Per-entry-cwd path, `the-intern/service/crates/bob/src/serve.rs:912-927`:
    the `Err` arm of `supervisor.acquire_session_with_cwd(...)` (the
    `max_processes` refusal, per its own AC-4 comment) only calls
    `tracing::warn!` and `continue`s.
  - Default path, `acquire_default_session_or_warn`
    (`serve.rs:703-716`): the `Err` arm of `supervisor.acquire_session()`
    (which returns an error at `max_processes`,
    `crates/pi-agent-supervisor/src/pool.rs:203-216`) only calls
    `tracing::warn!`.
  - Contrast: the missing per-entry-cwd skip (`serve.rs` ~`895-910`) calls
    both `tracing::warn!` and `record_periodic_fire_skipped`
    (`serve.rs:627-655`), which writes the `Report`-kind
    `scheduler.periodic_fire` / `outcome: error` record.
- First diagnostic step if not yet reproduced: write a serve-level test that
  fills the pool to `max_processes`, fires a periodic request (once with a
  per-entry cwd, once without), and asserts an audit record is appended.

## Reproduction Steps

1. Configure `max_processes` so active plus warm workers fill the pool (for
   example `max_processes = 1` with one active session held open).
2. Let a scheduled job fire — once for an entry with a per-entry `cwd`, once
   for an entry without.
3. Watch `bob audit tail` and the service log.

## Expected Behavior

Each refused fire is skipped with a logged warning **and** a monitoring
failure record, as S-002 Component 6 and S-010 state — the same
`scheduler.periodic_fire` error report the missing-cwd skip already writes.

## Actual Behavior

Each refused fire is skipped with a logged warning only. Nothing appears in
`bob audit tail`.

## Environment

- OS / platform: any
- Language / runtime version: Rust workspace toolchain per CI
- Relevant dependencies: none
- Branch / commit: `dev-agent` at `2840ce5`

## Related

- Task: none
- Specification: `S-002-bob-service-shell-architecture.md` (Component 6,
  "When `max_processes` is exhausted"); `S-009-scheduler-channel-adapter-and-bob-schedule-cli.md`
  (cron-tick workflow, 2026-09-28 amendment — the one complete list of fire
  outcomes, which names this bug directly); `S-010-email-skills-for-pi-agent-himalaya-cli-reference-and-classification-driven-triage.md`
  (Workflow, periodic-fire outcomes, now deferring to S-009)
- Found during: `CR-015` architecture consistency review (finding 10)

## Suspected Area

`the-intern/service/crates/bob/src/serve.rs` — periodic dispatcher: the
`acquire_session_with_cwd` error arm and `acquire_default_session_or_warn`.
Likely fix: call the existing `record_periodic_fire_skipped` from both
arms; no new audit record kind.

## Fix Verification

```bash
cd the-intern/service
cargo test -p bob serve::tests
cargo test --workspace
```

A new test must fail before the fix and pass after: with the pool at
`max_processes`, a periodic fire (with and without a per-entry cwd) appends
a `scheduler.periodic_fire` error report to the audit sink.

## Diagnosis Log

<!-- Mandatory before implementation. Append one entry before changing production code. Format:
### Diagnosis N — YYYY-MM-DD
Reproduction status:
Evidence captured:
Isolated fault:
Root cause or fault hypothesis:
Planned verification:
-->

### Diagnosis 1 — 2026-09-29
Reproduction status: Confirmed, deterministic. Two temporary serve-level tests fail against the unmodified code, one per-entry-cwd and one default-cwd. Both were run with `max_processes = 1`, `warm_pool_size = 0` and a first fire holding the slot. They were reverted after the run.

Evidence captured:
- Command: `cd the-intern/service && cargo test -p bob b055 -- --nocapture`.
- Output for both variants: `all_records=["Event"]` and `left: 0, right: 1` on the assertion "expected periodic_fire error record".
- The only audit record is the `Event` from the first, successful fire.
- Code trace: the two refusal paths in `crates/bob/src/serve.rs` only call `tracing::warn!`. The missing-cwd skip calls `record_periodic_fire_skipped`.

Isolated fault:
- `serve.rs`, per-entry-cwd `Err(e)` arm of `supervisor.acquire_session_with_cwd(cwd.clone())` inside `start_periodic_dispatcher` (~lines 955-966).
- `serve.rs`, `acquire_default_session_or_warn` (~lines 741-755). This function is called from the `ServiceDefault` and `EntryNotFound` arms.

Root cause: Omission. The pool-exhausted skip paths were written with warn-and-continue only. The audit call added later for the missing-cwd skip was never applied to them, contrary to S-002 Component 6 and S-009/S-010.

Planned fix (minimal):
- In the `acquire_session_with_cwd` `Err` arm, after the `tracing::warn!`, call `record_periodic_fire_skipped(audit_sink.as_ref(), job_id.as_deref(), format!("... {e}"))` before `continue`. The summary should say the session acquisition was refused and include the error and cwd.
- Give `acquire_default_session_or_warn` the `audit: &dyn AuditSink` and `job_id: Option<&str>` parameters, so its `Err` arm calls `record_periodic_fire_skipped` too. Update its two call sites.
- Use the existing `Report`, `scheduler.periodic_fire`, `ReportOutcome::Error` shape. Add no new `AuditRecordKind`.
- Caveat: the `EntryNotFound` branch already writes a `periodic_fire_fallback` record before acquiring; a pool refusal there still gets its own skip record (different action). Do not touch the T-228 "warm worker already exited" test, which deliberately asserts no audit record.

Planned verification:
- Add two tests in `serve::tests::periodic`, asserting a `Report` record with `action == "scheduler.periodic_fire"`, `outcome == Error`, and the job id in the summary. Both must fail before the fix and pass after.
  - Per-entry cwd, at full pool.
  - Default cwd, at full pool.
- Extend the existing full-pool test to assert on its `SpyAuditSink`, or add the new tests alongside it, keeping the no-eviction assertions.
- Run `cd the-intern/service && cargo test -p bob serve::tests`, then `cargo fmt --all -- --check`, then `cargo test --workspace`. Use targeted test binaries if socket suites hang.

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
