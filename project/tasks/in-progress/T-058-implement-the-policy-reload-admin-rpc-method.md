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

### Session 1 — 2026-05-20

Implemented T-058 with a strict TDD cycle in `admin-rpc`. I first read the canonical task on `dev-agent` and the existing Work Log section (empty), then added failing tests for `policy.reload`: one for the existing no-handle NotImplemented path, one success case with a real `policy-control` handle and valid temp config, and one failure case with invalid config asserting the JSON-RPC error carries a non-empty `reason`. After confirming red, I wired `policy.reload` in `Dispatcher::dispatch` to a new `handle_policy_reload` method. The new handler preserves NotImplemented when `policy` is `None`, returns success `{ ok: true, reloaded: true }` when reload succeeds, and returns a JSON-RPC error with `category` and `reason` data when reload fails. I also renamed `_policy` to `policy`, updated the dispatch method table, and updated the `admin-rpc/src/lib.rs` policy handle doc comment. I considered reusing `map_service_error` for reload failures, but rejected that because this task requires surfacing a rejection reason in the RPC error payload; the dedicated policy-reload error response is clearer and directly testable. Remaining work on this branch is complete; next steps are lifecycle-log append on `dev-agent` and reviewer validation.

Evidence:
- Red phase:
  - `cargo test -p admin-rpc dispatch_policy_reload` (failed as expected before implementation; 2 failing tests for unimplemented path/code mismatch).
- Green phase:
  - `cargo test -p admin-rpc dispatch_policy_reload` (3/3 passed).
- Refactor safety / verification:
  - `cargo test -p admin-rpc` initially failed in sandbox due Unix socket `Operation not permitted` on listener tests.
  - Re-ran unsandboxed with approval: `cargo test -p admin-rpc` (82 passed).
  - `cargo clippy -p admin-rpc --all-targets` (passed).

Obstacles Encountered:
- Sandbox environment blocks some Unix socket bind tests (`Operation not permitted`), so full test verification required an escalated run outside sandbox restrictions.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->

### Review Verdict — 2026-05-20
PASS

Result: PASS

Summary:
- Reviewed T-058 implementation at commit `f8713a0` on `task/T-058-implement-the-policy-reload-admin-rpc-method`; all acceptance criteria and Stage 2 quality checks passed.

Artifacts:
- Canonical task file updated: `project/tasks/in-progress/T-058-implement-the-policy-reload-admin-rpc-method.md` (this section).
- Diff reviewed from source branch/commit: `the-intern/service/crates/admin-rpc/src/dispatch.rs`, `the-intern/service/crates/admin-rpc/src/lib.rs`.
- Primary files inspected: `the-intern/service/crates/admin-rpc/src/dispatch.rs`, `the-intern/service/crates/admin-rpc/src/lib.rs`, canonical task definition.

Evidence:
- Stage 1 acceptance checks:
- AC-1 satisfied: `policy.reload` dispatch arm now calls `handle_policy_reload`, which invokes `policy.reload().await` and returns JSON-RPC success on `Ok(())` with `{ "ok": true, "reloaded": true }`.
- AC-2 satisfied: reload rejection path returns JSON-RPC error with rejection `reason` in error `data`.
- AC-3 satisfied: `policy: None` path still returns `NotImplemented` (`-32601`) for `policy.reload`.
- Expected commit scope validated via `git show --name-only f8713a0` (only the two expected implementation files changed in the Developer commit).
- Stage 2 checks:
- Correctness/readability: helper `handle_policy_reload` isolates behavior and preserves existing no-handle fallback semantics.
- Tests: new unit tests cover no-handle, success, and failure-with-reason flows.
- Verification commands run:
- `cargo test -p admin-rpc dispatch_policy_reload` (pass, 3 tests on source branch).
- `cargo clippy -p admin-rpc --all-targets` (pass).
- `cargo test -p admin-rpc` initially failed in sandbox with Unix-socket permission errors, then passed unsandboxed (82 passed, 0 failed) after escalation.

Obstacles Encountered:
- Sandbox restrictions caused expected Unix-socket `Operation not permitted` failures in full `cargo test -p admin-rpc`; resolved by rerunning verification with escalation outside sandbox.

Next Owner:
- Development Loop

Next Action:
- none
