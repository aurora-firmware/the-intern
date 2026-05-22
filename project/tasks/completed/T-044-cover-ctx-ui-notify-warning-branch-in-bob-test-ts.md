---
id: T-044
title: Cover ctx.ui.notify warning branch in bob.test.ts
status: completed
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

### Session 1 — 2026-05-19

Examined `bob.ts` to identify the three warning paths where `ctx` is propagated: connect failure (socket `error` event → `markDead` → `warn`), socket.write returning false (in `flushPending` → `markDead` → `warn`), and pendingFrames cap breach (`ensureConnected` → `markDead` → `warn`). The missing-env-var path calls `warn` with no `ctx`, so `ctx.ui.notify` cannot be exercised there by design.

Added `emitWithCtx(event, data, ctx)` to the `StubPi` interface and implementation, and a `makeCtxWithUi()` factory that returns a minimal ctx stub with `ui.notify` as a `vi.fn()` spy. Five new tests were written:

- **AC-1 / connect failure**: emits with ctx-having-ui to a nonexistent socket path, waits for async error, asserts `notifySpy` called once with type `"warning"` and `stderrSpy` called zero times.
- **AC-1 / socket.write false**: establishes a real connection via empty-ctx emit, patches `net.Socket.prototype.write` to return `false` once, emits the triggering event with ctx-having-ui, asserts `notifySpy` once and zero stderr writes.
- **AC-1 / pendingFrames cap**: fires CAP+1 events synchronously via `emitWithCtx` with ctx-having-ui, waits for connect/flush to settle, asserts exactly one notify call and zero stderr writes.
- **AC-2 / connect failure**: mirrors the connect-failure scenario using plain `emit()` (empty ctx), confirms `stderrSpy` called once.
- **AC-2 / socket.write false**: mirrors the write-false scenario with plain `emit()`, confirms `stderrSpy` called once.

**What was tried and rejected.** Initial `vi.fn<[string, type?], void>()` generic syntax was rejected by the installed vitest TypeScript types; replaced with plain `vi.fn()` — no behavior change.

**What remains.** Nothing. 16/16 tests pass, `npx tsc --noEmit` is clean.

**Obstacles encountered.** One vitest typing quirk with the two-argument generic form of `vi.fn`; resolved trivially.

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

- AC-1: Met. Three new describe blocks (`connect failure`, `socket.write false`, `pendingFrames cap`) each use `makeCtxWithUi()` and `emitWithCtx()` to supply a real `ctx.ui.notify` spy. Every test asserts `notifySpy` called exactly once with second argument `"warning"` and `stderrSpy` called zero times. Verified against `bob.ts` line 66: `ctx.ui.notify(message, "warning")`.
- AC-2: Met. Two new describe blocks use plain `emit()` (passes `{} as ExtensionContext`) and assert `stderrSpy` called exactly once with output matching `/warn/i`. The empty-ctx design ensures the `else` branch runs; no `ui.notify` is available to call accidentally.
- AC-3: Met. `npx tsc --noEmit` returned clean; `npm test` reported 16/16 tests passed (1413 ms).
- File scope: only `the-intern/extensions/bob.test.ts` was modified (plus the task file on dev-agent). No unspecified files touched.

**Stage 2 — Code quality**

- Correctness: `emitWithCtx` is a minimal, correct addition to `StubPi` — it mirrors `emit()` but forwards the supplied ctx rather than `{} as ExtensionContext`. The `makeCtxWithUi()` factory is focused and typesafe (`as unknown as ExtensionContext` is the standard escape hatch for test stubs here). Assertions target the second argument of `notify` correctly matching the source call.
- Tests: Five independent tests, each in its own describe block with no shared mutable state beyond module-level `beforeEach`/`afterEach` env management already present in the file. Success paths (notify called) and negative paths (zero stderr) are both asserted for AC-1; AC-2 mirrors the inverse.
- Security: No secrets, no new permissions.
- Readability: Names (`makeCtxWithUi`, `notifySpy`, `emitWithCtx`) are descriptive and follow existing file conventions. Comments explain the intent of each test setup step.
- Performance: No unnecessary loops; the `setTimeout(r, 100/200)` delays follow the same pattern used throughout the file for async socket events.

**Minor observation (non-blocking):** The AC-2 test descriptions include the phrase "calls no ui.notify" but do not contain an explicit assertion to that effect. This is not a defect — the empty-ctx design structurally prevents any `ui.notify` call — but a `expect(someNotifySpy).not.toHaveBeenCalled()` assertion would make the guarantee explicit. The spec requires only "exactly one stderr write" and that is fully asserted.
