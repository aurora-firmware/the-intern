---
id: T-046
title: Document connect-window pipelining vs forbidden retry-buffering in 
  extensions README
status: pending
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

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->
