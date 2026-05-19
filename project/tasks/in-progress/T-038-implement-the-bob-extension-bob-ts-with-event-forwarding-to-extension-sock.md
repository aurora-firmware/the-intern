---
id: T-038
title: Implement the bob extension bob.ts with event forwarding to 
  extension.sock
status: pending
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

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->
