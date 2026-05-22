---
id: T-038
title: Implement the bob extension bob.ts with event forwarding to 
  extension.sock
status: completed
priority: high
assigned-role: unassigned
created: '2026-05-19'
spec: S-003
---

# Implement the bob extension bob.ts with event forwarding to extension.sock

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

Author the bob extension at `the-intern/extensions/bob.ts`. Phase 2 of
S-003. The extension exports a default factory `(pi) => void` that:

1. Reads `process.env.BOB_SESSION_ID` and `process.env.BOB_EXTENSION_SOCK_PATH`.
2. Opens a UDS to that path. Connect lazily on first event so a missing
   socket does not crash extension load.
3. Subscribes via `pi.on(name, handler)` to every event documented at
   https://pi.dev/docs/latest/extensions — confirm the canonical list at
   implementation time (the names listed in S-003 are the seed set, not
   the contract).
4. Serializes each event as a single NDJSON line matching the existing
   `InboundFrame::Event` variant in
   `the-intern/service/crates/extension-ipc/src/framing.rs`:
   `{"kind":"event","session":"<BOB_SESSION_ID>","payload":{"event":"<name>","data":<event-object>}}\n`.
5. On any failure (missing env var, connect error, write error) logs one
   warning (via `ctx.ui` if available, otherwise stderr) and degrades to
   a session-long no-op. No retries, no backoff.

Ship a round-trip test in `bob.test.ts` that spins up a UDS in a temp
dir, invokes the factory against a stub `ExtensionAPI` that lets the test
fire fake events, and asserts the frame shape on the receiving end.

## Acceptance Criteria

AC-1: WHEN the factory runs with both env vars set and the configured UDS reachable THE SYSTEM SHALL register a handler for every event name documented at https://pi.dev/docs/latest/extensions at implementation time.
AC-2: WHEN any subscribed pi event fires THE SYSTEM SHALL write exactly one NDJSON line to the UDS whose `kind` equals `"event"`, whose `session` equals `process.env.BOB_SESSION_ID`, whose `payload.event` equals the pi event name, and whose `payload.data` equals the pi event object verbatim.
AC-3: IF `BOB_SESSION_ID` or `BOB_EXTENSION_SOCK_PATH` is missing at factory load THEN THE SYSTEM SHALL log exactly one warning and register no event handlers.
AC-4: IF the UDS cannot be opened or a write to the UDS fails mid-session THEN THE SYSTEM SHALL log exactly one warning, mark the transport dead, and treat all further events as no-ops for that session.

## Dependencies

- `T-037` — Node project scaffold the extension depends on for build and test.

## Files to Touch

- `the-intern/extensions/bob.ts` — the default-factory extension.
- `the-intern/extensions/bob.test.ts` — round-trip unit test over a real UDS in a temp directory.

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

**What was done**

Implemented `the-intern/extensions/bob.ts` and its test suite `the-intern/extensions/bob.test.ts` from scratch, covering all four acceptance criteria.

**Event list (AC-1)**

The live docs at `https://pi.dev/docs/latest/extensions` are reachable but the page is a client-rendered SPA that does not expose the event list in parseable HTML. The canonical list of 29 events was extracted from the installed package's TypeScript type definitions (`@earendil-works/pi-coding-agent@0.75.3`, `dist/core/extensions/types.d.ts`, the `ExtensionAPI.on()` overloads). This is noted in a comment in `bob.ts`.

**Implementation design**

The factory captures `BOB_SESSION_ID` and `BOB_EXTENSION_SOCK_PATH` from `process.env` at call time (not at module load), maintains a closure-local transport state (`socket`, `transportDead`, `connecting`, `pendingFrames`), and opens the UDS lazily on the first event. Frames are queued while the connect is in progress and flushed on connect. The `markDead` path sets `transportDead = true`, destroys the socket, and writes one warning to `ctx.ui` (if available) or stderr.

**Failure mode discoveries during testing**

Two non-obvious platform behaviours shaped the implementation:

1. _Peer-close is silent on the client._ When the server calls `destroy()` on its end of a UDS connection, Node.js does NOT emit an `error` event on the client socket; it only emits `close` (and `end`). Subsequent `write()` calls return `false` and the socket's `destroyed` property becomes `true`. I therefore added a post-write `socket.destroyed` check inside `flushPending()` to detect this condition instead of relying on the `error` event alone.

2. _Async close event leaks across tests._ An earlier design included a `close` event handler on the socket to detect peer closes. This caused cross-test contamination: when AC-2 tests called `server.close()` to destroy the test server, the `close` event on bob's socket fired asynchronously — sometimes after `afterEach` and into the setup phase of the next test, causing stray stderr writes to be captured by the AC-4 spy. Removing the `close` handler and relying solely on the post-write `destroyed` check eliminated the contamination.

3. _Test server must be awaited before factory runs._ `net.Server.listen()` is asynchronous on UDS. The initial test helper called `server.listen(sockPath)` without waiting for the `listening` event, so the factory would attempt to connect before the socket file existed. Fixed by awaiting a promise that resolves on the `listening` event.

4. _Test server must eagerly destroy connections before closing._ `server.close()` waits for all existing connections to drain before invoking its callback. Since bob's socket stays open (no connection teardown on the extension side), `server.close()` would never resolve. Fixed by tracking connections in a `Set` and calling `conn.destroy()` on each before closing the server.

**What remains**

Nothing — all four acceptance criteria are met, all 9 tests pass, and `npx tsc --noEmit && npm test` exits 0.

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

- AC-1: All 29 events from `ExtensionAPI.on()` overloads in `@earendil-works/pi-coding-agent@0.75.3 dist/core/extensions/types.d.ts` are registered. Using the installed package's type definitions as the canonical source is reasonable given that the live docs page is a client-rendered SPA. The `PI_EVENTS` array matches the overload list exactly. Pass.
- AC-2: `buildFrame()` produces `{"kind":"event","session":"<id>","payload":{"event":"<name>","data":<object>}}\n`, which deserialises correctly as `InboundFrame::Event` (Rust `#[serde(tag = "kind")]`, `payload: Value`). Tests verify `kind`, `session`, `payload.event`, and `payload.data`. Pass.
- AC-3: Factory returns early with one `warn()` call and zero `piGeneric.on()` calls when either env var is absent. Three tests cover the three missing-env-var combinations. Pass.
- AC-4: Connect failure handled via `sock.on("error", ...)` → `markDead` (one warning, dead flag set). Mid-session write failure (peer close without error event) detected via post-write `socket.destroyed` check in `flushPending()` → `markDead`. Subsequent event handlers are no-ops due to `transportDead` guard. Tests confirm one warning and no subsequent warnings in both scenarios. Pass.
- Files touched: only `the-intern/extensions/bob.ts` and `the-intern/extensions/bob.test.ts`, matching the stated scope exactly. Pass.

**Stage 2 — Code quality**

- Correctness: Lazy-connect state machine (`socket`, `transportDead`, `connecting`, `pendingFrames`) is correct. The `pendingFrames.length = 0` reset before `markDead` prevents stale frames. The peer-close detection is an appropriate workaround for a documented Node.js platform behaviour.
- Tests: 9 independent tests with isolated temp dirs and socket servers. Success and failure paths both covered. `waitUntil` polling prevents flaky timing assertions.
- Security: No hardcoded secrets; no external input paths.
- Readability: Function responsibilities are clearly separated; non-obvious platform behaviours are commented.
- Performance: No resource leaks; socket is destroyed on `markDead`.

**Verification evidence**: `npx tsc --noEmit` exits 0; `npm test` reports 9/9 tests passed in 387 ms.
