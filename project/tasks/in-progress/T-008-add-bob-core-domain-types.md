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

## Review
