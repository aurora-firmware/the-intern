---
id: T-041
title: Deduplicate PeerCred between admin-rpc and extension-ipc
status: pending
priority: medium
assigned-role: unassigned
created: '2026-05-19'
---

# Deduplicate PeerCred between admin-rpc and extension-ipc

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

`the-intern/service/crates/admin-rpc/src/peer_cred.rs` and `the-intern/service/crates/extension-ipc/src/peer_cred.rs` are literal copies of the same `PeerCred` struct and `is_allowed` logic. Consolidate into a single source — either `bob-core::auth` or a new tiny shared crate (`bob-ipc-common`) — and have both consumers depend on it. The duplication was flagged in the post-S-003 architecture review as the simplest of several identity-model issues to resolve.

## Acceptance Criteria

AC-1: WHEN both `admin-rpc` and `extension-ipc` are built THE SYSTEM SHALL link a single shared `PeerCred` type from one canonical module/crate, with no duplicated source files.
AC-2: THE SYSTEM SHALL preserve the existing public `PeerCred` surface in both `admin-rpc` and `extension-ipc` (re-exports are permitted) so no downstream caller needs to change imports.
AC-3: WHEN `cargo test -p admin-rpc -p extension-ipc` is run THE SYSTEM SHALL pass with no behavioural regression.

## Dependencies

- None.

## Files to Touch

- `the-intern/service/crates/admin-rpc/src/peer_cred.rs` — delete or convert to re-export.
- `the-intern/service/crates/extension-ipc/src/peer_cred.rs` — delete or convert to re-export.
- `the-intern/service/crates/bob-core/src/auth.rs` (new) OR a new `the-intern/service/crates/bob-ipc-common/` crate hosting the canonical `PeerCred`.
- The relevant `Cargo.toml` files (workspace + consumers) to declare the new dependency.

## Verification

```bash
cd the-intern/service
cargo test -p admin-rpc -p extension-ipc
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
