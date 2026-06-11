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

### Session 1 — 2026-06-11

Implemented T-089 in two TDD cycles.

**Cycle 1 (admin_rpc.rs):** The root cause is that `Subscription::recv()` called `read_value_frame()` which uses `AsyncBufReadExt::read_line` inside a `BufReader`. This is not cancellation-safe: when `tokio::select!` drops the `recv()` future mid-read, bytes already consumed by `read_line`'s internal state are discarded, leaving the next read to start mid-frame. The fix introduces `FrameReaderTask`: a background Tokio task that owns the `BufReader` and forwards complete frames over a bounded `mpsc::channel(64)`. All three methods (`recv`, `call`, `close`) now read from the channel via `next_frame()`. Channel receive is cancellation-safe: dropping the `.recv()` future only stops polling the channel end; the frame stays in the channel buffer for the next poll. The `notification_buffer` (a `VecDeque<Value>`) and all frame-dispatch logic in `call()` and `close()` are unchanged — only the read source changed. Two tests added: `subscription_recv_is_cancellation_safe_when_frame_arrives_in_parts` (AC-1, previously failing with `malformed server frame`) and `subscription_delivers_all_notifications_exactly_once_under_interleaving` (AC-2).

**Cycle 2 (chat.rs):** Added two integration tests using real Unix socket servers through the `run_with_parts_async` DI seam: `chat_loop_delivers_all_notifications_when_stdin_and_notifications_race` (notifications sent in halves to create a cancellation window, plus one buffered during `call()`; all three appear exactly once) and `chat_loop_close_skips_notifications_in_flight_after_close_request` (AC-3: a notification in flight after close does not appear).

**What was tried and rejected:** An earlier chat.rs test design used `FakeLines::from([Some("hello"), None])` — stdin ending with `None` immediately. This was flaky because when both stdin (`None`) and `recv()` (buffered notification) are simultaneously ready, `tokio::select!` picks randomly between them. Redesigned to use single-line stdin + permanent pending + stop signal for deterministic termination.

**What remains:** Nothing. All four acceptance criteria are covered by passing tests.

Evidence: `cargo test -p bob --lib` — 96 passed (92 pre-existing + 4 new), 0 failed; `cargo fmt --all -- --check` clean. Commits `0fad983` and `2348601` on `task/T-089-make-the-cli-chat-receive-loop-frame-safe-under-concurrent-send-and-stdin`.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->
