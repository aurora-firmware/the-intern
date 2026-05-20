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
