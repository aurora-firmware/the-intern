---
id: B-019
title: bob.ts treats normal socket write backpressure as fatal and fail-closes 
  the session
severity: medium
status: in-progress
created: '2026-07-04'
---

# bob.ts treats normal socket write backpressure as fatal and fail-closes the session

## Summary

In the bob extension (`the-intern/extensions/bob.ts`), `flushPending` treats a
`socket.write()` return value of `false` as a fatal transport error and calls
`markDead`. In Node, `write()` returning `false` is ordinary backpressure —
the kernel send buffer is full and the data is still queued and will drain on
`'drain'`; it is not a failure. Once `markDead` fires, event forwarding is
silently disabled for the rest of the session **and every subsequent
`tool_call` is blocked** (`transport is dead` fail-closed path), so a burst of
large events (e.g. the full-payload `before_provider_request` frames) can
permanently disable an otherwise healthy session's tools. S-003's
"quiet degradation" contract covers real transport failures, not routine
backpressure.

## Reproduction Status

Status: not yet reproduced

Identified by code review (2026-07-04) of `bob.ts::flushPending`. Not yet
observed in a live session, but the trigger condition (a large frame burst
exceeding the kernel socket buffer while the service-side reader is busy) is
realistic: event payloads include entire provider request bodies, and the
service reads frames on a single per-connection loop that also performs
monitoring appends.

## Evidence

- Logs / stack traces / failing assertions: none yet (latent).
- Failing command or test: none yet.
- Code: `the-intern/extensions/bob.ts` — `flushPending`:
  `const ok = socket.write(frame); if (!ok) { … markDead("socket.write
  returned false — back-pressure or peer closed", ctx); }`. `markDead` sets
  `transportDead = true`, destroys the socket, and resolves all pending
  verdicts as transport errors; `handleToolCall` then returns
  `{ block: true, reason: "transport is dead" }` for every later tool call.
- First diagnostic step if not yet reproduced: unit test that writes frames
  into a UDS whose reader is paused until the client's kernel buffer fills
  (or a mocked `net.Socket` whose `write` returns `false`), then asserts the
  extension keeps the transport alive and delivers queued frames on drain.

## Reproduction Steps

1. Load the extension in a session connected to a deliberately slow reader
   (pause the service-side connection loop or shrink the socket buffers).
2. Trigger a burst of large pi events (e.g. several provider round-trips with
   big contexts) so `socket.write()` returns `false`.
3. Observe the one-shot warning `transport error — event forwarding disabled`
   followed by every subsequent tool call being blocked with
   `transport is dead`, even though the socket and service are healthy.

## Expected Behavior

`write()` returning `false` pauses further writes until the `'drain'` event
and (per the existing `PENDING_FRAMES_CAP` design) drops or caps *queued
frames* if the peer stays slow. Only genuine transport errors (`'error'`,
`'close'`, failed connect) kill the transport. Tool-call authorization keeps
working as long as the socket is actually alive; event loss under sustained
overload stays within S-003's documented quiet-degradation contract.

## Actual Behavior

The first backpressured write permanently kills the session's transport: all
later events are silently dropped and all later tool calls are denied
(fail-closed), turning a transient buffer-full condition into a
tools-disabled session that only a session restart clears.

## Environment

- OS / platform: Linux/macOS (UDS `extension.sock`)
- Language / runtime version: Node ≥20 (pi extension runtime, jiti-loaded
  TypeScript); pi-agent version per `README.md`
- Relevant dependencies: `net.Socket` backpressure semantics
- Branch / commit: `dev-agent` @ 56787d1

## Related

- Task: T-101/T-102 (extension authoring), B-016 (verdict-frame fail-closed
  hardening — adjacent code path)
- Specification: `project/specs/S-003-js-extension-for-pi-agent-event-forwarding.md`
  (failure behaviour contract),
  `project/specs/S-004-policy-control-pre-flight-admission-and-the-blocking-tool-call-authorization-path.md`
  (fail-closed applies to verdict failures, not to healthy-socket
  backpressure)

## Suspected Area

`the-intern/extensions/bob.ts` — `flushPending` / `ensureConnected` transport
state machine (no `'drain'` handling; `write() === false` conflated with peer
failure).

## Fix Verification

```bash
# From the-intern/extensions/:
npm test   # includes a new backpressure test: write returns false → transport
           # stays alive, frames flush on drain, tool calls still authorized
npm run typecheck
```

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
