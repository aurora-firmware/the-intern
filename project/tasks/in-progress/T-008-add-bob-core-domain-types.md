---
id: T-008
title: Add bob-core domain types
status: pending
priority: high
assigned-role: unassigned
created: '2026-05-16'
spec: S-001
---

# Add bob-core domain types

## Description

Fill the `bob_core::types` module with the pure data types every subsystem
will speak in, per S-001 §Components and S-002 §Component 2. Three groups:

- **Identifiers** — `SessionId`, `RequestId`, `SubscriptionId`, `ChannelId`,
  `UserId`. Each is a newtype wrapper over `uuid::Uuid` with `Display`,
  `FromStr`, `Serialize`/`Deserialize`, `Hash`, `Eq`, `PartialEq`, `Clone`,
  `Copy` (where the wrapped value is `Copy`), and a `new()` constructor.
- **Event + context** — `InternalEvent` (enum covering normalized channel
  events: `ChatMessage`, `EmailReceived`, `Webhook`, `Scheduled`) and
  `RequestContext` (sender `UserId`, source `ChannelId`, optional
  conversational/transactional context id).
- **Records** — `PolicyVerdict` (`{ allow: bool, reason: Option<String> }`),
  `AuditRecord` (timestamped append-only log entry with a stable kind enum),
  `MonitoringReport` (action self-report from external CLIs).

All types derive `Debug`, `Clone`, `serde::Serialize`, `serde::Deserialize`.
No Tokio dependency. The module re-exports every public type through
`types/mod.rs`.

## Acceptance Criteria

AC-1: The system shall expose `SessionId`, `RequestId`, `SubscriptionId`, `ChannelId`, and `UserId` as public newtype wrappers over `uuid::Uuid` re-exported from `bob_core::types`.
AC-2: The system shall expose `InternalEvent` as a public enum re-exported from `bob_core::types`, with variants covering chat, email, webhook, and scheduled triggers.
AC-3: The system shall expose `RequestContext`, `PolicyVerdict`, `AuditRecord`, and `MonitoringReport` as public records re-exported from `bob_core::types`.
AC-4: WHEN any public type in `bob_core::types` is serialized with `serde_json::to_string` and deserialized back with `serde_json::from_str` THE SYSTEM SHALL produce a value equal to the original.
AC-5: The system shall NOT add a Tokio dependency to `bob-core/Cargo.toml`.

## Dependencies

- `T-007` — workspace and `bob-core` skeleton must exist with the dependencies and `types/mod.rs` placeholder already in place

## Files to Touch

- `the-intern/service/crates/bob-core/src/types/mod.rs` — replace placeholder; declare submodules and `pub use` every public type
- `the-intern/service/crates/bob-core/src/types/identifiers.rs` — new; newtype identifier definitions
- `the-intern/service/crates/bob-core/src/types/event.rs` — new; `InternalEvent` enum and `RequestContext` struct
- `the-intern/service/crates/bob-core/src/types/records.rs` — new; `PolicyVerdict`, `AuditRecord`, `MonitoringReport`

## Verification

```bash
cd the-intern/service && cargo test -p bob-core --lib
cd the-intern/service && cargo check -p bob-core
! grep -E '^tokio\b' the-intern/service/crates/bob-core/Cargo.toml
```

## Work Log

### Session 1 — 2026-05-16

**What was done**

Implemented the three groups of domain types required by T-008 using TDD, one red-green-refactor cycle per group:

1. **AC-1 — Identifiers** (`identifiers.rs`): Created five newtype wrappers over `uuid::Uuid` (`SessionId`, `RequestId`, `SubscriptionId`, `ChannelId`, `UserId`). Each derives `Debug`, `Clone`, `Copy`, `PartialEq`, `Eq`, `Hash`, `Serialize`, `Deserialize` and exposes a `new()` constructor, `Display`, and `FromStr`. A single `impl_id!` macro avoids boilerplate repetition. Tests cover `new()` uniqueness, `Display`/`FromStr` round-trip, `serde_json` round-trip, `Copy` semantics, and `Hash`/`Eq` via `HashSet`. 18 tests, all green. Committed: `feat(bob-core): add identifier newtypes with serde and display support`.

2. **AC-2 — Event + context** (`event.rs`): `InternalEvent` is a `#[serde(tag = "type")]` enum with variants `ChatMessage { content }`, `EmailReceived { subject, body }`, `Webhook { source, payload }`, and `Scheduled { cron }`. `RequestContext` holds `sender: UserId`, `source: ChannelId`, and `context_id: Option<String>`. Tests verify serde round-trips for all four variants and both optional-field states of `RequestContext`, plus `Clone`/`Debug`. 8 tests, all green. Committed: `feat(bob-core): add InternalEvent enum and RequestContext struct`.

3. **AC-3 + AC-4 — Records** (`records.rs`): `PolicyVerdict { allow: bool, reason: Option<String> }` matches the task spec exactly. `AuditRecord` holds an RFC 3339 UTC `timestamp: String`, a stable `AuditKind` enum, and a `description`. `AuditKind` has seven variants (`RequestReceived`, `PolicyDecision`, `ActionInvoked`, `ActionCompleted`, `ActionFailed`, `SessionStarted`, `SessionEnded`) — all unit variants to guarantee stable serialized names. `MonitoringReport` has `action`, `outcome`, and `details: Option<String>`. Tests cover all serde round-trips including all `AuditKind` variants and `Clone`/`Debug` for all three types. 9 tests, all green. Committed: `feat(bob-core): add PolicyVerdict, AuditRecord, and MonitoringReport types`.

All three modules are re-exported from `types/mod.rs`. No Tokio dependency was added (AC-5 confirmed by grep).

**What was tried and rejected**

Used RFC 3339 `String` for `AuditRecord.timestamp` rather than a typed `chrono::DateTime` or `time::OffsetDateTime` because neither `chrono` nor `time` is in the workspace dependencies and adding them was outside scope. A string timestamp is sufficient for the pure domain type layer — the adapter boundary that creates `AuditRecord`s can validate and format timestamps.

Used `#[serde(tag = "type")]` (internally tagged) for `InternalEvent` as it produces the most ergonomic JSON structure (`{"type":"ChatMessage","content":"..."}`) while remaining fully round-trippable.

**What remains**

Nothing. All five acceptance criteria are met, all 35 tests pass, `cargo check` is clean, and no Tokio dependency was introduced.

**Obstacles Encountered**

- `cargo clippy` is not installed in this environment; `cargo check` was used as the local quality gate instead. The workspace `[workspace.lints.clippy]` configuration will be enforced by CI.
- The `AuditRecord.timestamp` field uses `String` (RFC 3339 format) rather than a typed time value because `chrono`/`time` are not in the workspace dependencies and adding them was outside task scope.

**Artifacts**

- Branch `task/T-008-add-bob-core-domain-types`, three commits: `28b4483`, `40ea502`, `bf8e4ea`.

## Review
