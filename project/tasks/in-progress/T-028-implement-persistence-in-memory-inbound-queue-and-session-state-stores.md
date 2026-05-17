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

### Session 1 — 2026-05-17

Implemented the in-memory inbound queue and session state stores for the persistence crate, replacing the `NotImplemented` scaffold from T-013.

**What was done**

Three files were touched, all within the `Files to Touch` boundary:

- `the-intern/service/crates/persistence/src/inbound.rs` — new file containing `InboundQueue`, a `VecDeque`-backed fixed-capacity ring buffer. `enqueue` appends to the back and returns `Err(ServiceError::Persistence { detail: "inbound queue at capacity" })` when full, without evicting existing entries. `dequeue_next` pops from the front (FIFO). Unit tests cover AC-1, AC-2, and AC-3 at the struct level.

- `the-intern/service/crates/persistence/src/session_state.rs` — new file containing `SessionStateStore`, a `HashMap<SessionId, SessionState>`. `put` overwrites; `get` returns a clone or `None`. Unit tests cover AC-4 at the struct level.

- `the-intern/service/crates/persistence/src/lib.rs` — rewritten to wire both internal stores to the actor. The original scaffold's `Command::EnqueueEvent(String)` and the stub `enqueue_event` method were replaced. The new `Command` enum uses four variants, each carrying a `oneshot::Sender` reply channel so the `Handle`'s `PersistenceStore` methods can return a `ServiceResult` directly. `async_trait` was already a workspace dependency. Integration-level tests covering all five ACs live in the `tests` module here.

**What was tried and rejected**

An alternative of holding `Mutex<InboundQueue>` directly inside `Handle` (removing the actor entirely) was considered. It would have been simpler, but the task specifies the actor architecture and the existing scaffold was actor-based. Keeping the actor also makes it straightforward to add write-ahead-log flushing or other side effects later without changing the public API.

The `#[cfg(test)] pub(crate) fn len()` helper on `InboundQueue` was added only to support the internal unit tests; it is gated behind `#[cfg(test)]` so it produces no code in release builds.

**Pre-existing failure noted**

`cargo test -p bob --test non_serve` (`status_exits_non_zero_and_writes_not_implemented`) was already failing on `main` before this branch was created. It is an environment-dependent integration test that expects a specific socket path; it is not related to this task.

**What remains**

Nothing within T-028's scope. All five acceptance criteria have tests and implementations. The verification commands pass. The workspace builds and passes clippy with `-D warnings`.

## Review
