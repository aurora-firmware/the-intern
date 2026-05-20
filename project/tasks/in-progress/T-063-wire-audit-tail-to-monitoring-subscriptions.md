---
id: T-063
title: Wire audit.tail to Monitoring subscriptions
status: pending
priority: high
assigned-role: unassigned
created: '2026-05-20'
spec: S-005
---

# Wire audit.tail to Monitoring subscriptions

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

Phase 3 of S-005, tail half. Replace the existing local admin-rpc audit
subscription bus with Monitoring-backed `audit.tail` subscriptions.

`audit.tail.subscribe` must parse optional filters and call Monitoring's tail
subscription API. Matching future audit records stream as JSON-RPC
notifications; no historical point query or replay is added. Keep
`audit.tail.unsubscribe` semantics and slow-subscriber cleanup consistent with
the existing connection model.

## Acceptance Criteria

<!-- EARS pattern reference. Every criterion must match one pattern:
  1. Ubiquitous            — The system shall [outcome]
  2. Event-driven          — WHEN [trigger] THE SYSTEM SHALL [outcome]
  3. Unwanted-behaviour    — IF [fault] THEN THE SYSTEM SHALL [outcome]
  4. State-driven          — WHILE [state] THE SYSTEM SHALL [outcome]
  5. Optional              — WHERE [feature included] THE SYSTEM SHALL [outcome]

Examples:
  AC-1: WHEN the user submits valid credentials THE SYSTEM SHALL
        redirect to /dashboard within 200ms.
  AC-2: IF the password is incorrect THEN THE SYSTEM SHALL return 401
        and display "Invalid credentials".
  AC-3: The system shall log every authentication attempt with user id
        and outcome.
-->

AC-1: WHEN `audit.tail.subscribe` is dispatched with no filters THE SYSTEM SHALL subscribe to all Monitoring default-visible audit kinds.
AC-2: WHEN `audit.tail.subscribe` is dispatched with valid filters THE SYSTEM SHALL subscribe only to those audit kinds.
AC-3: IF `audit.tail.subscribe` receives an unknown filter THEN THE SYSTEM SHALL return a JSON-RPC invalid-request error and create no subscription.
AC-4: WHEN a subscribed Monitoring tail receives a matching future record THE SYSTEM SHALL emit one `audit.tail` JSON-RPC notification containing that record.
AC-5: WHEN `audit.tail.unsubscribe` is dispatched for an active subscription THE SYSTEM SHALL remove that Monitoring subscription and return success.

## Dependencies

- `T-062` — adds the Monitoring handle to admin-rpc and touches the same dispatcher/config files.

## Files to Touch

- `the-intern/service/crates/admin-rpc/src/dispatch.rs` — parse filters, subscribe/unsubscribe through Monitoring, and update audit method tests.
- `the-intern/service/crates/admin-rpc/src/lib.rs` — replace the local audit bus forwarding path with Monitoring-backed receivers.
- `the-intern/service/crates/admin-rpc/src/subscriptions.rs` — remove or adapt local audit bus types so connection cleanup tracks Monitoring subscriptions.
- `the-intern/service/crates/admin-rpc/src/protocol.rs` — update protocol-adjacent tests only if the notification payload shape needs explicit coverage.

## Verification

```bash
cd the-intern/service
cargo test -p admin-rpc audit_tail
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

All five acceptance criteria were implemented in a single TDD cycle, covering AC-1 through AC-5.

The core change replaces the local in-memory `SubscriptionBus` fan-out path for audit subscriptions with a direct call to `monitoring::Handle::subscribe_tail`. Key design decisions:

- Filter parsing (`parse_audit_filters` helper in `dispatch.rs`): reads an optional `params.filters` JSON array, maps each string through `AuditFilterKind::from_str`, and returns an `Err(unknown)` string on any unrecognised value. Empty or absent filters produce an empty `Vec`, which monitoring interprets as "subscribe to all kinds" (AC-1).
- `DispatchOutcome::Subscribed` shape changed: the `rx` field is now `mpsc::UnboundedReceiver<bob_core::types::AuditRecord>` from monitoring, plus a new `cancel_rx: oneshot::Receiver<()>` field carrying the per-subscription cancellation signal.
- `ConnectionRegistry` redesign (`subscriptions.rs`): removed `subscribe_audit` (local bus path). Added `register_audit_subscription` which allocates a local monotonic `AdminSubscriptionId` and creates a `oneshot` cancel pair. The cancel sender is stored in a `HashMap`; dropping it signals the forwarder task. `unsubscribe` drops the sender for the target id. `Drop` drains audit ids and drops their cancel senders; chat subscriptions still call `bus.remove` as before.
- `audit_forwarder` in `lib.rs`: replaced the bounded `mpsc::Receiver<AuditRecord>` with `mpsc::UnboundedReceiver<bob_core::types::AuditRecord>` plus `cancel_rx`, using `tokio::select!` to interleave cancellation and record delivery so explicit unsubscribes and connection drops exit cleanly. Notification method changed from `audit.event` to `audit.tail` (AC-4). The `NotifMsg::Dropped` sentinel and its write-loop handler were removed (monitoring channels are unbounded).
- When the monitoring handle is absent, `audit.tail.subscribe` returns `CODE_METHOD_NOT_FOUND`, consistent with `report.submit`.

Tried and rejected: keeping a shared `Arc<Mutex<...>>` map of monitoring receivers in the registry so the dispatcher could drop them on unsubscribe — rejected in favour of the cancellation-oneshot pattern, which is idiomatic Tokio and avoids holding receivers in the registry.

Verification (run from `the-intern/service`):
- `cargo test -p admin-rpc audit_tail` — 14 tests, all pass.
- `cargo clippy -p admin-rpc --all-targets` — clean, zero warnings.
- `cargo test -p admin-rpc` — 95 tests, all pass.

`protocol.rs` was not modified — the `audit.tail` notification payload shape is fully covered by `dispatch.rs`/`lib.rs` tests, so the conditional protocol test addition was unnecessary.

Nothing remains; all five ACs are covered by passing tests.

Obstacles Encountered:
- The existing `lib.rs` integration tests injected audit records via `bus_clone.publish(AuditRecord { payload })`; since the local bus is no longer the audit fan-out path, these were rewritten to use `monitoring.append_record()` and to check for `audit.tail` notifications. A `make_dispatcher_with_monitoring` test helper was added.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->

### Review Verdict — 2026-05-20

FAIL

**Stage 1 — Spec compliance: PASS**

All five acceptance criteria are met:
- AC-1: `parse_audit_filters` returns an empty `Vec` when no filters are present; an empty Vec is passed to `monitoring.subscribe_tail`, which the monitoring actor interprets as "all kinds". Confirmed by `audit_tail_subscribe_with_no_filters_returns_monitoring_backed_subscription`.
- AC-2: Valid filter strings are parsed through `AuditFilterKind::from_str` and forwarded to `monitoring.subscribe_tail`. Confirmed by `audit_tail_subscribe_with_valid_filters_returns_monitoring_backed_subscription`. Filtering correctness is owned by the monitoring crate (covered by its own tests).
- AC-3: Unknown filter strings return `CODE_INVALID_REQUEST` and no subscription is registered. Confirmed by two dedicated tests.
- AC-4: A monitoring `append_record` call delivers an `audit.tail` notification with `method: "audit.tail"` to the subscriber. Confirmed by `run_connection_audit_tail_subscribe_delivers_audit_tail_notification`.
- AC-5: `audit.tail.unsubscribe` drops the cancellation sender, the forwarder exits, and subsequent records are not delivered. Connection-close drops the `ConnectionRegistry` which drops all cancellation senders. Confirmed by `run_connection_audit_tail_unsubscribe_stops_notifications` and `run_connection_close_cancels_all_audit_subscriptions`.

Scope: only `dispatch.rs`, `lib.rs`, and `subscriptions.rs` were modified. `protocol.rs` was not touched, consistent with the work log.

**Stage 2 — Code quality: FAIL**

**Readability — stale module-level comment block**

- **File and location:** `the-intern/service/crates/admin-rpc/src/lib.rs`, lines 132–150 (the "Connection concurrency model" block comment).
- **What is wrong:** The comment describes the old bounded-mpsc + `AddAuditRx`/`RemoveAuditRx` control-message + `NotifMsg::Dropped` sentinel architecture that this task explicitly removed. It says the forwarder reads from "the bounded `mpsc::Receiver<AuditRecord>`" and that "when the sender is dropped by the bus (AC-4 slow-subscriber), the forwarder detects it and sends a sentinel that causes the write task to close the connection." None of this is true anymore. The comment contradicts the actual code and will mislead future readers about how cancellation and back-pressure work.
- **What should change:** Update the block comment to describe the current architecture: the forwarder receives from an unbounded `mpsc::UnboundedReceiver<AuditRecord>` (from monitoring), uses `tokio::select!` against a `oneshot` cancel receiver, and exits cleanly on cancellation or when the monitoring actor closes the channel. Remove the stale references to `AddAuditRx`, `RemoveAuditRx`, and the sentinel-driven connection-close path.

**Readability — stale doc comment on local `AuditRecord`**

- **File and location:** `the-intern/service/crates/admin-rpc/src/subscriptions.rs`, line 56.
- **What is wrong:** The doc comment reads "A record published by the monitoring actor and forwarded to audit subscribers." This struct is no longer used for audit subscriptions; it is only used internally by `SubscriptionBus` for the Phase 2 chat subscription fan-out bus.
- **What should change:** Update the doc comment to accurately describe the current role: "A record published on the local fan-out bus, used by chat subscriptions." (or similar wording that does not imply audit usage).
