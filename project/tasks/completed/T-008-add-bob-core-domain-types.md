---
id: T-008
title: Add bob-core domain types
status: completed
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

### Review Verdict — 2026-05-16

FAIL

**Stage 1 — Acceptance Criteria**

AC-1: PASS. All five identifier newtypes (`SessionId`, `RequestId`, `SubscriptionId`, `ChannelId`, `UserId`) are defined in `identifiers.rs` as newtype wrappers over `uuid::Uuid` with the required derives and trait impls, and are re-exported from `bob_core::types`.

AC-2: PASS. `InternalEvent` is defined as a public enum with the four required variants (`ChatMessage`, `EmailReceived`, `Webhook`, `Scheduled`) using `#[serde(tag = "type")]` internal tagging, and is re-exported from `bob_core::types`.

AC-3: PASS. `RequestContext`, `PolicyVerdict`, `AuditRecord`, and `MonitoringReport` are all defined and re-exported from `bob_core::types`. `PolicyVerdict { allow: bool, reason: Option<String> }` matches the spec exactly. `AuditRecord` uses `String` RFC 3339 timestamp with a stable unit-variant `AuditKind` enum. `MonitoringReport` shape matches the description.

AC-4: FAIL. The round-trip tests for all four `InternalEvent` variants use `assert!(matches!(restored, InternalEvent::SomeVariant { .. }))`, which only confirms the variant discriminant survived deserialization — it does not verify that field values are equal to the originals. AC-4 requires "a value equal to the original." The wildcard `..` in each `matches!` call would allow field corruption (e.g., empty string where a non-empty string was serialized) to pass undetected. Since all `InternalEvent` variant fields are `String`, `PartialEq` is trivially derivable and `assert_eq!` on the full value is possible.

AC-5: PASS. Verified by grep: no `tokio` entry in `bob-core/Cargo.toml`. All three verification shell commands pass.

**Stage 2 — Code Quality**

All Stage 2 checks pass except those related to the AC-4 issue above:

- Identifier derives are correct: `Debug`, `Clone`, `Copy`, `PartialEq`, `Eq`, `Hash`, `Serialize`, `Deserialize`, plus `Display` and `FromStr` via the `impl_id!` macro. `Default` is also provided (generates a new random id). All five identifiers are defined and exported.
- `#[serde(tag = "type")]` tagging for `InternalEvent` is reasonable and fully round-trippable with `serde_json`.
- `RequestContext` fields match the spec: `sender: UserId`, `source: ChannelId`, `context_id: Option<String>`. Its round-trip tests assert field-by-field equality using `assert_eq!` — those are adequate.
- `PolicyVerdict`, `AuditRecord`, and `MonitoringReport` round-trip tests assert field equality and the exhaustive `AuditKind` variant array covers all seven variants.
- `#![forbid(unsafe_code)]` is present in `lib.rs` and unaffected by this change.
- No Tokio dependency added.
- `types/mod.rs` re-exports every public type including `AuditKind`.
- No dead code, debug artifacts, hardcoded secrets, or out-of-scope file modifications.
- Test independence is maintained (no shared mutable state).

**Required fix**

- **File:** `the-intern/service/crates/bob-core/src/types/event.rs`
- **Location:** `tests` module — all four `internal_event_*_serde_json_round_trip` functions.
- **What is wrong:** Each test uses `assert!(matches!(restored, InternalEvent::SomeVariant { .. }))`, which ignores field values. AC-4 requires the restored value to equal the original, not merely share its discriminant.
- **What should change:** Add `PartialEq` (and `Eq`) to the derives on `InternalEvent` (all fields are `String`, so this is straightforward), then replace each `matches!` assertion with `assert_eq!(original_event_variable, restored)`. The four tests require both a derive change on the enum and an `assert_eq!` in each test body. No other changes are needed.

### Session 2 — 2026-05-17

**What was done**

Addressed the sole AC-4 failure from the Session 1 review. Two targeted changes were made to `the-intern/service/crates/bob-core/src/types/event.rs`:

1. Added `PartialEq, Eq` to the `#[derive(...)]` on `InternalEvent`. All four variant fields are `String`, which already derives `PartialEq + Eq`, so this compiled cleanly with no further changes.
2. In each of the four `internal_event_*_serde_json_round_trip` tests, renamed `event` to `original` and replaced `assert!(matches!(restored, InternalEvent::SomeVariant { .. }))` with `assert_eq!(original, restored)`. The `original` binding is moved into the assertion, so the borrow checker is satisfied without cloning.

All 35 tests pass (`cargo test -p bob-core --lib`), `cargo check -p bob-core` is clean, and the `! grep -E '^tokio\b'` check still holds.

**What was tried and rejected**

No alternative approaches were needed.

**What remains**

Nothing. All five acceptance criteria are now fully satisfied.

**Obstacles Encountered**

- None.

**Artifacts**

- Branch `task/T-008-add-bob-core-domain-types`, commit `5c73921`: `test(bob-core): tighten InternalEvent round-trip tests to assert_eq`.

### Review Verdict — 2026-05-17

PASS

**Stage 1 — Acceptance Criteria**

AC-1: PASS. Unchanged from prior cycle — all five identifier newtypes remain correctly defined and re-exported.

AC-2: PASS. `InternalEvent` now derives `PartialEq, Eq` in addition to the previously confirmed derives. The enum definition and re-export are unchanged.

AC-3: PASS. Unchanged from prior cycle.

AC-4: PASS. All four `internal_event_*_serde_json_round_trip` tests now use `assert_eq!(original, restored)`. The `original` binding holds the fully constructed value; `restored` is the deserialized output of `serde_json::to_string` applied to `original`. Because `PartialEq` and `Eq` are now derived on `InternalEvent` (all fields are `String`, which already implements both), `assert_eq!` performs a deep field-value equality check — satisfying the "value equal to the original" requirement of AC-4.

AC-5: PASS. No Tokio dependency. Confirmed by grep against `bob-core/Cargo.toml`.

**Stage 2 — Code Quality**

All Stage 2 checks pass. The fix is minimal and precisely scoped:

- Only `the-intern/service/crates/bob-core/src/types/event.rs` was modified (one file, one commit `5c73921`).
- Adding `PartialEq, Eq` to `InternalEvent` is strictly additive and correct — all four variant fields are `String`, which trivially satisfies both traits.
- The four renamed `original` bindings and `assert_eq!` assertions are clear, idiomatic Rust.
- No dead code, debugging artifacts, hardcoded secrets, or out-of-scope file modifications were introduced.
- All 35 library tests pass (`cargo test -p bob-core --lib`). `cargo check -p bob-core` is clean. No Tokio entry present in `Cargo.toml`.

**Minor observations (non-blocking)**

`RequestContext` does not yet derive `PartialEq`/`Eq`. Its round-trip tests assert field-by-field equality using the `PartialEq` on the identifier newtypes, which is sufficient for the current tests. This is within scope of the task as written and requires no action.
