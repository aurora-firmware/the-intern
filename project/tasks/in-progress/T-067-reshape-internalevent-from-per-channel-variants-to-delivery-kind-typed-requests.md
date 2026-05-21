---
id: T-067
title: Reshape InternalEvent from per-channel variants to delivery-kind-typed 
  requests
status: pending
priority: high
assigned-role: unassigned
created: '2026-05-21'
---

# Reshape InternalEvent from per-channel variants to delivery-kind-typed requests

## Description

Corrective task derived from the 2026-05-21 amendment to S-001
(`project/specs/the-intern-agent-service-architecture.md`) and **ADR-004**
(`project/decisions/ADR-004-inbound-request-interface-typed-by-delivery-kind-sync-async-periodic.md`).

The current `bob-core` `InternalEvent` is an enum whose variants name channels
directly — `ChatMessage`, `EmailReceived`, `Webhook`, `Scheduled`. ADR-004
forbids this: the core request interface must be typed by **delivery kind**,
never by channel. Channel identity belongs only in adapters. This deviation
was introduced by T-008 and must be corrected before Phase 6.

**Target shape** (defined here, in `crates/bob-core/src/types/event.rs`):

- A new public enum `DeliveryKind` with exactly the unit variants `Sync`,
  `Async`, and `Periodic`, deriving `Debug, Clone, Copy, PartialEq, Eq,
  Serialize, Deserialize`.
- `InternalEvent` becomes a public struct: `{ kind: DeliveryKind, payload:
  String }`, deriving `Debug, Clone, PartialEq, Eq, Serialize, Deserialize`.
  `payload` carries the normalized request content an adapter produced.
- **Keep the type name `InternalEvent`** — do not rename it or the `EventBus`/
  `EventSink` port traits or `submit_event`; renaming is out of scope.
- `RequestContext` is unchanged.
- Re-export `DeliveryKind` from `bob_core::types` (`types/mod.rs`).

All sites that *construct* the old variants are test code (production code uses
`InternalEvent` opaquely). Replace each `InternalEvent::ChatMessage { content }`
etc. with `InternalEvent { kind, payload }`, mapping chat→`Sync`,
email/webhook→`Async`, scheduled→`Periodic`. Rewrite the `event.rs` serde
round-trip tests to cover the new struct across all three `DeliveryKind`s.

This is a single breaking type change: it compiles green only as a whole, so
all listed files must change together in one task.

## Acceptance Criteria

AC-1: The system shall expose `InternalEvent` as a public struct re-exported
      from `bob_core::types`, with a `kind: DeliveryKind` field and a
      `payload: String` field, and no channel-named variants.

AC-2: The system shall expose `DeliveryKind` as a public enum re-exported from
      `bob_core::types`, with exactly the unit variants `Sync`, `Async`, and
      `Periodic`, deriving `Copy`, `Clone`, `Debug`, `PartialEq`, `Eq`, and
      serde `Serialize`/`Deserialize`.

AC-3: WHEN an `InternalEvent` value is serialized to JSON and deserialized
      back THE SYSTEM SHALL produce a value equal to the original, verified by
      a test for each `DeliveryKind` variant.

AC-4: IF any `crates/**/*.rs` file references `InternalEvent::ChatMessage`,
      `InternalEvent::EmailReceived`, `InternalEvent::Webhook`, or
      `InternalEvent::Scheduled` THEN THE SYSTEM SHALL be considered incomplete
      (no such reference may remain in the workspace).

AC-5: The full Rust workspace shall build and all existing tests shall pass
      under `cargo test --workspace`.

## Dependencies

- None — Phase 1 (T-008, T-026–T-030) is complete and integrated.

## Files to Touch

- `the-intern/service/crates/bob-core/src/types/event.rs` — replace the
  `InternalEvent` enum with the `{ kind, payload }` struct, add the
  `DeliveryKind` enum, rewrite the serde round-trip tests.
- `the-intern/service/crates/bob-core/src/types/mod.rs` — re-export
  `DeliveryKind`.
- `the-intern/service/crates/bob-core/src/ports.rs` — update stub/test
  construction sites to the new shape.
- `the-intern/service/crates/persistence/src/inbound.rs` — update the test
  helper that builds `InternalEvent`.
- `the-intern/service/crates/persistence/src/lib.rs` — update test
  construction sites.
- `the-intern/service/crates/requests-handler/src/queue.rs` — update the test
  helper that builds `InternalEvent`.
- `the-intern/service/crates/requests-handler/src/handler.rs` — update test
  construction sites (`chat_event` helper and inline constructions).
- `the-intern/service/crates/bob/src/serve.rs` — update test construction
  sites.
- `the-intern/service/crates/bob/tests/queue_load.rs` — update the
  `chat_event` helper and inline constructions.

Note: 9 files exceed the usual 3–4-file rule of thumb, but a breaking change
to a foundational type cannot be split into separately-integrable tasks — any
partial change leaves the workspace non-compiling. All edits outside
`event.rs`/`mod.rs` are mechanical constructor-site replacements.

## Verification

```bash
cd the-intern/service
cargo test --workspace
# No channel-named InternalEvent variant may remain anywhere:
! grep -rnE 'InternalEvent::(ChatMessage|EmailReceived|Webhook|Scheduled)' crates --include='*.rs'
```

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

### Session 1 — 2026-05-21

Implemented T-067 in a single TDD cycle spanning all 9 listed files.

**What was done:**

Started by confirming the workspace baseline — all 95+ tests across the
workspace passed before any changes. Read all 9 target files to understand the
constructor-site landscape.

Rewrote `crates/bob-core/src/types/event.rs` to replace the `InternalEvent`
enum (with `ChatMessage`, `EmailReceived`, `Webhook`, `Scheduled` variants)
with a `{ kind: DeliveryKind, payload: String }` struct, and added the
`DeliveryKind` enum (`Sync`, `Async`, `Periodic`) with the required derives.
Updated the tests to cover three new serde round-trips (one per `DeliveryKind`
variant) and removed the four old per-channel round-trip tests. The
`RequestContext` type was left untouched.

Updated `crates/bob-core/src/types/mod.rs` to re-export `DeliveryKind`
alongside `InternalEvent`.

Updated all 7 remaining constructor sites: `ports.rs` (3 inline constructions
in tests; changed `ChatMessage`→`Sync`, `Scheduled`→`Periodic`),
`persistence/src/inbound.rs` (helper `chat` function), `persistence/src/lib.rs`
(5 constructions across 3 tests; `ChatMessage`→`Sync`, `Scheduled`→`Periodic`),
`requests-handler/src/queue.rs` (helper `chat_event`),
`requests-handler/src/handler.rs` (helper `chat_event` and 2 inline
constructions), `bob/src/serve.rs` (2 inline constructions),
`bob/tests/queue_load.rs` (helper + 2 inline constructions).

The channel-to-kind mapping used throughout: `ChatMessage` → `Sync`,
`EmailReceived`/`Webhook` → `Async`, `Scheduled` → `Periodic`, consistent with
the task description.

**What was tried and rejected:**

No alternative approaches were considered — the task fully specified the target
shape and the mapping. The breaking change compiled as a unit: `bob-core`
compiled immediately after the type change, and the workspace build succeeded
because all old variant usages were confined to `#[cfg(test)]` blocks (not in
production code paths), which are excluded from the regular `cargo build`.

**Observations:**

The discovery that production code already used `InternalEvent` opaquely (only
tests constructed variants) meant `cargo build --workspace` succeeded without
errors immediately after the type change. The test compilation failures
(`E0223: ambiguous associated type`) only appeared under `cargo test
--workspace`, confirming the task's description that "all sites that
*construct* the old variants are test code."

Final verification: `cargo test --workspace` passes (all suites green, test
count increased by 1 in `bob-core` from 79 to 80 due to the new
`delivery_kind_has_sync_async_periodic_variants` test). The grep check confirms
zero remaining references to
`InternalEvent::{ChatMessage,EmailReceived,Webhook,Scheduled}`.

**What remains:** Nothing — all acceptance criteria are met and verified.
Commit `5c2143e` on `task/T-067-reshape-internalevent`.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->
