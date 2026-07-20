---
id: T-046
title: Document connect-window pipelining vs forbidden retry-buffering in 
  extensions README
status: completed
priority: low
assigned-role: unassigned
created: '2026-05-19'
---

# Document connect-window pipelining vs forbidden retry-buffering in extensions README

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

S-003 specifies "no buffering — lost-connection windows are dropped silently". The implementation queues frames into `pendingFrames` during the *in-flight first connect*, which is technically a small in-memory buffer (single-digit-ms duration). This is defensible (it is a pre-connect window, not a retry window after a failure) but is not currently documented anywhere. Add a short section to `the-intern/extensions/README.md` explaining the connect-window pipelining and explicitly contrasting it with the spec's prohibition on retry/backoff buffering. Reference the upcoming `pendingFrames` cap (filed as B-003) so a reader understands the bound.

## Acceptance Criteria

AC-1: THE `the-intern/extensions/README.md` SHALL contain a section that explains the connect-window pipelining behaviour and explicitly contrasts it with the spec's prohibition on retry/backoff buffering.
AC-2: THE section SHALL reference B-003 (or the resulting cap) so a reader understands the bound on the pipelining.

## Dependencies

- None.

## Files to Touch

- `the-intern/extensions/README.md` — add the new section.

## Verification

Manual: open `the-intern/extensions/README.md` and confirm the section exists and reads correctly. Markdown lint (if configured) must pass.

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

### Session 1 — 2026-05-19

Added the "Connect-Window Pipelining vs Retry/Backoff Buffering" section to `the-intern/extensions/README.md`. The section has three subsections: (1) what the spec says — S-003 prohibits retry/backoff buffering and requires silent frame drops on lost-connection windows; (2) what the implementation does — `pendingFrames` is a connect-window pipeline buffer active only during the in-flight initial UDS connect, not a retry queue, with a comparison table making the distinction explicit; (3) the bound — references B-003 and the fix's `PENDING_FRAMES_CAP = 64` constant so a reader understands the queue is finite and bounded.

No alternatives were seriously considered; this is a purely additive documentation task. The section placement was chosen immediately before the Development section to keep it near the end of the operational documentation but before the developer-workflow material. No implementation files were touched. All 16 pre-existing tests pass unchanged. Committed as `docs(extensions): document connect-window pipelining vs retry buffering` on the task branch.

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

Both stages passed.

**Stage 1 — Spec compliance**
- AC-1: Met. `the-intern/extensions/README.md` contains the new section "Connect-Window Pipelining vs Retry/Backoff Buffering" with three subsections that explain the connect-window pipelining behaviour and explicitly contrast it with S-003's prohibition on retry/backoff buffering, including a comparison table.
- AC-2: Met. The "Bound on the buffer (B-003)" subsection references B-003 by name and states the `PENDING_FRAMES_CAP = 64` constant so a reader understands the queue is finite and bounded.
- Only `the-intern/extensions/README.md` was modified, matching the task's stated file scope exactly.

**Stage 2 — Code quality**
- Correctness: The description accurately captures the implementation behaviour — buffer active only during initial connect, discarded immediately on connect failure, no replay, silent drops thereafter. The comparison table maps the distinction correctly.
- Tests: No automated test command exists or is required for a documentation-only change; the task's Verification section explicitly specifies manual inspection only. The Work Log records that all 16 pre-existing tests pass unchanged.
- Security, Performance: Not applicable.
- Readability: Section is well-structured, uses consistent heading levels, and names (S-003, B-003, `PENDING_FRAMES_CAP`) follow project conventions. No dead text or debug artifacts.
