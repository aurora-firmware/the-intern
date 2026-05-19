---
id: B-003
title: bob extension can grow memory without bound — pendingFrames uncapped and 
  socket.write() return ignored
severity: high
status: open
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
- For PASS: brief confirmation that diagnosis, fix, verification, and code quality passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->
