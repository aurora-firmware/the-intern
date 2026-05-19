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

### Session 1 — 2026-05-19

**What was done**

The task required eliminating identical `PeerCred`/`is_allowed`/`peer_cred_from_fd` definitions duplicated in `admin-rpc/src/peer_cred.rs` and `extension-ipc/src/peer_cred.rs`.

The consolidation target chosen was `bob_core::auth` (new file), not a new `bob-ipc-common` crate. Both `admin-rpc` and `extension-ipc` already depend on `bob-core`, so adding a shared module there required only one new source file and minor Cargo.toml changes — no new crate registration in the workspace.

Three TDD cycles were run:

1. **AC-1 — canonical module:** Wrote failing tests in the empty `bob-core/src/auth.rs` (and wired it into `lib.rs`). Compile failed as expected. Added `nix` dependency to `bob-core/Cargo.toml`, wrote the full implementation (struct, `is_allowed`, platform-gated `peer_cred_from_fd`). All 80 bob-core tests passed. Added `#[must_use]` to `is_allowed` during refactor to silence the pedantic clippy lint.

2. **AC-2 / AC-3 — re-exports and no regression:** Replaced both crate-local `peer_cred.rs` files with `pub use bob_core::auth::{…}` re-export modules, preserving all original test coverage within each crate. Ran `cargo test -p admin-rpc -p extension-ipc`; 79 + 29 tests passed, 0 failed.

**What was tried and rejected**

- Creating a new `bob-ipc-common` crate: rejected because both consumers already depend on `bob-core`, adding the module there avoids a new crate and all the workspace plumbing that comes with it.

**Decisions made**

- Canonical location: `bob_core::auth`. Rationale: zero new dependency edges; `bob-core` is already the shared kernel crate.
- Re-export strategy: each crate's `peer_cred.rs` becomes a thin `pub use` module, so no callsites in `listener.rs` or elsewhere needed updating.
- Added `tempfile = "3"` to `bob-core` dev-dependencies to support the socket test in `auth`.

**What remains**

Nothing. All three acceptance criteria are satisfied and both branches of the task scope are covered by passing tests.

**Obstacles Encountered**

A `git stash pop` conflict on the generated `Cargo.lock` file during a baseline clippy check required a `git checkout the-intern/service/Cargo.lock` before the pop succeeded; no code was affected.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->
