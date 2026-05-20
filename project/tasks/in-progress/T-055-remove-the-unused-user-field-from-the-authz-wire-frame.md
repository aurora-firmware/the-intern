---
id: T-055
title: Remove the unused user field from the Authz wire frame
status: pending
priority: medium
assigned-role: unassigned
created: '2026-05-20'
spec: S-004
---

# Remove the unused user field from the Authz wire frame

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

Phase 4 of S-004 (preparatory). The `InboundFrame::Authz` variant in
`extension-ipc` carries a `user: String` field that was a placeholder and
is never populated by anything real (tests hardcode `"alice"`/`"bob"`).
Action rules are global and consult no user, so the field is removed from
the wire schema before the action gate is built.

In `extension-ipc/src/framing.rs`: remove `user` from `InboundFrame::Authz`,
leaving `session`, `tool`, and `arguments`. Update the framing unit tests
that construct or assert the `Authz` frame.

In `extension-ipc/src/lib.rs` and `extension-ipc/src/multiplex.rs`: update
the tests and helpers that build `Authz` frames or raw `authz` JSON with a
`user` field so they no longer reference it. `multiplex::handle_frame`
matches `InboundFrame::Authz { session, .. }` and is unaffected by the
field removal — do **not** change its verdict logic here (T-056 does that).

This task is pure wire-schema cleanup: the workspace build and all tests
stay green.

## Acceptance Criteria

AC-1: The system shall define `InboundFrame::Authz` with exactly the fields `session`, `tool`, and `arguments`, and no `user` field.
AC-2: WHEN an `authz` frame is parsed THE SYSTEM SHALL accept it without requiring a `user` field.
AC-3: The system shall update all `extension-ipc` tests and helpers so none construct or assert an `Authz` frame `user` field.

## Dependencies

- None

## Files to Touch

- `the-intern/service/crates/extension-ipc/src/framing.rs` — remove `user`; update framing tests.
- `the-intern/service/crates/extension-ipc/src/lib.rs` — update tests referencing the `user` field.
- `the-intern/service/crates/extension-ipc/src/multiplex.rs` — update test helpers that construct `Authz` frames.

## Verification

```bash
cd the-intern/service
cargo test -p extension-ipc
cargo clippy -p extension-ipc --all-targets
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
