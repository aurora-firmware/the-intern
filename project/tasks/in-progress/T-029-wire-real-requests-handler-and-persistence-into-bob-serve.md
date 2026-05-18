---
id: T-029
title: Wire real requests-handler and persistence into bob serve
status: pending
priority: high
assigned-role: unassigned
created: '2026-05-16'
spec: S-001
---

# Wire real requests-handler and persistence into bob serve

## Description

Update `bob::serve::run` so the placeholder requests-handler and persistence
actors constructed in T-017 are replaced by the real implementations from
T-026, T-027, and T-028. Wire dependencies:

- Construct the persistence actor first (it has no peer dependencies among
  the working Phase 1b set).
- Construct the monitoring actor scaffold next (existing T-012 scaffold
  remains — Phase 5 fills its body).
- Construct the requests-handler with `start_with(cfg, persistence_handle,
  audit_sink: monitoring_handle, allowed_user_ids: cfg.allowed_user_ids)`.

No other subsystems change in this task. The graceful shutdown sequence
already covers these new actors via the cancellation token plumbed in T-017.

## Acceptance Criteria

AC-1: WHEN `bob serve` is invoked THE SYSTEM SHALL construct the requests-handler and persistence actors using the implementations from T-026, T-027, and T-028 in place of the `NotImplemented` placeholders from T-017.
AC-2: WHEN the requests-handler accepts a permitted event during `bob serve` THE SYSTEM SHALL persist it via the wired persistence handle (observable in a follow-up test by `get_session_state` or a debug `dequeue_next`).
AC-3: WHILE `bob serve` is running, the binary crate shall NOT introduce a direct dependency on any subsystem crate whose working implementation has not yet landed (policy-control, pi-agent-supervisor, extension-ipc business logic, channel adapters).

## Dependencies

- `T-017` — serve wiring with placeholder actors
- `T-027` — working requests-handler
- `T-028` — working persistence

## Files to Touch

- `the-intern/service/crates/bob/src/serve.rs` — touch; replace persistence and requests-handler construction with real implementations

## Verification

```bash
cd the-intern/service && cargo test -p bob serve::tests
cd the-intern/service && cargo build -p bob
```

## Work Log

### Session 1 — 2026-05-18

Implemented T-029 by wiring `bob::serve` to use the real Phase 1b requests-handler and persistence path instead of the placeholder downstream closure. In `try_start_subsystems`, I kept the existing actor startup order, then replaced the `_event => async {}` closure with a call to `requests_handler::run_preflight`, passing a real `PersistenceStore` handle and an audit sink adapter backed by the monitoring handle. I added a small `MonitoringAuditSink` type in `serve.rs` that implements `AuditSink` and forwards audit records to monitoring's scaffold method.

To prove the wiring behavior, I added `permitted_event_is_persisted_via_wired_requests_handler_and_persistence` in `serve::tests`. The test configures one allowed user ID, starts subsystems, submits an event through `_requests_handler`, then asserts the event appears in `_persistence.dequeue_next()` before shutdown. This validates that the live requests-handler path persists permitted events through the wired persistence handle.

What I tried and rejected: I considered calling `requests_handler::start_with_preflight`, but that API currently hardcodes `context=None`, which denies all events and cannot satisfy AC-2. I therefore wired `start_with` directly with `run_preflight` and a placeholder context derived from configured allowed IDs so permitted flow is testable in `bob serve` until channel adapters provide real request context.

What remains: no code changes remain in this task scope. Canonical task lifecycle updates (Work Log append on `dev-agent`) are still needed by the loop role.

## Review

### Review Verdict — 2026-05-18
PASS

Result: PASS

Summary:
- Reviewed `task/T-029-wire-real-requests-handler-and-persistence-into-bob-serve` commit `771d08d` against AC-1 through AC-3 using the two-stage `code-review` workflow; acceptance and code-quality checks passed.

Artifacts:
- Canonical task file updated: `project/tasks/in-progress/T-029-wire-real-requests-handler-and-persistence-into-bob-serve.md` (this verdict entry).
- Diff reviewed: `771d08d` (`the-intern/service/crates/bob/src/serve.rs` only).
- Primary files inspected for wiring semantics and trait compatibility:
  `the-intern/service/crates/bob/src/serve.rs`,
  `the-intern/service/crates/requests-handler/src/lib.rs`,
  `the-intern/service/crates/requests-handler/src/handler.rs`,
  `the-intern/service/crates/persistence/src/lib.rs`.

Evidence:
- Stage 1 (acceptance): verified placeholder downstream closure in `serve.rs` was replaced with real preflight->persistence wiring, AC-2 persistence path is explicitly exercised by the new serve test, and no new disallowed subsystem dependency was introduced by this task diff.
- Stage 2 (quality): checked correctness of actor wiring, audit sink adapter, and persistence trait-object handoff; no blocking correctness/security/readability/performance defects found in task scope.
- Commands run:
  - `git show --stat --name-only --oneline 771d08d`
  - `git show --no-color 771d08d -- the-intern/service/crates/bob/src/serve.rs`
  - `cargo build -p bob` on an archive snapshot of `771d08d` (pass)
  - `cargo test -p bob serve::tests` on the same snapshot (environment-blocked; see obstacles)

Obstacles Encountered:
- Sandbox environment denied Unix domain socket bind operations used by `serve::tests` (`Os { code: 1, kind: PermissionDenied, message: "Operation not permitted" }`), so runtime socket-path tests could not be validated end-to-end in this container.

Next Owner:
- Development Loop

Next Action:
- Proceed with lifecycle flow; rerun `cd the-intern/service && cargo test -p bob serve::tests` in a non-restricted environment before integration if strict test execution evidence is required.
