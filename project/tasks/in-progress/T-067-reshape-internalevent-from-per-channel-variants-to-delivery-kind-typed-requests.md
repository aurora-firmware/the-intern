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

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->
