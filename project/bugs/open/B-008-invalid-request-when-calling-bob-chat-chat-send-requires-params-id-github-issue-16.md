---
id: B-008
title: 'Invalid request when calling bob chat — chat.send requires params.id (GitHub
  issue #16)'
severity: high
status: open
created: '2026-06-10'
---

# Invalid request when calling bob chat — chat.send requires params.id (GitHub issue #16)

## Summary

Running `bob chat` against a running `bob serve` instance fails on the first
message with `invalid request: server returned error response: code=-32602,
message=chat.send requires params.id`. The chat client never includes the chat
subscription id in its `chat.send` requests, so an interactive chat session
cannot be used at all. Reported by the user in GitHub issue #16.

## Reproduction Status

Status: confirmed

Confirmed by the reporter's logs in GitHub issue #16 and by code inspection:
the client-side `chat.send` parameter builder has no `id` field, while the
server-side handler unconditionally requires one.

## Evidence

- Logs / stack traces / failing assertions: from issue #16 —
  `invalid request: server returned error response: code=-32602, message=chat.send requires params.id`
- Failing command or test: `bob chat` (with `bob serve` running and the bob
  extension loaded in pi agent)
- Code inspection:
  - `the-intern/service/crates/bob/src/cli/commands/chat.rs` —
    `build_chat_send_params` builds only `session`/`text`/`application_identity`,
    never `id`.
  - `the-intern/service/crates/admin-rpc/src/dispatch.rs` (`handle_chat_send`) —
    requires `params.id` to be a valid subscription id that references an open
    chat subscription **on the same connection** (`registry.is_open_chat_subscription`).
  - `chat.rs` `run()` sends `chat.send` via `call_admin`, which opens a **new**
    admin-socket connection per call, while the `chat.open` subscription lives
    on a different connection. Even with `params.id` added, a `chat.send` on a
    fresh connection would be rejected with "params.id does not reference an
    open chat subscription on this connection".
  - `the-intern/service/crates/bob/src/client/admin_rpc.rs` — `Subscription<N>`
    consumes the connection's reader/writer and only exposes `recv()`/`close()`;
    it keeps `subscription_id` private and offers no way to issue calls on the
    subscription's own connection.

## Reproduction Steps

1. Make sure the bob extension is loaded in pi agent.
2. Start the server: `bob serve &`
3. Start an interactive session: `bob chat`
4. Type any message line. The client exits with the -32602 error.

## Expected Behavior

`bob chat` opens a chat subscription and each typed line is delivered to the
chat adapter via `chat.send`; responses stream back as notifications and are
printed to stdout.

## Actual Behavior

The first `chat.send` is rejected by the server:
`invalid request: server returned error response: code=-32602, message=chat.send requires params.id`
and the chat session terminates.

## Environment

- OS / platform: Linux (auroralab)
- Language / runtime version: Rust workspace in `the-intern/service`
- Relevant dependencies: pi agent with bob extension loaded
- Branch / commit: main @ d203e81

## Related

- GitHub issue: #16
- Task: n/a
- Specification: n/a

## Suspected Area

Client side of the admin RPC chat flow:
- `the-intern/service/crates/bob/src/cli/commands/chat.rs` (missing `params.id`,
  `chat.send` issued on a separate connection from the `chat.open` subscription)
- `the-intern/service/crates/bob/src/client/admin_rpc.rs` (`Subscription` API has
  no way to send requests on the subscription's connection)

The server-side validation in `admin-rpc/src/dispatch.rs` appears to implement
the intended contract; the client was never finished to match it.

## Fix Verification

```bash
# Unit/integration tests for the chat client path
cargo test -p bob

# Manual end-to-end check (requires pi agent with bob extension):
# bob serve &
# bob chat   # type a line; expect no -32602 error and a streamed response
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
-->
