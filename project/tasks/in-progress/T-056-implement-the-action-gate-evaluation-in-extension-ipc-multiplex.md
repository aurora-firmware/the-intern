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

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->
