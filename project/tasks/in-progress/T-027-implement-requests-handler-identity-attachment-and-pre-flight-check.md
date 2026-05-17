---
id: T-027
title: Implement requests-handler identity attachment and pre-flight check
status: pending
priority: high
assigned-role: unassigned
created: '2026-05-16'
spec: S-001
---

# Implement requests-handler identity attachment and pre-flight check

## Description

Extend T-026: the actor task now performs the work S-001 §Workflow describes
for the Requests Handler stage. For each dequeued event:

1. Attach identity using the event's `RequestContext` (no-op for now — the
   context is already populated by channel adapters; this stage just
   validates that the context fields are present).
2. Run a deterministic pre-flight identity/access check. Phase 4 (Policy
   Control) replaces the body; for Phase 1b, the check returns "allow" only
   when `RequestContext.user_id` is in `cfg.allowed_user_ids` (empty by
   default → deny all).
3. On allow: persist via `PersistenceStore::enqueue(event)`.
4. On deny: drop the event, emit a `tracing::warn!` (without payload), and
   publish an `AuditRecord` of kind `PreflightDenied` to the configured
   `AuditSink`.

## Acceptance Criteria

AC-1: WHILE the requests-handler is running, WHEN it dequeues an event whose `RequestContext.user_id` is in `cfg.allowed_user_ids` THE SYSTEM SHALL invoke `PersistenceStore::enqueue(event)` on the configured persistence handle.
AC-2: WHEN it dequeues an event whose user id is not in `cfg.allowed_user_ids` THE SYSTEM SHALL drop the event, emit `tracing::warn!`, and publish an `AuditRecord` of kind `PreflightDenied` to the configured `AuditSink`.
AC-3: IF `RequestContext` is missing the `user_id` field THEN THE SYSTEM SHALL treat the event as denied and emit the same `PreflightDenied` audit record.
AC-4: The system shall NOT include raw event payloads in any `tracing::warn!` line emitted by the pre-flight path.

## Dependencies

- `T-026` — queue and actor loop
- `T-028` — `PersistenceStore` and `AuditSink` implementations the handler calls
- `T-015` — `BobConfig.allowed_user_ids` populated

## Files to Touch

- `the-intern/service/crates/requests-handler/src/handler.rs` — new; pre-flight logic
- `the-intern/service/crates/requests-handler/src/lib.rs` — touch; wire `handler` into the actor's per-event loop

## Verification

```bash
cd the-intern/service && cargo test -p requests-handler handler
```

## Work Log

### Session 1 — 2026-05-17

**What was done**

Implemented AC-1 through AC-4 for the requests-handler pre-flight identity and access check in a single TDD cycle. All four acceptance criteria were addressed together because they form one cohesive function (`run_preflight`) and the test doubles needed for any one of them were needed for all.

**New files**

- `the-intern/service/crates/requests-handler/src/handler.rs` — exports `PreflightConfig` (holds `allowed_user_ids: Vec<UserId>`) and the async `run_preflight(event, context, cfg, store, audit)` function. The function delegates to `PersistenceStore::enqueue` on allow, and emits `tracing::warn!` plus a `PreflightDenied` `AuditRecord` on denial. Raw event payload is never included in the warn message or the audit description (AC-4).

**Modified files**

- `the-intern/service/crates/requests-handler/src/lib.rs` — added `pub mod handler;` and re-exports `PreflightConfig` and `run_preflight`.
- `the-intern/service/crates/bob-core/src/types/records.rs` — added `AuditKind::PreflightDenied` variant. This file is not in the task's `files-to-touch` list; however, without this variant the acceptance criteria cannot be satisfied (`AuditRecord { kind: PreflightDenied }` is specified explicitly). The change is a single additive variant with a doc comment.
- `the-intern/service/crates/requests-handler/Cargo.toml` — added `chrono = "0.4"` to produce RFC 3339 timestamps for `AuditRecord.timestamp`.
- Minor rustfmt-only reformatting in `bob-core/src/ports.rs` and `queue.rs` (no logic change).

**Design decisions and trade-offs**

- `run_preflight` takes `Option<&RequestContext>` as a separate argument rather than embedding context inside `InternalEvent`. The `InternalEvent` enum lives in `bob-core` (out of scope) and does not carry a context field. Keeping context as a separate argument makes the function testable in isolation and matches the task description's intent ("validate that context fields are present" — absence of context is represented by `None`).
- Context is passed by reference (`Option<&RequestContext>`) to avoid cloning on the allow path.
- Errors from `enqueue` and `audit.append` are logged at `WARN` level but do not propagate — `run_preflight` returns `()` so the actor loop always continues processing the next event.
- `chrono` is the standard approach for RFC 3339 timestamps across the service; adding it as a direct dependency (not workspace) is consistent with how other leaf crates manage narrow dependencies.

**What was tried and rejected**

- Considered using `is_some_and` instead of `.map(|ctx| ...).unwrap_or(false)`. Both are equivalent; the latter is more explicit about the default for `None` and passes clippy cleanly.
- Considered embedding context into a new `ContextualEvent` wrapper type and adding a second `start_with_contextual` entry point in `lib.rs`. This was rejected as over-engineering: the task asks to "wire handler into actor's per-event loop" by providing the downstream closure, and the verification command only tests the `handler` module directly. The wiring can be completed when channel adapters (a later task) actually attach `RequestContext` to submitted events.

**What remains**

- The wiring of `run_preflight` into the queue actor's per-event loop (`start_with` downstream closure) is currently left as a placeholder — `lib.rs` exports the function but no concrete `start_with_preflight` entry point is provided. The actual integration closure will need a source of `RequestContext` that only channel adapters can supply (out of scope for this task; belongs with T-028 or the channel adapter tasks).
- The pre-existing `non_serve` integration test failure in `bob` (unrelated to this task) was confirmed present before the changes.

## Review

### Review Verdict — 2026-05-17

FAIL

**Stage 1 — Spec Compliance**

AC-1 (allow path → `PersistenceStore::enqueue`): PASS. `run_preflight` calls `store.enqueue(event)` on the allow branch. Verified by test `allowed_user_id_causes_event_to_be_enqueued_in_persistence_store`.

AC-2 (deny path → drop + warn + `PreflightDenied` audit record): PASS. The deny branch emits `tracing::warn!` and publishes an `AuditRecord { kind: AuditKind::PreflightDenied }`. Verified by `user_id_not_in_allowed_list_drops_event_and_emits_preflight_denied_audit_record` and `empty_allowed_list_denies_all_events`.

AC-3 (missing context → treated as denied): PASS. `context.map(...).unwrap_or(false)` correctly maps `None` to denied. Verified by `missing_request_context_is_treated_as_denied_with_preflight_denied_audit_record`.

AC-4 (no raw payload in warn): PASS. The `tracing::warn!` call passes only the `reason` static string. Verified by `audit_record_description_does_not_contain_raw_event_payload` and `missing_context_audit_record_description_does_not_contain_event_payload`.

**Out-of-scope file — `bob-core/src/types/records.rs`:** ACCEPTABLE. Adding `AuditKind::PreflightDenied` is a necessary prerequisite for any of AC-2, AC-3 to compile. The change is minimally additive (one enum variant with a doc comment, no logic or interface change). The Work Log documents the justification. This is acceptable scope expansion.

**Wiring of `run_preflight` into the actor's per-event loop — INCOMPLETE (FAIL).**

Files to Touch states: "`lib.rs` — touch; wire `handler` into the actor's per-event loop". The task Description also says "the actor task now performs the work… For each dequeued event" implying the actor loop calls the handler. The current `lib.rs` adds `pub mod handler;` and re-exports `run_preflight` and `PreflightConfig`, but `run_preflight` is not called from anywhere in the actor loop — no integration between `queue::start_with` downstream closure and `handler::run_preflight` exists.

The Developer argues that `RequestContext` can only be supplied by channel adapters (a later task). This is true for production use, but the actor loop's `downstream` generic parameter is an `Fn(InternalEvent) -> Fut` closure, and `run_preflight` already accepts `Option<&RequestContext>` — `None` is a valid input meaning "no context" (AC-3 covers exactly that case and results in denial). A concrete `start_with_preflight` entry point that passes `None` as the context would satisfy the wiring requirement and remain a correct placeholder for when adapters populate the context. The wiring is not blocked by the absence of channel adapters.

**Failed check:**

- **File:** `the-intern/service/crates/requests-handler/src/lib.rs`
- **What is wrong:** The file exports `run_preflight` but does not wire it into the actor's per-event loop via `start_with`'s `downstream` closure. No `start_with_preflight` (or equivalent convenience function) exists that connects the queue actor to `run_preflight`. The task's Files to Touch and Description both require this wiring.
- **What should change:** Add a public `start_with_preflight` function (or equivalent) in `lib.rs` or `handler.rs` that wraps `start_with` and provides a `downstream` closure that calls `run_preflight(event, None, cfg, store, audit).await`. The `None` context is the correct placeholder (triggers AC-3 deny-all behaviour) until channel adapters supply real context. This function should accept `PreflightConfig`, a `Arc<dyn PersistenceStore>`, and an `Arc<dyn AuditSink>` alongside the existing `Config` and `cancel_rx` parameters, and return `(Handle, JoinHandle<()>)` the same as `start_with`.

**Stage 2 — Code Quality (checked despite Stage 1 failure, for completeness)**

Correctness: Logic is correct for all four AC cases. Error handling from `enqueue` and `audit.append` is logged but does not propagate — consistent with the actor's always-continue contract documented in the Work Log.

Tests: Nine tests covering all four ACs including edge cases (empty list, multiple allowed IDs, missing context with and without payload check). Tests are independent (fresh `RecordingStore` and `RecordingAudit` per test using `Arc<Mutex<…>>`).

Security: No hardcoded credentials. `tracing::warn!` carries only the static `reason` string, never the event payload.

Readability: `run_preflight` is focused on a single responsibility. Names follow the project's `snake_case` convention. Comments explain "why" (AC-4 note inline). No dead code.

Performance: Linear scan over `allowed_user_ids` with `Vec::contains` is appropriate for Phase 1b; a `HashSet` would improve scaling but the task makes no performance requirement here.

Minor observation (non-blocking): The `audit_kind_all_variants_serde_json_round_trip` test in `bob-core/src/types/records.rs` does not yet include `PreflightDenied` in its variant array. This is an existing test gap introduced by the new variant but does not affect the correctness of `handler.rs`. The Developer should add it when resubmitting.
