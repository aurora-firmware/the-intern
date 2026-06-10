---
id: B-008
title: 'Invalid request when calling bob chat — chat.send requires params.id (GitHub
  issue #16)'
severity: high
status: in-progress
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

### Diagnosis 1 — 2026-06-10

Reproduction status:
Live end-to-end reproduction was not attempted because the `pi` binary at `/home/daneel/.npm-global/bin/pi` is a different tool (an npm global), not the pi-agent prerequisite required by CLAUDE.md. The defect is fully confirmed by code inspection and is unambiguous.

Evidence captured:
1. `build_chat_send_params` (`the-intern/service/crates/bob/src/cli/commands/chat.rs`, lines 200–213) builds params containing only `session`, `text`, and `application_identity`. The `id` field (the chat subscription id) is never included.
2. `handle_chat_send` (`the-intern/service/crates/admin-rpc/src/dispatch.rs`, lines 344–352) unconditionally requires `params.id` to be present and to reference an open chat subscription in the per-connection `ConnectionRegistry`. When `params.id` is absent it returns JSON-RPC -32602 with message `"chat.send requires params.id"` — the exact error string from the bug report.
3. `call_admin` (`the-intern/service/crates/bob/src/cli/commands.rs`, lines 62–68) creates a brand-new `AdminClient` (i.e., a new Unix socket connection) for every `chat.send` call. The `chat.open` subscription was established on a different connection (`connect_admin` at chat.rs line 92). The server's `ConnectionRegistry` is per-connection, so even if `params.id` were added, the id would reference a subscription on a different connection, causing a second error: `"params.id does not reference an open chat subscription on this connection"`.
4. `Subscription<N>` (`the-intern/service/crates/bob/src/client/admin_rpc.rs`, lines 93–174) holds both `reader` and `writer` for the subscription's connection and exposes only `recv()` and `close()`. The `subscription_id` field is private and there is no `call()` or `send()` method on it, so there is no way to send additional requests on the subscription's own connection.
5. The existing unit test `chat_opens_with_session_and_sends_each_input_line` uses a fake `send_chat` closure that does not validate params against the server protocol, so it passes despite the missing `id` field and the wrong-connection problem.

Isolated fault:
There are two coupled faults, both on the client side:
- **Fault A — missing `params.id`**: `build_chat_send_params` never reads or forwards the subscription id returned by `chat.open`.
- **Fault B — split-connection**: `chat.send` is dispatched via `call_admin`, which dials a fresh connection, while `chat.open` lives on the `Subscription`'s connection. The server validates that the subscription id belongs to the calling connection, so `chat.send` must travel over the same connection as `chat.open`.

Root cause or fault hypothesis:
The `Subscription<N>` API was built to support only streaming (recv) and teardown (close). The `chat` command needed a bidirectional use of the same connection — open, then send messages on it, then close — but no call path was implemented. `run_with_parts_async` was wired to use two independent closures (`open_chat` and `send_chat`) with no connection sharing; `send_chat` was connected to `call_admin`, which dials a new socket. As a result the subscription id is unknown to the send path and the connection check on the server is guaranteed to fail.

The fix must: (1) expose the subscription id from `Subscription<N>` (or add a `call` method to send requests on the subscription's connection), and (2) rewrite the `chat.send` path to send on the subscription connection with the correct id rather than opening a new connection.

Planned verification:
- Write a unit test for `build_chat_send_params` (or the send closure in `run_with_parts`) that asserts the emitted params include `id` matching the subscription id returned by `chat.open`.
- Write a unit test for `run_with_parts_async` where the fake `send_chat` closure asserts that `params["id"]` equals the id returned by the fake `open_chat`.
- Optionally add an integration test using a real Unix socket fake server that exercises the full `chat.open` → `chat.send` round-trip on the same connection.
- `cargo test -p bob` must pass with all new tests green.

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
