---
id: T-056
title: Implement the action gate evaluation in extension-ipc multiplex
status: pending
priority: high
assigned-role: unassigned
created: '2026-05-20'
spec: S-004
---

# Implement the action gate evaluation in extension-ipc multiplex

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

Phase 4 of S-004. Replace the hardcoded deny verdict in
`extension-ipc::multiplex` with a real action evaluation against the policy
snapshot.

Today `multiplex::handle_frame` answers every `Authz` frame with
`PolicyVerdict { allow: false, reason: "policy not implemented" }`. Change
it to call `PolicyEngine::evaluate_action(snapshot, &tool, &arguments)` and
route the resulting verdict back as `OutboundFrame::AuthzVerdict`.

- Add a `policy-control` dependency to `extension-ipc`.
- Give the `extension-ipc` `Config` (and the `Multiplex`) a
  `policy_control::SnapshotHandle` so `handle_frame` reads the current
  snapshot per request.
- In `bob/src/serve.rs`, pass the `SnapshotHandle` (from T-053's wiring)
  into `extension_ipc::Config`.

The `Event` arm of `handle_frame` is unchanged. Update the multiplex unit
tests so the `Authz` path asserts a real verdict (allow for a tool the test
ruleset permits, deny otherwise) instead of the old hardcoded string.

## Acceptance Criteria

AC-1: WHEN `multiplex` handles an `Authz` frame THE SYSTEM SHALL evaluate `(tool, arguments)` via `PolicyEngine::evaluate_action` against the current policy snapshot.
AC-2: WHEN a verdict is produced THE SYSTEM SHALL route it back to the originating session as an `OutboundFrame::AuthzVerdict`.
AC-3: The system shall no longer return the hardcoded `"policy not implemented"` verdict for `Authz` frames.
AC-4: WHEN `bob serve` constructs the extension-ipc actor THE SYSTEM SHALL supply it the policy snapshot handle.

## Dependencies

- `T-055` — freezes the `Authz` frame schema; shares `framing.rs`, `multiplex.rs`, and `lib.rs`.
- `T-053` — provides the `SnapshotHandle` and shares `bob/src/serve.rs`.
- `T-054` — shares `bob/src/serve.rs`; sequencing avoids a conflict on that file.

## Files to Touch

- `the-intern/service/crates/extension-ipc/src/multiplex.rs` — real action evaluation in `handle_frame`; update tests.
- `the-intern/service/crates/extension-ipc/src/lib.rs` — add the snapshot handle to `Config`.
- `the-intern/service/crates/extension-ipc/Cargo.toml` — add the `policy-control` dependency.
- `the-intern/service/crates/bob/src/serve.rs` — pass the snapshot handle into `extension_ipc::Config`.

## Verification

```bash
cd the-intern/service
cargo test -p extension-ipc -p bob
cargo clippy -p extension-ipc -p bob --all-targets
```

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

### Session 1 — 2026-05-20

Picked up the task on the assigned branch. The Work Log was empty; this is the first session.

**What was done**

All four acceptance criteria were implemented in a single TDD cycle:

- `extension-ipc/Cargo.toml`: added `policy-control = { path = "../policy-control" }` as a direct dependency.
- `extension-ipc/src/multiplex.rs`: imported `policy_control::{PolicyEngine, SnapshotHandle}`, added `snapshot: SnapshotHandle` to `SessionMultiplexer`, updated its `new` constructor to accept the handle as a third argument, and replaced the hardcoded deny verdict in `handle_frame` with a call to `PolicyEngine::evaluate_action(snapshot.load(), &tool, &arguments)`. New tests added: `authz_frame_returns_allow_when_snapshot_has_matching_rule` (AC-1/AC-2) and `authz_verdict_reason_is_absent_when_snapshot_returns_not_the_hardcoded_string` (AC-3). Existing deny test renamed and updated; all other tests updated to pass the snapshot handle.
- `extension-ipc/src/lib.rs`: added `policy_snapshot: policy_control::SnapshotHandle` to `Config`, updated `Default` to start a deny-all `policy_control` actor and use its snapshot handle, updated `run_connection` and `run_listener` to accept and propagate the handle, updated `start()` to clone the handle from config into `run_listener`.
- `bob/src/serve.rs`: in `try_start_subsystems`, passed `policy_snapshot: policy_snapshot.clone()` into `extension_ipc::Config`. Also converted the pre-existing `extension_ipc_config_accepts_tracing_monitoring_handle` test from `#[test]` to `#[tokio::test(flavor = "current_thread")]` because `Config::default()` now calls `policy_control::start()` which requires a Tokio runtime.

**Tried and rejected**

Making `SnapshotHandle::new` public to avoid starting an actor in `Config::default()` was considered but `policy-control/src/lib.rs` is not in the task's Files to Touch. The simpler fix of promoting the existing test to async was the right call since `serve.rs` is in scope.

**What remains**

Nothing — all ACs are implemented, all tests pass, and no new clippy errors were introduced. The task is ready for review.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->
