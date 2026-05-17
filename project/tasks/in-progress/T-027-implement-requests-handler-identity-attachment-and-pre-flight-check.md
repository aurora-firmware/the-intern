---
id: T-027
title: Implement requests-handler identity attachment and pre-flight check
status: pending
priority: high
assigned-role: unassigned
created: '2026-05-16'
spec: S-001
---

# Implement requests-handler identity attachment and pre-flight check

## Description

Extend T-026: the actor task now performs the work S-001 §Workflow describes
for the Requests Handler stage. For each dequeued event:

1. Attach identity using the event's `RequestContext` (no-op for now — the
   context is already populated by channel adapters; this stage just
   validates that the context fields are present).
2. Run a deterministic pre-flight identity/access check. Phase 4 (Policy
   Control) replaces the body; for Phase 1b, the check returns "allow" only
   when `RequestContext.user_id` is in `cfg.allowed_user_ids` (empty by
   default → deny all).
3. On allow: persist via `PersistenceStore::enqueue(event)`.
4. On deny: drop the event, emit a `tracing::warn!` (without payload), and
   publish an `AuditRecord` of kind `PreflightDenied` to the configured
   `AuditSink`.

## Acceptance Criteria

AC-1: WHILE the requests-handler is running, WHEN it dequeues an event whose `RequestContext.user_id` is in `cfg.allowed_user_ids` THE SYSTEM SHALL invoke `PersistenceStore::enqueue(event)` on the configured persistence handle.
AC-2: WHEN it dequeues an event whose user id is not in `cfg.allowed_user_ids` THE SYSTEM SHALL drop the event, emit `tracing::warn!`, and publish an `AuditRecord` of kind `PreflightDenied` to the configured `AuditSink`.
AC-3: IF `RequestContext` is missing the `user_id` field THEN THE SYSTEM SHALL treat the event as denied and emit the same `PreflightDenied` audit record.
AC-4: The system shall NOT include raw event payloads in any `tracing::warn!` line emitted by the pre-flight path.

## Dependencies

- `T-026` — queue and actor loop
- `T-028` — `PersistenceStore` and `AuditSink` implementations the handler calls
- `T-015` — `BobConfig.allowed_user_ids` populated

## Files to Touch

- `the-intern/service/crates/requests-handler/src/handler.rs` — new; pre-flight logic
- `the-intern/service/crates/requests-handler/src/lib.rs` — touch; wire `handler` into the actor's per-event loop

## Verification

```bash
cd the-intern/service && cargo test -p requests-handler handler
```

## Work Log

## Review
