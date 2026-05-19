---
id: T-048
title: Document inbound-write back-pressure coupling in extension-ipc 
  run_connection
status: pending
priority: low
assigned-role: unassigned
created: '2026-05-19'
---

# Document inbound-write back-pressure coupling in extension-ipc run_connection

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

`the-intern/service/crates/extension-ipc/src/lib.rs:103-168` `run_connection` couples write back-pressure to inbound reads: `out_rx.try_recv()` runs inside the inbound frame loop, and `write_all_nonblocking` can `await` mid-loop. This is correct for the current single-connection actor model — a blocked write deliberately stalls inbound processing so the bob service can not run away from the peer — but it is undocumented and easy to break in a refactor. Add a short comment block at the top of `run_connection` describing the back-pressure invariant and why it is acceptable for the current shape.

## Acceptance Criteria

AC-1: THE function `run_connection` in `the-intern/service/crates/extension-ipc/src/lib.rs` SHALL carry a comment that names the back-pressure coupling and the single-connection assumption it depends on.
AC-2: WHEN `cargo build --workspace` runs THE SYSTEM SHALL pass (no behavioural change).

## Dependencies

- None.

## Files to Touch

- `the-intern/service/crates/extension-ipc/src/lib.rs` — add the documenting comment block.

## Verification

```bash
cd the-intern/service
cargo build --workspace
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
