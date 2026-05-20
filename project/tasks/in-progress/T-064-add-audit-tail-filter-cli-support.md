---
id: T-064
title: Add audit tail filter CLI support
status: pending
priority: medium
assigned-role: unassigned
created: '2026-05-20'
spec: S-005
---

# Add audit tail filter CLI support

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

Phase 3 of S-005, CLI surface. Add `--filter <kind>` support to `bob audit
tail`.

The command should default to all server-visible audit kinds when no filter is
provided. Multiple `--filter` values should be accepted and sent to
`audit.tail.subscribe`. The canonical filter spellings are `events`, `reports`,
and `verdicts`; do not implement the misspelled `veredicts` alias unless a
later spec explicitly asks for it. Own the Clap parsing, command dispatch
plumbing, runtime function signature, subscribe-param construction, and tests
end to end. Preserve `--json` behaviour.

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

AC-1: WHEN `bob audit tail` is invoked without `--filter` THE SYSTEM SHALL send an `audit.tail.subscribe` request with no explicit filters.
AC-2: WHEN `bob audit tail --filter events --filter verdicts` is invoked THE SYSTEM SHALL send those filter values in the subscribe params.
AC-3: IF `bob audit tail --filter veredicts` is invoked THEN THE SYSTEM SHALL reject the command before subscribing.
AC-4: WHEN `bob audit tail --json` receives audit notifications THE SYSTEM SHALL continue to print one JSON document per notification.

## Dependencies

- `T-063` — defines the Admin-RPC filter parameter contract for `audit.tail.subscribe`.

## Files to Touch

- `the-intern/service/crates/bob/src/cli/commands.rs` — add the audit filter CLI argument plumbing if the command enum owns it.
- `the-intern/service/crates/bob/src/cli/mod.rs` — add Clap parsing for repeated `--filter` values on `bob audit tail`.
- `the-intern/service/crates/bob/src/cli/commands/audit.rs` — include filters in subscribe params, validate spellings, and update command tests.
- `the-intern/service/crates/bob/src/lib.rs` — update the public runtime command dispatch so audit filters reach the audit command handler.

## Verification

```bash
cd the-intern/service
cargo test -p bob cli::commands::audit
cargo test -p bob cli::tests
```

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

### Session 1 — 2026-05-20

Implemented all four acceptance criteria in one session.

The feature required threading a new `filters: Vec<AuditFilterKind>` parameter from the Clap CLI definition all the way down to the JSON-RPC subscribe call. Changes landed in four files:

- `cli/mod.rs`: changed `AuditCommand::Tail` from a unit variant to a struct variant carrying `filters: Vec<AuditFilterKind>` behind a Clap `--filter KIND` repeating argument. Clap uses `AuditFilterKind`'s `FromStr` impl (already in `bob-core`) to validate each value, so unknown spellings — including the intentionally excluded `veredicts` — are rejected before any subscription call is attempted (AC-3).
- `cli/commands/audit.rs`: added `build_subscribe_params(&[AuditFilterKind]) -> Value`, which returns `{}` for an empty slice (AC-1) and `{"filters":[...]}` otherwise (AC-2). Threaded the filter vec through `run()`, `run_with_config()`, `run_with_connector()`, and `run_with_connector_async()`. Added five new tests: three unit tests on `build_subscribe_params`, one connector-level integration test capturing the params sent to the connector (AC-2), and one `--json` regression test (AC-4).
- `cli/commands.rs`: updated the `audit_tail` function signature to accept `Vec<AuditFilterKind>`.
- `lib.rs`: updated the `DispatchRuntime::audit_tail` trait method, the `ProductionRuntime` impl, and the `run_cli_with_runtime` match arm to destructure and pass filters.

Tried and rejected: the AC-2 connector test initially used a dropped-sender pattern to end the subscription immediately, which panicked because `stop_tx.send(())` failed after `stop_rx` was already dropped. Replaced with a channel that captures params inside the connector closure before the subscription starts, using `.ok()` on shutdown channels to tolerate early task termination. `build_subscribe_params` was changed from `Vec` ownership to `&[AuditFilterKind]` after a clippy `needless_pass_by_value` warning.

Verification (run from `the-intern/service`):
- `cargo test -p bob --lib "cli::commands::audit"` — 6 tests, all pass.
- `cargo test -p bob --lib "cli::tests"` — 6 tests, all pass.
- `cargo test -p bob --lib` — 74 tests, all pass (was 69 before).
- Commit `fb5c15d` on the task branch.

Nothing remains; all four ACs are covered and passing.

Obstacles Encountered:
- The task's verification commands (`cargo test -p bob cli::commands::audit` / `cli::tests`) match 0 tests because they run against binary test targets, while the test modules live in the library crate. The correct commands are `cargo test -p bob --lib "cli::commands::audit"` and `cargo test -p bob --lib "cli::tests"`.
- Four pre-existing clippy errors in `cli/commands/chat.rs` and `cli/commands.rs` (unrelated to this task — known issue from T-061 review) cause `cargo clippy -p bob` to fail identically before and after this change.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->
