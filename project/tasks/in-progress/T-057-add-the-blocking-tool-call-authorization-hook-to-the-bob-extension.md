---
id: T-057
title: Add the blocking tool_call authorization hook to the bob extension
status: pending
priority: medium
assigned-role: unassigned
created: '2026-05-20'
spec: S-004
---

# Add the blocking tool_call authorization hook to the bob extension

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

Phase 5 of S-004. Add pi-agent's blocking `tool_call` hook to the bob
extension so every tool call is gated by Policy Control before it runs.
Today `bob.ts` only forwards events one-way.

**Before implementing**, verify against the installed
`@earendil-works/pi-coding-agent` types that the `tool_call` hook can
return/await an *asynchronous* allow/block verdict (this is the standing
S-004 open question). If it cannot, stop and escalate rather than work
around it.

Implement in `bob.ts`:

- Register the blocking `tool_call` hook. On each call, send an `Authz`
  frame `{kind:"authz", session, tool, arguments}` on the same
  `extension.sock` connection, then await the matching `AuthzVerdict`
  frame `{kind:"authz_verdict", session, verdict}`.
- Read inbound NDJSON lines from the socket to receive verdicts; correlate
  by `session`.
- Apply a bounded timeout: read `BOB_AUTHZ_TIMEOUT_MS` if set, otherwise a
  built-in default.
- **Fail closed**: on transport failure, an unparseable verdict, or
  timeout, return *block* to pi and log one warning.
- An `allow` verdict lets the call proceed; a `block` verdict denies it;
  the session continues either way.

Document `BOB_AUTHZ_TIMEOUT_MS` in `env.d.ts` and `README.md`. Cover the
hook in `bob.test.ts`: allow, block, and timeout-fails-closed over a real
UDS.

## Acceptance Criteria

AC-1: WHEN pi-agent invokes a tool THE SYSTEM SHALL send an `Authz` frame carrying the session, tool, and arguments and block the call until a verdict resolves.
AC-2: WHEN a matching `AuthzVerdict` with `allow: true` is received within the timeout THE SYSTEM SHALL permit the tool call to proceed.
AC-3: IF the verdict is `allow: false`, the verdict cannot be received or parsed, or no verdict arrives within the bounded timeout THEN THE SYSTEM SHALL block the tool call and log one warning.
AC-4: WHERE `BOB_AUTHZ_TIMEOUT_MS` is set THE SYSTEM SHALL use it as the verdict timeout; otherwise THE SYSTEM SHALL apply a built-in default.

## Dependencies

- `T-056` — the bob service must answer `Authz` frames with real verdicts for the hook to integrate against.

## Files to Touch

- `the-intern/extensions/bob.ts` — the blocking hook, verdict read/correlate, bounded timeout, fail-closed behaviour.
- `the-intern/extensions/bob.test.ts` — allow / block / timeout-fails-closed tests over a real UDS.
- `the-intern/extensions/env.d.ts` — declare `BOB_AUTHZ_TIMEOUT_MS`.
- `the-intern/extensions/README.md` — document the hook and the timeout env var.

## Verification

```bash
cd the-intern/extensions
npx vitest run
```

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

### Session 1 — 2026-05-20

Picked up T-057 fresh — Work Log was empty. Read the task file, all four source files, and the `@earendil-works/pi-coding-agent` type definitions.

**Key pre-implementation finding:** The standing S-004 open question — "can the `tool_call` hook return/await an asynchronous allow/block verdict?" — is confirmed YES. The installed types define `ExtensionHandler<E, R>` as returning `Promise<R | void> | R | void`, and the `tool_call` overload uses `ToolCallEventResult` which has `block?: boolean`. No escalation needed.

**What was done:** One TDD cycle covering all four ACs.

- Wrote 8 failing tests first (red phase): `createAuthzServer` helper (bidirectional UDS with `sendVerdict` and `sendRaw`), AC-1 through AC-4. Confirmed 6 tests fail — 2 accidentally passed because existing code returns `undefined`, which is falsy.
- Implemented the hook: removed `tool_call` from the fire-and-forget `PI_EVENTS` list; added `attachVerdictReader` (NDJSON reader on socket `data`/`close` events); added `pendingVerdicts` FIFO queue; added `handleToolCall` async function that sends an `Authz` frame, races `verdictPromise` vs a `setTimeout`, and returns `{block: true}` on any failure path.
- Fixed one TypeScript error: the overloaded `on()` signature for `"tool_call"` can't be satisfied via generic `Parameters<>` — used a simple object cast instead (same pattern as the existing event loop).
- Refactored: removed an unused `timedOut` variable.
- Updated `env.d.ts` (added `BOB_AUTHZ_TIMEOUT_MS`) and `README.md` (new "Policy-Control" section and env var entry).
- All 24 tests pass; `tsc --noEmit` clean.

**What was tried and rejected:** Initially considered keeping `tool_call` in the fire-and-forget list for observation and adding the blocking hook on top, but the AC-1 test expects the frame to be `kind:"authz"` not `kind:"event"`, so `tool_call` must be handled exclusively by the blocking hook.

**What remains:** Nothing. All four ACs are implemented and tested. Ready for reviewer.

### Session 2 — 2026-05-20

Picked up the canonical Session 1 and reviewer FAIL verdict, then reproduced the reported issue with a new regression test that drives a `tool_call` against an unbound UDS path. The new test failed first (red) with two warnings for one failed call, confirming the connect-time duplicate-warning defect.

Implemented a minimal fix in `bob.ts`: introduced a `VerdictOutcome` state that includes `transport_error_logged`, added `resolvePendingVerdicts(...)`, and updated `markDead(...)` to resolve all in-flight authz waiters immediately with that outcome before logging the transport warning. In `handleToolCall`, this new outcome now returns `{ block: true }` fail-closed without emitting a second warning. This preserves fail-closed behavior and removes the duplicate-warning path.

Tried and rejected suppressing timeout warnings conditionally in `handleToolCall` alone, because it still leaves pending verdicts unresolved after transport death and risks delayed behavior; immediate settlement from `markDead` is deterministic and simpler.

Ran targeted and full verification after the change; all tests pass and typecheck is clean. Nothing remains on the implementation branch for this review cycle.

Evidence:
- `npx vitest run bob.test.ts -t "connect-time failure without verdict"` (before fix): failed with `expected spy to be called 1 times, but got 2 times`.
- `npx vitest run bob.test.ts -t "connect-time failure without verdict"` (after fix): passed.
- `npx vitest run` (initial sandbox run): failed with UDS `listen EPERM` (environment/sandbox issue).
- `npx vitest run` (rerun with escalation): passed (`25 passed`).
- `npx tsc --noEmit`: passed.
- `git log -1 --oneline`: `731a5ac fix(extensions): avoid duplicate authz warning on transport fail`.

Obstacles Encountered:
- Full socket-based suite hit sandbox UDS bind `EPERM`; resolved by rerunning verification with escalated permissions.

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

Result: FAIL

Summary:
- Reviewed `task/T-057-add-the-blocking-tool-call-authorization-hook-to-the-bob-extension` against AC-1..AC-4 and Stage 2 quality checks.
- Stage 1 failed on AC-3 fail-closed warning semantics for one transport-failure path.
- Failed check:
  - File and location: `the-intern/extensions/bob.ts` (`markDead` at line 179 and `handleToolCall` timeout path at lines 330-335).
  - What is wrong: on connect-time transport failure (`sock.on("error")` -> `markDead`), the same `tool_call` can emit two warnings: one from `markDead(...)` and a second when the unresolved verdict later times out in `handleToolCall`.
  - What should change: ensure a transport failure resolves the pending verdict for that call immediately to the hook's fail-closed path (single warning), or otherwise suppress the timeout warning for calls already failed by transport error. The AC requires one warning on this failure mode.

Artifacts:
- Updated canonical task file: `project/tasks/in-progress/T-057-add-the-blocking-tool-call-authorization-hook-to-the-bob-extension.md` (this verdict entry).
- Diff reviewed: `the-intern/extensions/bob.ts`, `the-intern/extensions/bob.test.ts`, `the-intern/extensions/env.d.ts`, `the-intern/extensions/README.md`.

Evidence:
- Inspected task requirements and acceptance criteria from the canonical file on `dev-agent`.
- Ran `git diff --name-status dev-agent..task/T-057-add-the-blocking-tool-call-authorization-hook-to-the-bob-extension`.
- Reviewed implementation/test diffs for all expected changed files.
- Verified developer-reported checks on the task branch: `cd the-intern/extensions && npx vitest run && npx tsc --noEmit` (24 tests passed; typecheck clean).
- Confirmed hook return contract from installed types: `ToolCallEventResult { block?: boolean; reason?: string; }`.

Obstacles Encountered:
- Initial sandbox restriction when switching branches (`.git/index.lock: Read-only file system`); resolved by rerunning checkout/test commands with escalated permissions.

Next Owner:
- Developer

Next Action:
- Update transport-failure handling so one failed `tool_call` emits exactly one warning while still failing closed, add regression coverage for connect-time failure without verdict, and resubmit for review.

### Review Verdict — 2026-05-20
PASS

Result: PASS

Summary:
- Reviewed cycle-2 changes for `task/T-057-add-the-blocking-tool-call-authorization-hook-to-the-bob-extension`, including commit `731a5ac`.
- Stage 1 passed: AC-1..AC-4 are satisfied, including the previously failing connect-time transport path now emitting a single warning for one failed `tool_call`.
- Stage 2 passed: correctness, regression coverage, readability, security, and performance are acceptable for scope.

Artifacts:
- Updated canonical task file: `project/tasks/in-progress/T-057-add-the-blocking-tool-call-authorization-hook-to-the-bob-extension.md` (this verdict entry).
- Diff reviewed: `the-intern/extensions/bob.ts`, `the-intern/extensions/bob.test.ts`, `the-intern/extensions/env.d.ts`, `the-intern/extensions/README.md`.
- Primary implementation evidence inspected at:
  - `the-intern/extensions/bob.ts` (`resolvePendingVerdicts`/`markDead`/`handleToolCall` fail-closed flow).
  - `the-intern/extensions/bob.test.ts` (`T-057 AC-3e: connect-time failure without verdict` regression).

Evidence:
- Checked expected changed files with `git diff --name-status dev-agent..task/T-057-add-the-blocking-tool-call-authorization-hook-to-the-bob-extension`.
- Reviewed code diffs and line-level behavior for AC-1..AC-4.
- Ran targeted regression: `cd the-intern/extensions && npx vitest run bob.test.ts -t "connect-time failure without verdict"` (pass).
- Ran full verification:
  - `cd the-intern/extensions && npx vitest run` (initial sandbox run failed with UDS `listen EPERM`; rerun with escalation passed, `25 passed`).
  - `cd the-intern/extensions && npx tsc --noEmit` (pass).

Obstacles Encountered:
- Sandbox blocked Unix domain socket bind (`listen EPERM`) during full `vitest`; resolved by rerunning the same verification command with escalated permissions.

Next Owner:
- Development Loop

Next Action:
- none
