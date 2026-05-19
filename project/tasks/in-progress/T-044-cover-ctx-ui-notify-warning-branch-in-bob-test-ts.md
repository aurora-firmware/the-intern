---
id: T-044
title: Cover ctx.ui.notify warning branch in bob.test.ts
status: pending
priority: low
assigned-role: unassigned
created: '2026-05-19'
---

# Cover ctx.ui.notify warning branch in bob.test.ts

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

`the-intern/extensions/bob.ts` has a `warn(ctx, message)` helper that prefers `ctx.ui.notify()` and falls back to `process.stderr.write` when `ctx.ui` is absent. Every existing test in `bob.test.ts` passes `{} as ExtensionContext`, so the `ctx.ui.notify` branch is never exercised. Add tests that stub `ctx.ui.notify`, trigger each warning path (missing env var, connect failure, write failure), and assert exactly one `notify` call (and zero stderr writes) per path.

## Acceptance Criteria

AC-1: WHEN a warning path fires with `ctx.ui` present THE TEST SUITE SHALL assert exactly one `ctx.ui.notify` call and zero stderr writes.
AC-2: WHEN a warning path fires with `ctx.ui` absent THE TEST SUITE SHALL continue to assert exactly one stderr write (existing behaviour).
AC-3: WHEN `npx tsc --noEmit && npm test` runs in `the-intern/extensions/` THE SYSTEM SHALL pass.

## Dependencies

- None.

## Files to Touch

- `the-intern/extensions/bob.test.ts` — add the new `ctx.ui` branch tests.

## Verification

```bash
cd the-intern/extensions
npx tsc --noEmit
npm test
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
