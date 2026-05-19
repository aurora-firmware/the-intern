---
id: T-048
title: Document inbound-write back-pressure coupling in extension-ipc 
  run_connection
status: completed
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

### Session 1 — 2026-05-19

Added a 17-line comment block immediately before the `async fn run_connection` signature in `extension-ipc/src/lib.rs`. The comment has two named sections:

**Back-pressure coupling** — explains that `out_rx.try_recv()` drains outbound frames inside the inbound frame loop and that `write_all_nonblocking` awaits the socket writable event before retrying a short write. Makes explicit that a slow peer's stall propagates backward into the inbound read loop, which is intentional so the bob service cannot consume frames faster than the peer can accept replies.

**Single-connection assumption** — explains that the coupling is safe only when one connection is active per actor, and names what would need to change (decouple the write path from the read loop) if the design ever moves to multiple concurrent connections.

No logic was changed. Build verified clean before and after (recompiled only `extension-ipc` and `bob`, no errors or warnings).

**What remains.** Nothing.

**Obstacles encountered.** None.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->

### Review Verdict — 2026-05-19
PASS

**Stage 1 — Spec compliance**

- AC-1: Met. A 17-line comment block is present immediately before `async fn run_connection` in `the-intern/service/crates/extension-ipc/src/lib.rs`. It explicitly names the back-pressure coupling (the `out_rx.try_recv()` drain inside the inbound loop, the `write_all_nonblocking` await, and the intentional stall propagation) and the single-connection assumption (coupling is safe only with one connection per actor; multi-connection designs would need the write path decoupled). Both required elements are present.
- AC-2: Met. `cargo build --workspace` completed with no errors or warnings (`Finished dev profile` on the implementation branch). Only `extension-ipc` and `bob` recompiled, confirming no behavioural change.
- Scope: Only two files changed — the target source file and the task's own work-log entry. No unspecified files touched.

**Stage 2 — Code quality**

- Correctness: Documentation-only change; no logic altered.
- Tests: No test change is required or expected for a comment-only addition.
- Security: No credentials, secrets, or input handling introduced.
- Readability: Comment is clear, well-structured with named sections, and explains the *why* rather than the *what*. Follows existing code style.
- Performance: No code path altered.
