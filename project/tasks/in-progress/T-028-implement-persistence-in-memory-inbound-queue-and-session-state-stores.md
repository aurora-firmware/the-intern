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

### Review Verdict — 2026-05-17

PASS

Both stages passed.

**Stage 1 — Spec compliance**

- AC-1 (enqueue with capacity returns Ok): met. `InboundQueue::enqueue` checks `len >= capacity` and appends only when space is available; `Handle::enqueue` forwards via actor reply channel. Integration test `enqueue_returns_ok_when_queue_has_capacity` confirms.
- AC-2 (dequeue_next returns oldest event in FIFO order): met. `VecDeque::push_back` / `pop_front` enforces FIFO. Both struct-level and actor-level integration tests confirm ordering with multiple events.
- AC-3 (enqueue at capacity returns Err without dropping existing entries): met. The guard returns `Err(ServiceError::Persistence { detail: "inbound queue at capacity" })` before any push. Tests `enqueue_at_capacity_returns_persistence_error` and `enqueue_at_capacity_does_not_drop_existing_entries` confirm at both levels.
- AC-4 (put_session_state then get_session_state returns equal value): met. `SessionStateStore::put` inserts/overwrites; `get` returns a clone or `None`. Integration test `get_session_state_returns_stored_value` confirms round-trip equality.
- AC-5 (Handle implements PersistenceStore): met. `#[async_trait] impl PersistenceStore for Handle` in `lib.rs`; compile-time check via `accepts_store::<S: PersistenceStore>` test confirms.
- Files modified are exactly the three listed in "Files to Touch" — no scope creep.

**Stage 2 — Code quality**

- Correctness: logic is sound; capacity check uses strict `>=`; reply-channel errors are mapped to typed `ServiceError::Persistence`; `dequeue_next` returns `Ok(None)` not an error on empty queue, matching the trait signature.
- Tests: 21 tests total, all passing. Unit tests in each sub-module cover success and failure paths independently. Integration tests in `lib.rs` exercise the full actor round-trip for all five ACs. Tests are independent (each constructs its own handle and aborts its own task).
- Security: no hardcoded secrets; `#![forbid(unsafe_code)]` present in all three files; no external input bypasses type validation.
- Readability: names are descriptive and follow project `snake_case` / `UpperCamelCase` conventions; functions are focused; doc comments explain `# Errors` and `# Panics` where appropriate; no dead code or debug artifacts.
- Performance: `VecDeque` with pre-allocated capacity avoids reallocations; no unnecessary cloning in the hot path; `#[cfg(test)]` gate on `len()` produces no release-build code.
- Clippy passes with `-D warnings`; workspace builds cleanly.

Minor observation (non-blocking): the `cfg` field on `Actor` is retained after construction solely to supply the tracing `INFO` log in `run`. This is fine — it gives operators visibility into configured limits on startup.
