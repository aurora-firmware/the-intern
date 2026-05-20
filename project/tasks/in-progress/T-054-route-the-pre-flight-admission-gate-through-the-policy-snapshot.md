---
id: T-054
title: Route the pre-flight admission gate through the policy snapshot
status: pending
priority: high
assigned-role: unassigned
created: '2026-05-20'
spec: S-004
---

# Route the pre-flight admission gate through the policy snapshot

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

Phase 3 of S-004. Route the pre-flight admission gate through the shared
policy engine instead of the standalone `allowed_user_ids` membership test,
preserving observable behaviour.

In the `requests-handler` crate:

- Add a dependency on `policy-control`.
- Change `run_preflight` to take a `policy_control::SnapshotHandle` in place
  of `&PreflightConfig`. For each event it reads the current snapshot and
  calls `PolicyEngine::evaluate_admission(snapshot, context.sender)`. An
  allow verdict enqueues the event; a deny verdict — or an absent
  `RequestContext` — drops it, emits a `tracing::warn!` **without the
  payload**, and appends a `PreflightDenied` `AuditRecord`.
- Remove `PreflightConfig` and reconcile `start_with_preflight` in `lib.rs`
  (update its signature or remove it if unused) so the crate is consistent.

In `bob/src/serve.rs`, build the pre-flight closure from the
`SnapshotHandle` (returned by T-053's wiring) instead of `PreflightConfig`.

Behaviour to preserve exactly: deny on missing context, deny when the user
is not admitted, warn lines must never contain the raw event payload, and a
`PreflightDenied` audit record is appended on every denial.

## Acceptance Criteria

AC-1: WHEN `run_preflight` processes an event whose `RequestContext.sender` is admitted by the current snapshot THE SYSTEM SHALL enqueue the event to persistence.
AC-2: IF `run_preflight` processes an event whose sender is not admitted, or whose `RequestContext` is absent, THEN THE SYSTEM SHALL drop the event, emit a `tracing::warn!` that excludes the raw event payload, and append a `PreflightDenied` audit record.
AC-3: The system shall evaluate pre-flight admission via `PolicyEngine::evaluate_admission` against the policy snapshot, and the `PreflightConfig` type shall no longer exist.
AC-4: WHEN `bob serve` starts THE SYSTEM SHALL wire the pre-flight gate to read the policy snapshot handle.

## Dependencies

- `T-053` — provides the `SnapshotHandle` at startup and shares `bob/src/serve.rs` (sequencing avoids a conflict on that file).

## Files to Touch

- `the-intern/service/crates/requests-handler/Cargo.toml` — add the `policy-control` dependency.
- `the-intern/service/crates/requests-handler/src/handler.rs` — `run_preflight` via the engine; remove `PreflightConfig`.
- `the-intern/service/crates/requests-handler/src/lib.rs` — reconcile `start_with_preflight` and re-exports.
- `the-intern/service/crates/bob/src/serve.rs` — build the pre-flight closure from the snapshot handle.

## Verification

```bash
cd the-intern/service
cargo test -p requests-handler -p bob
cargo clippy -p requests-handler -p bob --all-targets
```

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

### Session 1 — 2026-05-20

**What was done**

T-054 was implemented in a single TDD session. The work covered all four acceptance criteria.

`requests-handler/Cargo.toml`: added `policy-control = { path = "../policy-control" }` as a direct dependency.

`requests-handler/src/handler.rs`: rewrote `run_preflight` to accept `SnapshotHandle` in place of `&PreflightConfig`. The new implementation calls `snapshot.load()` on each event to get the current `Arc<RulesetSnapshot>`, then delegates to `PolicyEngine::evaluate_admission`. The deny path (`warn!` without payload + `PreflightDenied` audit record) is preserved exactly. `PreflightConfig` was removed entirely. All six old tests were replaced with seven new tests that exercise the `SnapshotHandle`-based path (AC-1: admitted user enqueued; AC-1: multi-user list match; AC-2: non-admitted denied; AC-2: empty admission list; AC-2: absent context denied; AC-2: audit description excludes payload on denial; AC-2: audit description excludes payload on missing context). The test helper `make_snapshot` builds a `SnapshotHandle` via `policy_control::start` (the only pub constructor available to external crates).

`requests-handler/src/lib.rs`: removed `PreflightConfig` from the re-export and deleted `start_with_preflight` along with its three integration tests. The function was only used internally and the serve-level wiring (`bob/src/serve.rs`) already used `start_with` directly; removing it was the correct reconciliation.

`bob/src/serve.rs`: removed the block that built `PreflightConfig` and `admitted_user_ids` from `cfg.policy`. Replaced it with a block that reads `policy_snapshot.load().admitted_users()` to derive the same `default_context` (synthetic first-admitted-user placeholder that the existing integration test `permitted_event_is_persisted_via_wired_requests_handler_and_persistence` depends on). Cloned `policy_snapshot` into `preflight_snapshot` and passed it to `run_preflight` inside the closure. Added a new AC-4 test `deny_all_policy_snapshot_causes_all_events_to_be_denied_and_not_persisted` that sets an empty `admitted_users` list and verifies events are not persisted, proving the gate reads the snapshot rather than any static list.

**What was tried and rejected**

Considered a transitional approach of adding `run_preflight_via_snapshot` as a second function alongside the old one and migrating test by test, but that would leave two parallel implementations momentarily. A clean full rewrite was simpler and did not risk leaving dead code.

Considered using a generic `E: Into<InternalEvent>` parameter on `run_preflight` to allow callers to pass event-like types without `.into()`, but the parameter added complexity with no real caller benefit; removed during the refactor pass.

**What remains**

Nothing. All four acceptance criteria are met, all tests pass (72 total), and no new clippy errors were introduced.

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

**Stage 1 — Spec compliance**

All four acceptance criteria are met:

- AC-1: `run_preflight` now calls `PolicyEngine::evaluate_admission` and enqueues the event when `verdict.allow` is true. Two unit tests cover the admitted-user path (single user and multi-user list).
- AC-2: The deny path (missing context or denied user) drops the event, emits a `tracing::warn!` containing only the string reason (never the payload), and appends a `PreflightDenied` `AuditRecord`. Five unit tests cover this path; the audit-description tests explicitly assert the raw payload string is absent.
- AC-3: `PreflightConfig` is gone from `handler.rs` and from the crate re-exports in `lib.rs`. Admission is evaluated exclusively through `PolicyEngine::evaluate_admission`.
- AC-4: `bob/src/serve.rs` clones `policy_snapshot` into `preflight_snapshot`, passes it into the per-event closure, and forwards it to `run_preflight`. The new integration test `deny_all_policy_snapshot_causes_all_events_to_be_denied_and_not_persisted` confirms the live gate reads from the snapshot handle rather than any static list.

Removal of `start_with_preflight` and the `PreflightConfig` re-export is justified: the task description explicitly says to remove `start_with_preflight` if unused, the work log confirms `bob/src/serve.rs` was already calling `start_with` directly, and the three integration tests deleted alongside it only tested the now-gone `PreflightConfig`-based wrapper.

No files were modified outside the four declared scope files (`requests-handler/Cargo.toml`, `handler.rs`, `lib.rs`, `bob/src/serve.rs`) plus the auto-updated `Cargo.lock`.

**Stage 2 — Code quality**

- Correctness: `snapshot.load()` is called inside the per-event invocation, so every event sees the current snapshot atomically. The `verdict.as_ref().map(|v| v.allow).unwrap_or(false)` idiom correctly maps absent context to deny without needing a special branch.
- Tests: 13 unit tests in `requests-handler` (7 new handler tests + 6 pre-existing queue tests) and 60 tests in `bob` all pass. Both success and failure paths are covered. Tests are independent; `make_snapshot` creates a fresh `SnapshotHandle` per test.
- Security: warn lines carry only the string reason, never the event payload. No hardcoded credentials. No new permissions.
- Readability: naming (`preflight_snapshot`, `verdict`, `admitted`, `intruder`) is clear and follows project conventions. Functions remain focused. The dead-code comment block left over from T-053's transitional `PreflightConfig` wiring is fully removed.
- Performance: `snapshot.load()` is a lock-free `ArcSwap` read; no blocking in the hot path.

**Clippy**: `cargo clippy -p requests-handler --all-targets` is clean. `cargo clippy -p bob --all-targets` produces exactly the 4 pre-existing errors in `cli/commands/chat.rs` and `cli/commands.rs` that predate all S-004 work; no new errors were introduced by this task.
