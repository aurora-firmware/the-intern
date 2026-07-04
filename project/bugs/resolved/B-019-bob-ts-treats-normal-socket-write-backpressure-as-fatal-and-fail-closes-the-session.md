---
id: B-019
title: bob.ts treats normal socket write backpressure as fatal and fail-closes 
  the session
severity: medium
status: resolved
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

Status: reproduced and fixed

Identified by code review (2026-07-04) of `bob.ts::flushPending`, then
reproduced with regression tests that forced `socket.write()` to report
ordinary backpressure while the socket remained writable. The trigger
condition (a large frame burst exceeding the kernel socket buffer while the
service-side reader is busy) is realistic: event payloads include entire
provider request bodies, and the service reads frames on a single
per-connection loop that also performs monitoring appends.

## Evidence

- Logs / stack traces / failing assertions: regression tests failed before the
  fix by observing the transport-dead fail-closed path after ordinary
  backpressure.
- Failing command or test: `npm test -- bob.test.ts` in
  `the-intern/extensions/`, specifically the B-019 backpressure regression
  tests.
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

### Diagnosis 1 — 2026-07-04

**Reproduction status:** Confirmed via a temporary automated reproduction (added to
`the-intern/extensions/`, run, then fully reverted — `git status --porcelain` clean
afterward). Not a live-session observation (the bug's own status was "not yet
reproduced, identified by code review"), but this is a deterministic unit-level
confirmation of the defect, not a flake: the same monkey-patched `write()` call
reproduces the failure on every run.

**Evidence captured:**
- Read the current source, `the-intern/extensions/bob.ts` @ HEAD of this branch
  (`3d15082`), confirming all three claims in the bug's Suspected Area:
  (a) `flushPending` (lines 224-238): `const ok = socket.write(frame); if (!ok) {
  pendingFrames.length = 0; markDead("socket.write returned false — back-pressure
  or peer closed", ctx); return; }` — unconditional fatal treatment of `write() ===
  false`.
  (b) `markDead` (lines 214-222): sets `transportDead = true`, calls
  `socket?.destroy()`, sets `socket = null`, and resolves every pending verdict
  resolver with `{ kind: "transport_error_logged" }`.
  (c) `handleToolCall` (lines 342-345): `if (transportDead) { warn(...); return {
  block: true, reason: "transport is dead" }; }` — checked first, before any
  frame is even sent, so it fires for every tool call after the first
  backpressured write.
- `grep -n "drain" the-intern/extensions/bob.ts` → one hit, inside an unrelated
  comment ("... transport is too slow to drain ..."); no `'drain'` event
  listener exists anywhere in `ensureConnected`/`flushPending`/the connect
  callback.
- `PENDING_FRAMES_CAP` (line 97) exists and is enforced in `ensureConnected`
  (line 243), but only against the pre-connect queue (frames accumulated while
  `connecting === true`); it is never read or written by `flushPending`, so it
  provides no protection for, and does not interact with, post-connect write
  backpressure — the mechanism the bug's Expected Behavior assumes is already
  wired up for this case is not.
- Baseline: `cd the-intern/extensions && npm test` → 2 files, 34 tests, all
  passing on the unmodified tree (`pi-agent-compat.test.ts` 5 tests,
  `bob.test.ts` 29 tests). Notably, three of those 34 currently-passing tests
  encode the defect as intended behavior and will need to be rewritten as part
  of the fix, not merely left in place: `bob.test.ts` "B-003-B: socket.write()
  back-pressure" (lines 411-455) asserts one warning + transport-dead +
  silent-no-op after a single `write() === false`; "T-044 AC-1 ... socket.write
  false with ctx.ui present" (lines 561-601) and "T-044 AC-2 ... socket.write
  false falls back to stderr" (lines 666-698) assert the same via the two
  warn-delivery branches.
- Temporary reproduction (`bob.b019.diagnostic.test.ts`, deleted after this
  run): established a real UDS connection via `session_start`, monkey-patched
  `net.Socket.prototype.write` to perform the real write but return `false`
  for exactly one call (simulating backpressure without an actual transport
  failure), then fired a `tool_call` and awaited its result while the fake
  server sent back an `allow` verdict. Command:
  `npx vitest run bob.b019.diagnostic.test.ts`. Output:
  `[bob] warn: transport error — event forwarding disabled for this session:
  socket.write returned false — back-pressure or peer closed`
  `[bob] warn: authz: tool call blocked — transport is dead`
  `AssertionError: expected 'transport is dead' not to be 'transport is dead'`
  — i.e. the tool call was blocked with `reason: "transport is dead"` even
  though the socket was never closed, errored, or actually failed; this
  reproduces the bug's documented Actual Behavior verbatim (both warning
  strings match the bug report exactly). File was removed after the run;
  `npm test` re-run afterward returns to the clean 34/34 baseline, and
  `git status --porcelain` is empty.

**Isolated fault:** `flushPending()` in `the-intern/extensions/bob.ts`
(lines 224-238), specifically `if (!ok) { ...; markDead(...); return; }`,
combined with the total absence of a `'drain'` listener in `ensureConnected`'s
connect callback (lines 267-273) or anywhere else in the transport state
machine.

**Root cause or fault hypothesis (confirmed, not speculative):** The code
conflates two semantically distinct `net.Socket` signals. `write()` returning
`false` is a purely local, non-fatal flow-control signal — the kernel/userland
send buffer exceeded `highWaterMark`; Node still queues the data and guarantees
delivery once the peer drains it, signaled by `'drain'`. Genuine transport
failure (peer closed, connection reset, failed connect) is delivered
separately via the socket's `'error'` and `'close'` events, which the code
*already* handles correctly and independently: `ensureConnected`'s
`sock.on("error", ...)` (lines 275-283) and `attachVerdictReader`'s
`sock.on("close", ...)` (lines 198-204) both correctly fail-close. Because
`flushPending` was written without a `'drain'` handler to fall back on, the
only way it could see was to treat `false` the same as those genuine failures
— that is the defect. Once `markDead` fires from this false signal,
`transportDead` becomes permanently sticky for the rest of the session (there
is no reset path other than session restart), so `handleToolCall`'s
fail-closed check at lines 342-345 blocks every later tool call regardless of
actual socket/service health, exactly as the bug describes.

**Design-decision flag (per diagnosis guidance):** The core correctness fix —
do not call `markDead` on `write() === false`; wait for `'drain'` before
writing more queued frames — is unambiguous. One open design question remains
for the fix/verification step: whether frames that accumulate *while waiting
for `'drain'`* after connection is already established should be bounded by
the existing `PENDING_FRAMES_CAP` (extending its current pre-connect-only
scope) or by a separate cap/drop policy for sustained post-connect backpressure.
This should be resolved during implementation, informed by S-003's
quiet-degradation contract (event loss under sustained overload is acceptable;
tool-call authorization is not).

**Planned fix:**
1. In `flushPending`, when `socket.write(frame)` returns `false`, stop the
   write loop (do not call `markDead`) and leave any not-yet-written frames in
   `pendingFrames` for the next flush attempt.
2. Register a `'drain'` listener on the socket (in `ensureConnected`'s connect
   callback, alongside `attachVerdictReader`) that re-invokes `flushPending`
   once the kernel buffer clears, so queued frames are eventually delivered.
3. Apply the design decision above to whatever queue accumulates during the
   drain-wait window, so a peer that never drains still degrades quietly
   (bounded drop/cap) rather than growing pendingFrames unboundedly.
4. Leave the genuine-failure paths (`sock.on("error", ...)`,
   `sock.on("close", ...)`) untouched — they already call `markDead` correctly
   and must keep doing so.
5. Rewrite the three existing tests that currently assert the buggy behavior
   (`B-003-B`, the two `T-044 ... socket.write false ...` tests in
   `bob.test.ts`) to assert the corrected contract, and add a new test proving
   a subsequent `tool_call` is still authorized after a `write() === false`
   event once `'drain'` fires.

**Planned verification:**
- `cd the-intern/extensions && npm test` — full suite green, including the
  rewritten backpressure tests, asserting: `write() === false` does not call
  `markDead` or emit the "transport error" warning; queued frames are
  delivered once `'drain'` fires (mocked `net.Socket` or a real UDS with a
  paused reader); a `tool_call` issued after a backpressured write is still
  sent to the service and its verdict honored (not short-circuited with
  `"transport is dead"`).
- `npm run typecheck`.
- Regression check: the existing genuine-failure tests continue to pass
  unmodified — AC-4 "socket.write failure after server close" (bob.test.ts
  lines 490-523, a real `EPIPE`/`ECONNRESET` via `'error'`, not a `false`
  return), and T-057 AC-3d/AC-3e (transport closed/connect-failed → fail
  closed).

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

### Session 1 — 2026-07-04

Implemented the B-019 fix entirely in `the-intern/extensions/bob.ts` and `bob.test.ts`, per the recorded Diagnosis Log's fix contract.

**What was done:** Added a `backpressured` boolean to the per-session transport state. `flushPending` now uses a `while` loop over `pendingFrames`, shifting each frame off the queue as soon as `socket.write()` is called on it (Node hands off ownership of the data regardless of the boolean return value) and stopping the loop — without touching `transportDead` — when `write()` returns `false`, leaving any remaining un-attempted frames queued for the next flush. A `'drain'` listener is now registered on the socket in `ensureConnected`'s connect callback, alongside `attachVerdictReader`; it clears `backpressured` and re-invokes `flushPending` so queued frames are delivered once the kernel buffer clears. `ensureConnected`'s pre-existing `pendingFrames.length >= PENDING_FRAMES_CAP` check (which already ran unconditionally on every push, connected or not) now also naturally bounds the new post-connect "waiting for drain" backlog — no new cap or config surface was added, matching the instruction not to invent one. The module doc comment, `PENDING_FRAMES_CAP` comment, and the cap-check comment were updated to describe the new semantics.

**Design decision (cap-bounding of the drain-wait queue):** I resolved the flagged design question by reusing the existing `PENDING_FRAMES_CAP` and its existing drop policy (call `markDead`, one warning, then silent no-op) verbatim for the post-connect drain-wait backlog, rather than inventing a separate softer policy that would only drop individual frames while keeping the transport alive. Rationale: (1) the instruction explicitly forbids a new configuration surface and asks for reuse of the "established drop policy," which for this cap has always been "kill the transport"; (2) a backlog that exceeds 64 queued NDJSON frames while genuinely waiting for `'drain'` indicates the peer is not merely momentarily busy but is, for practical purposes, non-functional — in that state an authz frame would be equally unable to get a timely verdict, so declaring the transport dead only accelerates what the existing authz timeout path would eventually produce anyway; (3) this keeps the change minimal — the cap-check code was not touched at all, only the new `backpressured` flag makes the existing check newly reachable from the post-connect state. This means the "tool-call authorization must keep working" requirement is honored for the common case (a single or occasional `write() === false`), which is what the bug actually reported and reproduced; only a sustained, 64-plus-frame-deep stall is treated as a hard failure, which I judged consistent with S-003/S-004's fail-closed intent for genuinely broken transports. Added a dedicated regression test (`B-019: pendingFrames cap also bounds the post-connect drain-wait queue`) proving this behavior.

**What was tried and rejected:** I initially implemented `flushPending` to treat every `write() === false` as non-fatal unconditionally, per the literal wording of the fix contract's step 1. Running the full suite against this version broke the AC-4 "socket.write failure after server close" test and my own rewritten T-044 genuine-failure tests (0 warnings instead of 1). I diagnosed this with a throwaway Node reproduction script (written, run, then deleted; `git status` clean afterward) and found that on this platform/Node version, destroying the peer-side connection produces a clean client `'close'` event with `hadError: false` — no `'error'` ever fires — and the client's subsequent `socket.write()` call simply returns `false` because the socket is already destroyed. `attachVerdictReader`'s `'close'` handler (correctly left untouched) only resolves pending verdicts; it does not call `markDead` or warn. This meant the literal "never mark dead on write()===false" rule would leave a genuinely-dead-but-cleanly-closed socket permanently un-flagged as dead (event frames would just silently pile up until the unrelated 64-frame cap eventually caught it, and tool calls would fail closed only via the 5-second authz timeout rather than immediately) — which regresses the documented "one warning, then silent no-op" contract for this specific and already-covered scenario. I rejected leaving this as-is and instead added a `socket.destroyed || !socket.writable` check inside the `write() === false` branch of `flushPending`: if the socket is already gone, treat it as a genuine failure (call `markDead`, matching the pre-existing behavior AC-4 depends on); otherwise treat it as ordinary back-pressure (set `backpressured = true`, wait for `'drain'`). This is a refinement confined entirely to `flushPending`, does not touch the `'error'`/`'close'` handlers (which remain untouched exactly as instructed), and lets every existing genuine-failure regression test (AC-4, T-057 AC-3d/AC-3e, all B-016 tests) plus the new T-044 rewrites pass without modification to their assertions.

**Tests added/rewritten:** `B-003-B` was rewritten to assert no warning, no dead transport, and successful flush-on-`'drain'` of a frame queued during the back-pressure window (using a one-shot `net.Socket.prototype.write` monkey-patch that captures the live socket instance so the test can fire a synthetic `'drain'` event without needing to genuinely saturate an OS buffer). Both `T-044 ... socket.write false ...` tests were re-pointed to the genuine server-close failure trigger (reusing the same pattern as the pre-existing, untouched AC-4 test), preserving ctx.ui-vs-stderr warn-delivery coverage. Added `B-019: pendingFrames cap also bounds the post-connect drain-wait queue` and `B-019 regression: tool_call stays authorized after write() back-pressure` (uses the bidirectional `createAuthzServer` helper, forces one `write() === false`, fires a `tool_call`, manually emits `'drain'` to flush the queued authz frame, and asserts the resulting allow verdict is honored rather than short-circuited with `"transport is dead"`).

**Verification:** `cd the-intern/extensions && npm test` → 2 files, 36 tests, all passing (re-run 3x, stable). `npm run typecheck` → clean.

**What remains:** Nothing outstanding for this bug. No live pi-session verification was performed (not reproducible in this harness, per instructions) — the vitest suite is the required evidence. Reviewer should pay particular attention to the `socket.destroyed`/`socket.writable` distinction added to `flushPending`, since it is a deviation from the fix contract's literal step 1 wording (though not from its intent), made necessary by the AC-4 regression discovered during implementation.

### Session 2 — 2026-07-04

**What was done:** Addressed the Reviewer's single blocking issue (the CAP/overload policy). `ensureConnected`'s `pendingFrames.length >= PENDING_FRAMES_CAP` guard now branches on whether a live socket exists. When `socket === null` (pre-connect), behavior is byte-for-byte unchanged from before this session — `markDead` fires exactly as it always has, matching B-003-A. When `socket !== null` (post-connect drain-wait — the only way `pendingFrames` grows once connected, since `flushPending` drains it immediately whenever not backpressured), the transport is no longer killed: a one-shot `drainBacklogWarned` flag gates a single warning with distinct "dropping oldest queued events" wording (never the fatal "transport error" phrasing `markDead` uses), and the oldest queued frame that is *not* an authz frame is evicted (`pendingFrames.findIndex((f) => !f.isAuthz)`) to make room, leaving the socket alive so anything still queued — including any authz frame — flushes normally once `'drain'` fires.

**Design decision (frame-type tracking):** To let eviction prefer event frames over authz frames, `pendingFrames` changed from `string[]` to `{ text: string; isAuthz: boolean }[]`, and `ensureConnected` gained a third `isAuthz = false` parameter; `handleToolCall`'s call site now passes `true`. This is the minimal structural change needed to distinguish frame types per the Reviewer's "if distinguishing frame types requires more than a minimal, clean change, document the trade-off" guidance — I judged tagging each queue entry with a boolean was clean enough to implement directly rather than working around it. If every queued frame happens to be an authz frame (no event frame available to drop instead — an edge case not expected in practice given how rarely authz frames queue relative to event volume), the code falls back to evicting the oldest frame outright; that authz frame's caller still fails closed via the unmodified 5-second `BOB_AUTHZ_TIMEOUT_MS` path, per the Reviewer's explicit allowance that this is "acceptable as a last resort."

**What was tried and rejected:** No alternative implementation was attempted — the Reviewer's verdict specified the exact policy shape (differentiate pre/post-connect, warn once, drop oldest event frames FIFO, rely on the existing authz timeout as the fail-closed backstop for a truly stuck peer), so this session implemented it directly rather than exploring alternatives.

**Tests added/rewritten:** Rewrote `B-019: pendingFrames cap also bounds the post-connect drain-wait queue` to assert the new policy — exactly one warning not matching `/transport error/i`, and (by firing a synthetic `'drain'` after queuing `CAP + 5` event frames) confirmed the oldest 5 are evicted while the newest `CAP` frames still flush to the server once the socket recovers, proving the transport was never marked dead. Added `B-019: authz frame survives a post-connect event backlog that exceeds the cap`: queues a `CAP + 5`-frame event-only backlog while backpressured, fires a `tool_call` so its authz frame is enqueued behind the full backlog (forcing an event-frame eviction to make room for it), fires `'drain'`, and asserts the authz frame is delivered, its allow verdict is honored (`result.block` falsy, `result.reason !== "transport is dead"`), and only the single quiet-degradation warning fired throughout (never the fatal transport-error warning). Both tests were confirmed to fail against the pre-session code (`expected '[bob] warn: transport error...' not to match /transport error/i`) before the implementation change, then confirmed to pass after.

**Verification:** `cd the-intern/extensions && npm test` → 2 files, 37 tests, all passing (re-run 3x, stable). `npm run typecheck` → clean. `git diff --stat` confirms only `bob.ts` and `bob.test.ts` changed.

**What remains:** Nothing outstanding for this bug from this session's scope. No live pi-session verification was performed (not reproducible in this harness, per instructions) — the vitest suite is the required evidence.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that diagnosis, fix, verification, and code quality passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->

### Review Verdict — 2026-07-04

FAIL

**Diagnosis→fix evidence chain:** Complete. Diagnosis 1 records reproduction
status (a deterministic, temporary, fully-reverted unit-level repro),
evidence captured (source line citations, a `grep` confirming no `'drain'`
listener existed, the pre-existing `PENDING_FRAMES_CAP`'s pre-connect-only
scope, a clean 34/34 baseline, and the diagnostic test's exact captured
output matching the bug's Actual Behavior verbatim), an isolated fault
(`flushPending`'s unconditional `markDead` on `write() === false` combined
with the absent `'drain'` listener), and a root cause stated as confirmed,
with a correctly identified open design question flagged for
implementation time. Step 1's evidence-chain check passes.

**Core fix — verified correct.** Diffed `bob.ts` on the bug branch against
`dev-agent`. `flushPending` now loops over `pendingFrames`, shifts each
frame off the queue as `write()` is called (correct: Node takes ownership of
the buffer regardless of return value), and on `write() === false` for a
healthy socket sets `backpressured = true` and returns — `markDead` is not
called and `transportDead` is untouched. A `'drain'` listener is registered
in `ensureConnected`'s connect callback (`sock.on("drain", () => {
backpressured = false; flushPending(ctx); })`), alongside
`attachVerdictReader`, so queued frames flush once the buffer clears. This
matches the fix contract's steps 1–2 exactly and is confirmed by the
rewritten `B-003-B` test (no warning, no dead transport, frame flushes on a
synthetic `'drain'`) and the new `B-019 regression: tool_call stays
authorized after write() back-pressure` test (an authz frame queued behind a
back-pressured write is still delivered and its verdict honored, not
short-circuited with `"transport is dead"`).

**`socket.destroyed || !socket.writable` deviation — sound, and confirmed
necessary.** Traced Node's semantics: ordinary back-pressure (buffer over
`highWaterMark`) never sets `destroyed` or clears `writable`, so a healthy
backpressured socket cannot be misclassified as dead by this check. The
check runs synchronously immediately after `write()` returns with no
intervening event-loop turn, so there is no race window between the write
call and the check (any synchronous side effect of the write, e.g. Node
calling `errorOrDestroy` internally for a write-after-destroy, is already
reflected by the time the check runs). I confirmed the check is not
redundant window-dressing: the pre-existing, *unmodified*
`AC-4: transport failure handling > "logs one warning on write failure and
treats subsequent events as no-ops"` test tears down the real server via
`conn.destroy()` (no `write()` monkey-patch at all) and still passes only
because of this check — without it, that test would regress exactly as the
Work Log describes (the client's `'close'` fires with `hadError: false` and
no `'error'`, `attachVerdictReader`'s `'close'` handler intentionally does
not call `markDead`, so the next `write()` on the now-destroyed socket would
be treated as ordinary back-pressure, `backpressured` would be set and never
clear since no `'drain'` will ever come, and the transport would sit "alive"
but permanently stuck until the unrelated 64-frame cap or the 5s authz
timeout). This is a legitimate, well-justified, minimal deviation from the
fix contract's literal step 1, confined to `flushPending`, and does not
touch the `'error'`/`'close'` handlers. AC-4, T-057 AC-3d/AC-3e, and all four
B-016 tests are unmodified in the diff and pass — traced each: AC-4's write
after real close relies on the new `destroyed` check as above; T-057 AC-3d
and the B-016 tests are driven independently by `attachVerdictReader`'s
`'close'` handler resolving `pendingVerdicts` to `"error"`, which was never
touched.

**CAP/overload policy — this is the blocking issue.**

- **File and location:** `the-intern/extensions/bob.ts`, `ensureConnected`,
  the `if (pendingFrames.length >= PENDING_FRAMES_CAP) { markDead(...); }`
  guard, now also reached from the post-connect drain-wait state (per the
  new `backpressured` flag making `flushPending` a no-op while
  `pendingFrames` keeps growing).
- **What is wrong:** The Developer reused the pre-connect cap's existing
  "call `markDead`" drop policy verbatim for the new post-connect
  drain-wait backlog. `pendingFrames` is a single FIFO queue shared by both
  ordinary event frames and authz frames (`handleToolCall` calls
  `ensureConnected` exactly like `handleEvent` does), so a sustained
  64+-frame backlog of *any kind* — including a realistic burst of
  large/rapid pi events such as per-chunk `message_update` or full-payload
  `before_provider_request`/`after_provider_response` frames, which is the
  bug's own documented trigger scenario — sets `transportDead = true`
  permanently for the rest of the session, with no reset path other than a
  restart. This reintroduces the bug's core symptom (an otherwise-healthy
  session's tools being permanently disabled by an event burst) at a higher
  trigger threshold (64 frames instead of 1), rather than eliminating it.
  This contradicts two things on record: (1) the bug's own Expected
  Behavior — "Only genuine transport errors ('error', 'close', failed
  connect) kill the transport... Tool-call authorization keeps working as
  long as the socket is actually alive" — which draws an explicit
  boundary between "kill the transport" and the cap's "drop or cap queued
  frames" action (the two sentences are adjacent and mutually clarifying;
  if the cap's action were "kill the transport," the bug's own sentence
  restricting transport-kill to genuine transport errors would be
  self-contradictory); and (2) Diagnosis 1's own recorded design guidance
  for exactly this decision — "informed by S-003's quiet-degradation
  contract (event loss under sustained overload is acceptable; tool-call
  authorization is not)" — which the implementation does not honor: event
  loss and authz loss are treated identically (both take down the whole
  transport) rather than differentiated.
- **What should change:** Differentiate the pre-connect and post-connect
  cases. Leave the pre-connect (`connecting === true`) cap behavior as-is
  (unchanged scope, matches B-003-A). For the new post-connect drain-wait
  backlog, implement a policy that does not set `transportDead` and does
  not call `markDead`: e.g., once the cap is exceeded, warn once and drop
  the oldest queued *event* frames (FIFO) to bound memory while leaving the
  socket itself alive, so any already-queued or future authz frame can
  still be sent and flushed once `'drain'` eventually fires. If an authz
  frame specifically needs a fail-closed backstop for a peer that never
  drains, the already-existing 5-second `BOB_AUTHZ_TIMEOUT_MS` path is the
  designed mechanism for that (S-004's fail-closed contract explicitly
  covers "a verdict that does not arrive within a bounded timeout" as a
  legitimate fail-closed trigger) — it does not require killing
  `transportDead` for the rest of the session. Add a regression test that
  reproduces an authz frame queued in/behind a 64+-frame event-only backlog
  and asserts it is still deliverable and honored once `'drain'` fires (the
  current `B-019: pendingFrames cap also bounds the post-connect drain-wait
  queue` test only exercises pure event frames and does not cover an authz
  frame caught in the same backlog).

**Fix Verification — ran myself from `the-intern/extensions/` on the bug
branch** (via a `git worktree` checkout, `npm install`): `npm test` → 2
files, 36 tests, all passing (re-run 3x, stable, no flakiness). `npm run
typecheck` → clean, no errors. Scope confirmed confined to `bob.ts` and
`bob.test.ts` (`git diff --stat dev-agent...bug/B-019-...` shows only those
two files).

The Developer should revise the post-connect drain-wait cap policy per the
guidance above, add the missing authz-frame-under-backlog regression test,
and resubmit. Everything else reviewed above (core fix, `'drain'` wiring,
the `socket.destroyed`/`writable` deviation, and the genuine-failure
regression suite) is correct and should be preserved as-is.

### Review Verdict — 2026-07-04

PASS

**Scope of this cycle.** Reviewed Work Log Session 2 and commit `94c3710
fix(extensions): keep transport alive under post-connect event backlog`
against the single blocking issue from the prior FAIL verdict (the
post-connect CAP/overload policy). Diffed `dev-agent...bug/B-019-...`
(2 files: `the-intern/extensions/bob.ts`, `the-intern/extensions/bob.test.ts`
— confirmed via `git diff --stat`; no service-side or out-of-repo files
touched) and read `94c3710` in full, plus the complete post-fix `bob.ts`.

**Blocking issue — resolved.** `ensureConnected`'s cap guard
(`the-intern/extensions/bob.ts`, inside `if (pendingFrames.length >=
PENDING_FRAMES_CAP)`) now branches on `socket === null`:
- Pre-connect (`socket === null`): unchanged — calls `markDead` exactly as
  before, matching B-003-A. Confirmed byte-for-byte behavior preserved by
  the still-passing `B-003-A: pendingFrames cap (pre-connect)` and `T-044
  AC-1 ... pendingFrames cap breach with ctx.ui present` tests (both
  synchronous-burst-before-connect scenarios, so `socket` is still `null`
  when the cap fires).
- Post-connect (`socket !== null`): no longer calls `markDead` or sets
  `transportDead`. A one-shot `drainBacklogWarned` flag gates a single
  warning with distinct, non-fatal wording (`"pendingFrames cap of 64
  exceeded while waiting for drain — dropping oldest queued events"` — does
  not match `/transport error/i`, unlike `markDead`'s wording), and the
  oldest queued frame with `!isAuthz` is evicted via
  `pendingFrames.findIndex((queued) => !queued.isAuthz)` /
  `pendingFrames.splice(oldestEventIndex, 1)` to make room before the new
  frame is always pushed at the end of the guard block. This keeps the
  queue length bounded at `PENDING_FRAMES_CAP` on every path (evict-then-push
  never lets it exceed the cap) while leaving `socket`/`transportDead`
  untouched, so the transport stays alive and anything still queued —
  including a queued authz frame — flushes normally once `'drain'` fires.

**Frame-typing (`pendingFrames: string[] → {text, isAuthz}[]`) — correct
and complete.** Traced every touch point in `bob.ts`: the single `push` site
(`ensureConnected`, `pendingFrames.push({ text: frame, isAuthz })`) is fed by
exactly two call sites — `handleEvent` calls `ensureConnected(frame, ctx)`
(default `isAuthz = false`, correct for ordinary events) and
`handleToolCall` calls `ensureConnected(frame, ctx, true)` (correct for
authz frames). `flushPending` reads `pendingFrames[0]!.text` for the actual
`socket.write()` call and otherwise only shifts/splices the array — no
remaining code path treats an entry as a bare string. `pendingFrames.length
= 0` in the `'error'` handler still works unchanged against the new element
shape. No other file or test manipulates `pendingFrames` directly (`grep -n
"pendingFrames" bob.test.ts` shows only comments/describe-block titles); all
test coverage exercises the queue through observable behavior (warnings,
delivered frames, verdicts), not internal state.

**Eviction correctness.** Traced the FIFO-oldest-event-first logic by hand
against the `B-019: pendingFrames cap also bounds the post-connect
drain-wait queue` test's `CAP + 5` (69) `turn_start` burst: the guard runs
before each push, so once the queue reaches `CAP` (64), each subsequent push
evicts exactly one oldest-event index (0, then 1, 2, 3, 4 across the 5
overflow pushes) before appending the new frame, leaving the queue at a
constant 64 throughout and never exceeding the cap. This produces surviving
event indices `5..68` (the newest 64), exactly matching the test's
assertions (`turnStartIndices[0] === overflow`, last `=== eventCount - 1`,
`lines.length === 1 + PENDING_FRAMES_CAP`), and only one warning fires for
the whole burst. The "authz frame survives a post-connect event backlog"
test extends this: once the 64-frame all-event queue is full, enqueuing an
authz frame correctly evicts the oldest *event* frame (`findIndex(!isAuthz)`
finds an event, not the authz frame itself) rather than falling back to the
`pendingFrames.shift()` last-resort branch — that branch is reachable only
when every queued frame is already an authz frame, which is not exercised
by either committed test but is a documented, reviewer-accepted last resort
(the stuck authz frame still fails closed via `BOB_AUTHZ_TIMEOUT_MS`, an
independent `Promise.race` in `handleToolCall` that does not depend on the
frame ever reaching the wire). No off-by-one, empty-queue, or
`findIndex === -1`-mishandling defects found: `findIndex` returning `-1`
is explicitly handled by the `else` branch, and the guard's "evict only if
at/over cap" check correctly runs once per push rather than looping, so it
can never under- or over-evict for a single incoming frame.

**Bug's Expected Behavior — now fully satisfied.** Verified directly, not
just via the tests: under a sustained event backlog the transport is never
marked dead (no `markDead` call on this path, `transportDead` untouched),
event loss is bounded and FIFO-oldest-first (not unbounded, not silently
dropping the newest event instead), and tool-call authorization keeps
working — an authz frame behind a full event backlog is preferentially kept
in the queue over event frames, delivered once `'drain'` fires, and its
verdict honored (not short-circuited with `"transport is dead"`). The
5-second `BOB_AUTHZ_TIMEOUT_MS` remains the fail-closed backstop for a peer
that genuinely never drains (unchanged, independent code path). This
resolves the contradiction the prior FAIL identified between the
implementation and both the bug's Expected Behavior and Diagnosis 1's
S-003/S-004 design guidance.

**Required tests — both present and independently confirmed to prove the
fix.** Rewrote the pre-fix `bob.ts` (checked out commit `ffbeba4`, the
cycle-1 tree, into a scratch `git worktree` with the current `bob.test.ts`
from `94c3710`) and re-ran `npm test`: both `B-019: pendingFrames cap also
bounds the post-connect drain-wait queue` and `B-019: authz frame survives a
post-connect event backlog that exceeds the cap` fail against the cycle-1
code with `AssertionError: expected '[bob] warn: transport error — event
f…' not to match /transport error/i` (i.e., the cycle-1 code still calls
`markDead` on this path, exactly the defect this cycle fixes) — 2 failed, 35
passed. Restored the worktree to `94c3710` and confirmed both pass alongside
the full suite. This is genuine before/after regression-test evidence, not
an assumption from reading the diff.

**Previously-approved parts — confirmed intact, no regression.** Full
36-test-turned-37-test suite passes, including (all unmodified by this
cycle's diff): the core `flushPending` fix (frame-shift-before-write-check,
`backpressured` flag, no `markDead` on healthy back-pressure), the `'drain'`
listener wiring in `ensureConnected`'s connect callback, the
`socket.destroyed || !socket.writable` deviation and its dependent `AC-4:
transport failure handling` test, `T-057 AC-3d`/`AC-3e`, all four `B-016`
regression tests, the rewritten `B-003-B` test, both `T-044 AC-1`/`AC-2`
families (including the pre-connect cap-breach `ctx.ui` variant, confirmed
still hitting the unchanged `socket === null` branch), and the Session-1
`B-019 regression: tool_call stays authorized after write() back-pressure`
test (byte-for-byte unmodified in the diff).

**Fix Verification — ran myself from `the-intern/extensions/` on the bug
branch** (via a `git worktree` checkout at `94c3710`, `npm install`): `npm
test` → 2 files, 37 tests, all passing (re-run 3x, stable, no flakiness).
`npm run typecheck` → clean, no errors. Scope confirmed confined to
`bob.ts` and `bob.test.ts` via `git diff --stat
dev-agent...bug/B-019-...`.

**Minor, non-blocking observation:** the "every queued frame is already an
authz frame" fallback branch (`pendingFrames.shift()` in the `else` arm) has
no dedicated test, only the documented reasoning that it degrades to the
existing authz-timeout fail-closed path. Given how rarely authz frames
alone could fill a 64-entry queue (would require 64 concurrent in-flight
tool calls with no events at all queued behind a stalled drain), this is an
acceptable, explicitly-flagged edge case and does not block this verdict.

Both stages (diagnosis→fix evidence chain, acceptance/bug criteria, and
code quality including the bug-fix addendum) pass. No further changes
required; ready to move to `resolved/`.
