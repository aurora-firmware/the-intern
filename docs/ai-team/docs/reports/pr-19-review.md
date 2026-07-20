# PR Review: aurora-firmware/the-intern#19 — Fix/16 bob chat

## Summary

This PR fixes B-008 (GitHub issue #16): `bob chat` failed on the first message
with `-32602 chat.send requires params.id` because the client never sent the
chat subscription id and dispatched `chat.send` on a fresh admin connection
instead of the subscription's own connection. The fix adds
`Subscription::subscription_id()` and `Subscription::call()` (with
notification buffering drained by `recv()`) and routes `chat.send` through the
subscription connection, plus a regression test, three new socket-level tests,
and the B-008 process record. The fix is correct, well-tested, and matches the
server contract; the id-allocation scheme is collision-free and the updated
tests preserve their prior coverage. **2 findings, both suggestions** —
adjacent pre-existing gaps worth a follow-up, not blockers.

| Scope | Files | Lines changed | Tier | Findings |
|---|---|---|---|---|
| source | 2 | 445 | full | 2 |
| documentation | 2 | 241 | full | 0 |
| security | 0 | — | — | 0 |

## Findings

### Source

#### [suggestion] `close()` still races interleaved notifications; the new skip loop is only applied in `call()` — `the-intern/service/crates/bob/src/client/admin_rpc.rs:149`

This PR adds notification skipping/buffering to `Subscription::call()`, but
`Subscription::close()` (lines 195–232, unchanged) still reads exactly one
frame after writing the close request and fails with `close response id
mismatch` if that frame is a notification. The race is real on any
subscription where the server streams notifications: a notification written
after the client sends the close request but before the close response sits
ahead of the response in the read buffer. Today this is most reachable via
`bob audit tail` (audit forwarders stream notifications on the same
connection and share this `close()`), and it will hit `bob chat` as soon as
chat reply notifications are wired up (currently `open_chat` in
subscriptions.rs drops the bus receiver, so chat pushes nothing yet). The
B-008 record's review section already acknowledges this as pre-existing.
Since this PR introduces exactly the needed machinery, extending it is a
small, contained change: in `close()`, loop with `is_notification(&frame)`
and discard notification frames until the frame with `close_request_id`
arrives.

#### [suggestion] `params.session` sent by the client is silently ignored by the server — `the-intern/service/crates/bob/src/cli/commands/chat.rs:212`

`build_chat_send_params` (rewritten here, with new tests asserting the
`session` key) includes `"session": session_id` in `chat.send` params, but
the server's `handle_chat_send` in
`the-intern/service/crates/admin-rpc/src/dispatch.rs` reads only `params.id`,
`params.text`, `params.application_identity`, and `params.context_id` — never
`params.session`. Likewise `handle_chat_open` takes no params at all, so the
`{"session": id}` sent on `chat.open` is also dropped. Net effect: `bob chat
--session X` succeeds but session routing is a no-op end to end. This
predates the PR, but since this change is specifically about making
`chat.send` params match what the server validates — and the new tests now
pin the dead field — it's worth either mapping the CLI session to the
server's `context_id`, implementing `params.session` server-side, or filing a
follow-up so `--session` doesn't silently do nothing.

### Documentation

No findings. The B-008 bug record was verified claim-by-claim against the
working tree and git history: all pre-fix file/line references, the exact
server error string and code, the five named tests, commit `56549bc`, and the
frontmatter/location/verdict consistency all check out. The new
`ai-process-cli-reported-issues.md` entry correctly references the matching
2026-05-18 and 2026-05-20 entries.

## Skipped files

None — all 4 changed files were reviewed.

## Review notes

- **Tiers:** both non-empty scopes exceeded the lite threshold and were
  reviewed at `full` tier with surrounding-code context (the PR head is
  checked out locally), including the server-side `dispatch.rs` contract and
  the unchanged `close()`/`parse_call_response` paths.
- **Security:** no files were security-flagged — the change is confined to a
  client of the local Unix-socket admin RPC; no dependency, workflow, or
  trust-boundary changes.
- **Existing comments respected:** three review comments already on the PR
  (cancellation-safety of `recv()` inside `tokio::select!`, removable
  `#[allow(clippy::too_many_arguments)]`, and the `is_notification`
  server-initiated-request edge) were excluded from findings.
- Both findings above were verified by reading the actual implementations
  (`close()` at admin_rpc.rs:195–232, `handle_chat_open`/`handle_chat_send`
  at dispatch.rs:254–360) before being kept; both describe pre-existing
  behavior adjacent to — not introduced by — this PR, hence `suggestion`
  severity.
- Not run: the test suite (the bug record and reviewer verdict report 434
  workspace tests passing on the branch).
