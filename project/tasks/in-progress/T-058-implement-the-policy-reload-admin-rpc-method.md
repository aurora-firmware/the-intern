---
id: T-058
title: Implement the policy.reload admin-RPC method
status: pending
priority: medium
assigned-role: unassigned
created: '2026-05-20'
spec: S-004
---

# Implement the policy.reload admin-RPC method

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

Phase 6 of S-004. Implement the `policy.reload` admin-RPC method. It
currently returns `NotImplemented` in `admin-rpc::dispatch`.

`dispatch` already receives the `policy-control` `Handle` (as the `_policy`
field). Wire the `policy.reload` arm to call `Handle::reload()`:

- On success, return a JSON-RPC success response indicating the ruleset was
  reloaded.
- On failure (config parse/validation error), return a JSON-RPC error
  response carrying the rejection reason. The previously active snapshot
  staying in force is guaranteed by `reload()` itself (T-052).
- WHERE no `policy-control` handle is configured (`policy: None`), keep
  returning the existing `NotImplemented` error.

Rename the `_policy` field to `policy`, and update the `dispatch` doc table
and the `admin-rpc/src/lib.rs` doc comment. Update the existing
`dispatch_policy_reload_returns_not_implemented` test to reflect the new
behaviour (keep it for the `policy: None` case and add success/failure
coverage).

## Acceptance Criteria

AC-1: WHEN a `policy.reload` request is dispatched and the `policy-control` handle is present THE SYSTEM SHALL call the actor's reload and return a JSON-RPC success response on success.
AC-2: IF `policy.reload` is dispatched and the reload fails parse or validation THEN THE SYSTEM SHALL return a JSON-RPC error response carrying the rejection reason.
AC-3: WHERE no `policy-control` handle is configured THE SYSTEM SHALL return the existing `NotImplemented` error for `policy.reload`.

## Dependencies

- `T-052` — provides `policy-control` `Handle::reload()`.

## Files to Touch

- `the-intern/service/crates/admin-rpc/src/dispatch.rs` — implement the `policy.reload` arm; update tests and the doc table.
- `the-intern/service/crates/admin-rpc/src/lib.rs` — update the `policy` field doc comment.

## Verification

```bash
cd the-intern/service
cargo test -p admin-rpc
cargo clippy -p admin-rpc --all-targets
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
