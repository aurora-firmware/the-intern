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

## Review
