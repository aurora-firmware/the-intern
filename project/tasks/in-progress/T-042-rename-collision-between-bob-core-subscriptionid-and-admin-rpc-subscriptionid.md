---
id: T-042
title: Rename collision between bob-core SubscriptionId and admin-rpc 
  SubscriptionId
status: pending
priority: low
assigned-role: unassigned
created: '2026-05-19'
---

# Rename collision between bob-core SubscriptionId and admin-rpc SubscriptionId

<!--
Task Quality Rules (see the new-task skill for full details):
  - Atomic — one clear outcome.
  - One-shottable — ≤ 3–4 files touched, ≤ 5 ACs, Description ≈ 20 lines.
  - Verifiable — concrete Verification command or explicit manual steps.
  - Self-contained — Description is enough to start without follow-up questions.
  - EARS — every AC matches one of the five EARS patterns below.
  - Dependency-honest — list every prior task this one reads from or modifies.
-->

## Description

Two unrelated types share the name `SubscriptionId`: `bob-core::types::SubscriptionId` is a `Uuid` used as the public subscription handle, while `admin-rpc::subscriptions::SubscriptionId` is a `u64` counter local to the admin-rpc subscription bus. The name collision makes cross-crate reading confusing. Rename the admin-rpc-local type (e.g. to `AdminSubscriptionId` or `BusSubscriptionId`) so the `bob-core` type remains the single shared name.

## Acceptance Criteria

AC-1: WHEN code references `SubscriptionId` THE SYSTEM SHALL refer to exactly one type — the `bob-core` UUID-based type.
AC-2: WHEN the admin-rpc subscription bus uses its u64 counter type THE SYSTEM SHALL refer to it under a non-colliding name (e.g. `AdminSubscriptionId`) and all call sites SHALL use the new name.
AC-3: WHEN `cargo build --workspace && cargo test --workspace` runs THE SYSTEM SHALL pass.

## Dependencies

- None.

## Files to Touch

- `the-intern/service/crates/admin-rpc/src/subscriptions.rs` — define and use the renamed type.
- `the-intern/service/crates/admin-rpc/src/lib.rs` — update any internal re-exports and uses.
- `the-intern/service/crates/admin-rpc/src/dispatch.rs` — update uses if it references the local type.

## Verification

```bash
cd the-intern/service
cargo build --workspace
cargo test --workspace
```

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

### Session 1 — 2026-05-19

**What was done**

Renamed the admin-rpc-local `SubscriptionId` (u64 counter) to `AdminSubscriptionId` across the three files listed in the task: `subscriptions.rs`, `lib.rs`, and `dispatch.rs`. The rename touches the type definition, every method signature, every field type, all internal usages (including the `BusState` struct maps and the `ConnectionRegistry` struct), and all tests that directly constructed or matched on the old name.

A new test (`admin_subscription_id_is_the_bus_local_u64_type`) was written first to drive the red state — it referenced `AdminSubscriptionId` before the type existed, producing compiler errors. Once the rename was applied the test turned green along with all 80 pre-existing admin-rpc tests. The full workspace build and test run (`cargo build --workspace && cargo test --workspace`) passes with zero failures.

**What was tried and rejected**

No alternative names were evaluated; the task specified `AdminSubscriptionId` and that choice is unambiguous.

**Decisions made**

- Used `AdminSubscriptionId` (not `BusSubscriptionId`) as specified in AC-2.
- One comment in the new AC-2 test body (`// is distinct from the name SubscriptionId`) was intentionally left as a plain `SubscriptionId` reference because it is an explanatory comment, not a type use. This is the only remaining bare occurrence and it is appropriate prose.
- The `pending_audit_receivers` field in `ConnectionRegistry` is declared but never populated; that is pre-existing behavior not touched by this task.

**What remains**

Nothing. All three ACs are satisfied and the task is complete.

**Obstacles encountered**

None.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->
