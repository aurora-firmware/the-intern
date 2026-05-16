---
id: T-010
title: Add bob-core port traits
status: pending
priority: high
assigned-role: unassigned
created: '2026-05-16'
spec: S-001
---

# Add bob-core port traits

## Description

Define the async port traits every subsystem in S-001 implements, per S-002
§Component 2 ("Port traits"). These traits live in `bob-core` (no Tokio
dependency); concrete implementations in subsystem crates implement them over
Tokio primitives.

Traits to add:

- `RequestsHandler` — `submit(event: InternalEvent) -> ServiceResult<()>`.
- `PolicyEngine` — `verdict(req: VerdictRequest) -> ServiceResult<PolicyVerdict>`.
- `AuditSink` — `append(record: AuditRecord) -> ServiceResult<()>`.
- `EventBus` — `publish(event: InternalEvent) -> ServiceResult<()>` and `subscribe(filter) -> ServiceResult<Receiver<InternalEvent>>` (where `Receiver` is a channel-agnostic trait, not Tokio-specific).
- `SessionPool` — `list() -> ServiceResult<Vec<SessionId>>`, `kill(id: SessionId) -> ServiceResult<()>`.
- `PersistenceStore` — `enqueue(event) -> ServiceResult<()>`, `dequeue_next() -> ServiceResult<Option<InternalEvent>>`, `put_session_state(id, state) -> ServiceResult<()>`, `get_session_state(id) -> ServiceResult<Option<SessionState>>`.

`SessionState` and `VerdictRequest` are tiny supporting types defined alongside
the traits. Each trait uses `#[async_trait::async_trait]`. No Tokio types
appear in any signature.

## Acceptance Criteria

AC-1: The system shall expose `RequestsHandler`, `PolicyEngine`, `AuditSink`, `EventBus`, `SessionPool`, and `PersistenceStore` as public async traits in `bob_core::ports`.
AC-2: Every method on every trait in `bob_core::ports` shall return `bob_core::error::ServiceResult<T>`.
AC-3: The system shall annotate every trait in `bob_core::ports` with `#[async_trait]`.
AC-4: The system shall NOT add a Tokio dependency to `bob-core/Cargo.toml`, and no Tokio type shall appear in any signature in `bob_core::ports`.

## Dependencies

- `T-007` — `ports.rs` placeholder must exist
- `T-008` — domain types referenced by signatures
- `T-009` — `ServiceError` / `ServiceResult` referenced by signatures

## Files to Touch

- `the-intern/service/crates/bob-core/src/ports.rs` — replace placeholder; six trait definitions plus supporting types

## Verification

```bash
cd the-intern/service && cargo check -p bob-core
! grep -E '\btokio::' the-intern/service/crates/bob-core/src/ports.rs
! grep -E '^tokio\b' the-intern/service/crates/bob-core/Cargo.toml
```

## Work Log

### Session 1 — 2026-05-17

Continued from existing in-progress TDD work already present in `bob-core` (`ports.rs` tests plus `futures` dev-dependency). Verified red first by running `cargo test -p bob-core`, which failed on unresolved trait/type imports in `bob_core::ports` as expected. Implemented minimal production code in `ports.rs`: public async traits `RequestsHandler`, `PolicyEngine`, `AuditSink`, `EventBus`, `SessionPool`, and `PersistenceStore`, plus supporting `SessionState` and `VerdictRequest`. Kept signatures runtime-agnostic with no Tokio types and `ServiceResult<T>` returns across trait methods; retained a channel-agnostic `Receiver` trait for `EventBus::subscribe` and updated its `recv` to return `ServiceResult<Option<InternalEvent>>` to keep error handling consistent. Re-ran unit tests and task verification commands to confirm green and no Tokio references. Tried to run formatting, but `cargo fmt` is unavailable in this environment. No lifecycle files were edited on the task branch.

## Review

### Review Verdict — 2026-05-17

PASS

Stage 1 (acceptance criteria) passed. Verified in commit `f2ab9d7` that
`RequestsHandler`, `PolicyEngine`, `AuditSink`, `EventBus`, `SessionPool`, and
`PersistenceStore` are public async traits in `bob_core::ports`; every method
on every trait in `ports.rs` returns `ServiceResult<T>`; every trait in
`ports.rs` is annotated with `#[async_trait]`; `bob-core/Cargo.toml` adds no
Tokio dependency and no Tokio type appears in any `ports.rs` signature.

Stage 2 (code quality) passed. Trait boundaries are runtime-agnostic, tests
cover each trait method contract, and no correctness/security/performance issues
were identified within task scope.
