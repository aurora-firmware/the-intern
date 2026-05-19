---
id: T-045
title: Cover unknown-session-after-default-route-close path in extension-ipc 
  multiplex tests
status: completed
priority: low
assigned-role: unassigned
created: '2026-05-19'
---

# Cover unknown-session-after-default-route-close path in extension-ipc multiplex tests

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

`SessionMultiplexer::route_for_session` (`the-intern/service/crates/extension-ipc/src/multiplex.rs:116-121`) inserts the live `default_route` into `session_routes` the first time it sees an unknown `SessionId`. There is no test asserting behaviour when the default route is later swapped or closed. Add a unit test that exercises this path. The production fix lives in B-004 (multiplex caches default route); this task is the regression test that locks the fix in. If B-004 is not yet resolved when this task is picked up, mark the test `#[ignore]` against the desired behaviour and remove `#[ignore]` once B-004 lands.

## Acceptance Criteria

AC-1: WHEN the unit test runs against the fixed multiplex THE SYSTEM SHALL deliver inbound frames for an unknown session to the *current* default route, not a stale captured one.
AC-2: WHEN `cargo test -p extension-ipc` runs THE SYSTEM SHALL pass.

## Dependencies

- None — informational link to B-004 (multiplex caches default route bug).

## Files to Touch

- `the-intern/service/crates/extension-ipc/src/multiplex.rs` — add the regression test to the `#[cfg(test)]` module.

## Verification

```bash
cd the-intern/service
cargo test -p extension-ipc
```

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

### Session 1 — 2026-05-19

Superseded by the B-004 bug fix. The regression test the task asks for — `route_for_session_reflects_new_default_for_unknown_session_after_default_replaced` — was added on `bug/B-004-multiplex-unknown-session-cache` (commit `00be9f3`, merged to `dev-agent` as `c804294`) and now lives at `crates/extension-ipc/src/multiplex.rs:358`. AC-1 and AC-2 are satisfied by the merged change. Closing without further work.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->
