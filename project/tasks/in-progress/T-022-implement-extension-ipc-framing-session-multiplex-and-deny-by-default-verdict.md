---
id: T-022
title: Implement extension-ipc framing session multiplex and deny-by-default verdict
status: pending
priority: high
assigned-role: unassigned
created: '2026-05-16'
spec: S-001
---

# Implement extension-ipc framing session multiplex and deny-by-default verdict

## Description

On top of T-021's listener, implement the S-001 extension-channel schema (the
single Unix socket carries two message families on the same framed
connection, both tagged by session id):

- **Authorization request** — `{ kind: "authz", session: <SessionId>, tool, arguments, user }` — receives a `PolicyVerdict { allow: false, reason: Some("policy not implemented") }` placeholder reply tagged with the same session id (Phase 4 fills the real path).
- **Event for monitoring** — `{ kind: "event", session: <SessionId>, payload: ... }` — forwarded to the `MonitoringHandle` and not acknowledged on the wire.

A multiplexer maintains a per-session map (`SessionId` → connection write
half). The actor never confuses two sessions: a frame whose session id is
unknown but well-formed is forwarded based on its tag alone; a frame missing
the session id or failing to parse closes the connection with
`tracing::warn!`.

## Acceptance Criteria

AC-1: WHEN the extension sends an authorization-request frame tagged with a session id THE SYSTEM SHALL respond on the same connection with a `PolicyVerdict { allow: false, reason: Some(_) }` tagged with that same session id.
AC-2: WHEN the extension sends an event frame tagged with a session id THE SYSTEM SHALL forward it to the configured `MonitoringHandle` and not send a reply on the wire.
AC-3: IF a frame fails to parse or is missing the session id field THEN THE SYSTEM SHALL close the connection and emit `tracing::warn!` without echoing any payload bytes.
AC-4: WHILE the extension-ipc actor is running, frames from distinct sessions on the same connection shall not be cross-delivered to other sessions' reply channels.

## Dependencies

- `T-021` — UDS listener and per-connection task entry point
- `T-008` — `SessionId`, `PolicyVerdict`
- `T-012` — `monitoring` scaffold (MonitoringHandle target)

## Files to Touch

- `the-intern/service/crates/extension-ipc/src/framing.rs` — new; session-tagged frame codec
- `the-intern/service/crates/extension-ipc/src/multiplex.rs` — new; per-session routing + deny-by-default reply
- `the-intern/service/crates/extension-ipc/src/lib.rs` — touch; wire framing + multiplex into per-connection task

## Verification

```bash
cd the-intern/service && cargo test -p extension-ipc framing
cd the-intern/service && cargo test -p extension-ipc multiplex
```

## Work Log

### Session 1 — 2026-05-17

Implemented T-022 in three TDD cycles on `task/T-022-implement-extension-ipc-framing-session-multiplex-and-deny-by-default-verdict` while keeping lifecycle files untouched on the task branch. First cycle added `framing.rs` with newline-delimited JSON parsing/encoding and tests for session-tagged authz parsing, required-session enforcement, and verdict frame encoding. Second cycle added `multiplex.rs` with a per-session route map and tests for deny-by-default authz replies, no-wire-reply event forwarding, and session-isolated reply routing to prevent cross-delivery. Third cycle wired `lib.rs` connection handling to parse framed input, dispatch through multiplexer, emit deny verdict replies on the same connection/session, forward events to the configured monitoring handle, and close connections on malformed/missing-session frames with warning logs.

I initially tried Tokio `AsyncBufReadExt`/`AsyncWriteExt` + timeout-based tests, but rejected that approach because this crate's enabled Tokio features do not include `io-util`/`time`. I replaced it with readiness-based `try_read`/`try_write` socket handling and spin/yield test helpers, which stayed within existing crate features and preserved behavior requirements.

Remaining work on implementation branch: none for this task's acceptance scope. Remaining process work is loop/reviewer lifecycle handling on `dev-agent`.

Evidence:
- `cd the-intern/service && cargo test -p extension-ipc framing` passed.
- `cd the-intern/service && cargo test -p extension-ipc multiplex` passed.
- `cd the-intern/service && cargo test -p extension-ipc connection_` passed for authz reply, event no-reply, and malformed/missing-session close behavior.

Obstacles Encountered:
- Tokio feature mismatch (`io-util`/`time` not enabled in `extension-ipc`), which broke the first connection I/O implementation and timeout-based tests; worked around by using socket readiness plus `try_read`/`try_write` with yield-based polling helpers.

## Review
