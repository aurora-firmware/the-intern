---
id: B-003
title: bob extension can grow memory without bound — pendingFrames uncapped and 
  socket.write() return ignored
severity: high
status: in-progress
created: '2026-05-19'
---

# bob extension can grow memory without bound — pendingFrames uncapped and socket.write() return ignored

## Summary

`the-intern/extensions/bob.ts` queues events into a `pendingFrames` array during the in-flight first connect (lines ~94–117) and writes them to the UDS once connected, but (a) `pendingFrames` has no length cap, and (b) `socket.write()` return value is never checked. When the bob service is slow to drain, Node accepts frames into its internal kernel buffer without bound and the extension keeps pushing. This violates S-003's "no buffering, lost-connection windows are dropped silently" intent and is a real memory-growth bug under bursty load.

## Reproduction Status

Status: confirmed — reading the code at `the-intern/extensions/bob.ts` (latest commit on `dev-agent`) shows `pendingFrames.push(frame)` with no bound check and `socket.write(frame)` without using the boolean return value or wiring a `drain` listener.

## Evidence

- Logs / stack traces / failing assertions: none at runtime yet — confirmed by code inspection.
- Screenshots or recordings: none
- Failing command or test: `the-intern/extensions/bob.ts:94-117` — `pendingFrames.push(frame)` + `socket.write(frame)` with unchecked return.
- First diagnostic step if not yet reproduced: Inspect `the-intern/extensions/bob.ts` lines 90–120; wire a slow consumer on the UDS in `bob.test.ts` and fire 10k synthetic events; observe RSS climb of the extension's Node process.

## Reproduction Steps

1. Inspect `the-intern/extensions/bob.ts` lines 90–120 — see `pendingFrames.push(frame)` with no `pendingFrames.length` guard.
2. Inspect lines 103–117 — see `socket.write(frame)` whose return value is discarded.
3. (Optional stress) wire a slow consumer on the UDS in `bob.test.ts` and fire 10k synthetic events; observe RSS climb of the extension's Node process.

## Expected Behavior

When the transport is in `connecting` state, frames beyond a small cap (suggested: 64) are dropped with one `warn()` and `transportDead = true`. When `socket.write()` returns `false`, the extension pauses pushing until `drain` fires, or — preferred under the spec's "no buffering" stance — calls `markDead` after a single warn.

## Actual Behavior

`pendingFrames` and Node's kernel buffer grow without bound. No warn, no drop, no dead-transport transition.

## Environment

- OS / platform: Linux (Codex execution environment)
- Language / runtime version: Node + vitest under `the-intern/extensions`
- Relevant dependencies: `the-intern/extensions/bob.ts`, `bob.test.ts`
- Branch / commit: `dev-agent` post-merge of T-040 (`ceb872d`)

## Related

- Task: `T-037`
- Specification: `S-003`

## Suspected Area

`the-intern/extensions/bob.ts` — `flushPending`, `handleEvent`, transport state machine.

## Fix Verification

Extend `bob.test.ts` with a test that fires N + 1 frames before connect resolves (with the cap set to N), asserts: exactly one `warn` called, `transportDead === true`, only ≤ N frames delivered. `npx tsc --noEmit && npm test` must pass.

## Diagnosis Log

<!-- Mandatory before implementation. Append one entry before changing production code. Format:
### Diagnosis N — YYYY-MM-DD
Reproduction status:
Evidence captured:
Isolated fault:
Root cause or fault hypothesis:
Planned verification:
-->

### Diagnosis 1 — 2026-05-19

**Reproduction status:** Confirmed by code inspection. Both faults are structural and present in `dev-agent`. `npm test` (9/9 pass) and `npx tsc --noEmit` (clean) — no regression guard exists for either fault.

**Evidence captured:**
- `the-intern/extensions/bob.ts:94` — `const pendingFrames: string[] = [];` (no length limit declared).
- `the-intern/extensions/bob.ts:123` — `pendingFrames.push(frame)` inside `ensureConnected` runs unconditionally; no `pendingFrames.length` guard anywhere.
- `the-intern/extensions/bob.ts:103-118` — `flushPending` loops over `pendingFrames` and calls `socket.write(frame)` at line 106; the boolean return value is discarded. The only guard is `socket.destroyed` (peer-close), which does not handle back-pressure.
- `the-intern/extensions/bob.ts:125-128` — the already-connected path also flows through `flushPending`, so the unchecked `socket.write` is the sole write path.
- `bob.test.ts` — no tests for cap, drain, back-pressure, or `socket.write() === false`.

**Isolated fault:**
- Fault A: pre-connect buffer is uncapped. `pendingFrames.push(frame)` at line 123 appends without limit while `connecting === true`.
- Fault B: `socket.write()` return discarded at line 106. Node's internal send buffer grows unbounded under a slow consumer.

**Root cause or fault hypothesis:** Two structural omissions. (A) the connect-window queue lacks a length cap and drop policy. (B) the writer does not check `socket.write()` for back-pressure. Per S-003 "no buffering, lost-connection windows are dropped silently" — both should fail loud-once then mark the transport dead.

**Planned verification:**
1. Add a regression test for the pre-connect cap: queue `CAP + 1` events while a delayed-accept server holds the connect open; assert exactly one `warn`, `transportDead === true`, and ≤ `CAP` frames delivered.
2. Add a regression test for `socket.write() === false`: after connect, mock `socket.write` to return `false`; assert exactly one `warn` and that subsequent events are no-ops.
3. Implement the minimal fix: a small `CAP` constant (suggested 64), a length guard before `pendingFrames.push`, a return-value check on `socket.write`, both paths transitioning the transport to dead with one `warn`.
4. Verification command: `npx tsc --noEmit && npm test` — all green.

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

### Session 1 — 2026-05-19

Introduced `PENDING_FRAMES_CAP = 64` at module scope in `the-intern/extensions/bob.ts`. In `ensureConnected`, added a guard before `pendingFrames.push(frame)`: if `pendingFrames.length >= PENDING_FRAMES_CAP`, call `markDead` and return without pushing. In `flushPending`, captured the boolean return of `socket.write(frame)`: on `false` call `markDead`, clear pending frames, and stop flushing. The pre-existing `socket.destroyed` check was removed because `write()` returns `false` on destroyed sockets too, so the `!ok` guard subsumes it. No drain listener was wired — per S-003 "no buffering" the preferred response is loud-once + dead.

Two regression tests were added to `bob.test.ts` first (red), confirming both faults reproduced with the expected `warn` call counts being zero before the fix:
- **B-003-A pre-connect cap**: starts a real UDS server, fires `PENDING_FRAMES_CAP + 1` events synchronously while the connect is still in flight; asserts exactly one stderr `warn`, transport dead (subsequent events silent), and ≤ CAP frames reach the server.
- **B-003-B back-pressure**: establishes a real connection, monkey-patches `net.Socket.prototype.write` to return `false` for a single call, fires an event; asserts exactly one `warn` and that subsequent events are no-ops.

Both tests went green after the fix. `npx tsc --noEmit` is clean. `npm test` reports 11/11 passed (9 pre-existing + 2 new).

Commit: `6e17c6f` on `bug/B-003-bob-extension-pending-frames-cap` — `fix(bob-extension): cap pendingFrames and honour socket.write back-pressure`. Nothing remains for the next session.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that diagnosis, fix, verification, and code quality passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->
