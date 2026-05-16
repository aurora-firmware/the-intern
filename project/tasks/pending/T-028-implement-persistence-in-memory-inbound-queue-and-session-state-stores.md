---
id: T-028
title: Implement persistence in-memory inbound queue and session state stores
status: pending
priority: high
assigned-role: unassigned
created: '2026-05-16'
spec: S-001
---

# Implement persistence in-memory inbound queue and session state stores

## Description

Replace the persistence scaffold's `NotImplemented` body (T-013) with the
in-memory implementation S-001 Implementation Order Phase 1b calls for.

- **Inbound queue store** — a ring buffer keyed by `RequestId` with capacity
  from `cfg.persistence_inbound_capacity`. `enqueue(event)` appends; when the
  buffer is full, the call returns `ServiceError::Persistence { detail:
  "inbound queue at capacity" }`. `dequeue_next()` returns the oldest stored
  event in FIFO order.
- **Session state store** — a hashmap keyed by `SessionId` →
  `SessionState`. `put_session_state(id, state)` overwrites; `get_session_state(id)` returns `Option<SessionState>`.

Both implementations live behind the `PersistenceStore` trait (T-010) so a
later disk-backed implementation can replace them without touching consumers.

## Acceptance Criteria

AC-1: WHEN `persistence::Handle::enqueue(event)` is called and the buffer has capacity THE SYSTEM SHALL store the event and return `Ok(())`.
AC-2: WHEN `persistence::Handle::dequeue_next()` is called against a non-empty buffer THE SYSTEM SHALL return the oldest stored event in FIFO order.
AC-3: IF `persistence::Handle::enqueue` is called against a buffer already at capacity THEN THE SYSTEM SHALL return `Err(ServiceError::Persistence { detail })` without dropping the existing entries.
AC-4: WHEN `persistence::Handle::put_session_state(id, state)` is followed by `persistence::Handle::get_session_state(id)` THE SYSTEM SHALL return a value equal to the one stored.
AC-5: The system shall implement `bob_core::ports::PersistenceStore` for the persistence `Handle`.

## Dependencies

- `T-013` — persistence scaffold
- `T-010` — `PersistenceStore` port trait
- `T-015` — `BobConfig.persistence_inbound_capacity` populated

## Files to Touch

- `the-intern/service/crates/persistence/src/inbound.rs` — new; ring buffer
- `the-intern/service/crates/persistence/src/session_state.rs` — new; hashmap store
- `the-intern/service/crates/persistence/src/lib.rs` — touch; expose modules and wire to `Handle`

## Verification

```bash
cd the-intern/service && cargo test -p persistence inbound
cd the-intern/service && cargo test -p persistence session_state
```

## Work Log

## Review
