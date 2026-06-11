---
id: T-089
title: Make the CLI chat receive loop frame-safe under concurrent send and stdin
status: pending
priority: medium
assigned-role: developer
created: '2026-06-11'
spec: S-008
---

# Make the CLI chat receive loop frame-safe under concurrent send and stdin

## Description

Remove the cancellation hazard in the interactive chat loop (Component 4
of S-008, receive half), flagged in the PR #19 review and reachable as
soon as chat notifications flow.

The `tokio::select!` loop in `crates/bob/src/cli/commands/chat.rs` races
`subscription.recv()` against stdin lines. `recv()` bottoms out in
`AsyncBufReadExt::read_line` inside
`crates/bob/src/client/admin_rpc.rs`, which is not cancellation-safe: if
the stdin arm wins while a notification frame is partially read, the
consumed bytes are lost and the next read starts mid-frame, producing a
`malformed server frame` error. Restructure so concurrent waiting cannot
lose partial frames — for example a persistent line buffer inside the
subscription reader that survives cancellation, or a single read task
that owns the reader and dispatches whole frames over a channel. The
approach is the developer's choice within S-008's constraint: no frame
may be lost, duplicated, or corrupted when stdin input and notifications
race, and the observable `call()`/`recv()`/`close()` semantics from B-008
(notification buffering during calls, close skipping notifications) must
be preserved.

## Acceptance Criteria

AC-1: WHILE a notification frame is partially received and the stdin arm
of the chat loop wins THE SYSTEM SHALL still deliver that notification
completely, without a malformed-frame error.

AC-2: WHEN notifications and `chat.send` responses interleave repeatedly
THE SYSTEM SHALL render every reply exactly once, in arrival order.

AC-3: The system shall preserve the existing observable subscription
semantics: notifications arriving during `call()` are buffered for
`recv()`, and `close()` skips notifications until the close response.

AC-4: The system shall keep all existing `bob` crate unit tests passing
without weakening their assertions.

## Dependencies

- `T-088` — modifies the same CLI chat file; land the params change first
  to avoid conflicting edits.

## Files to Touch

- `the-intern/service/crates/bob/src/client/admin_rpc.rs` —
  cancellation-safe frame reading for `Subscription`.
- `the-intern/service/crates/bob/src/cli/commands/chat.rs` — chat loop
  adjustments and tests covering the interleaving behaviour.

## Verification

```bash
cd the-intern/service && cargo test -p bob --lib && cargo fmt --all -- --check
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
