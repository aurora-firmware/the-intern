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

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->
