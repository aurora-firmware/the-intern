---
id: ADR-011
title: Interactive chat brokers the client terminal to pi via SCM_RIGHTS 
  fd-passing
status: accepted
created: '2026-06-23'
---

# ADR-011: Interactive chat brokers the client terminal to pi via SCM_RIGHTS fd-passing

## Context

CR-002 makes `bob chat` launch a supervised, directly-launched interactive `pi`
session owned by `bob serve`. Verified during T-103 (against the pi-agent
version in use at the time; tested versions are recorded in the repository
`README.md`): interactive pi
is the default mode (an `ink` TUI) and **requires a real TTY** — it uses
`process.stdin.setRawMode` and checks `process.stdin.isTTY`, degrading to
non-interactive on plain pipes. So the service-spawned pi must be given a real
terminal, not pipes relayed over `admin.sock`.

`bob chat` (the client) holds the user's controlling terminal; `bob serve` (the
daemon) owns the supervised pi process. The two are separate processes connected
by `admin.sock` — a Unix-domain socket behind the 0700 trust boundary
(ADR-005 / ADR-007). The question: how does a daemon-owned interactive pi reach
the user's terminal?

## Decision

**`bob chat` passes its controlling-terminal file descriptors (stdin/stdout/
stderr — the user's real TTY) to `bob serve` over `admin.sock` using `SCM_RIGHTS`
ancillary-data fd-passing.** The pi-agent supervisor spawns the interactive pi
process with those received fds as its stdio (plus `--extension <bob.ts>`,
`BOB_SESSION_ID`, `BOB_EXTENSION_SOCK_PATH`). pi runs interactively on the user's
real terminal while being a child of `bob serve` — supervised, in the session
table, reaped on shutdown.

- bob allocates **no PTY** and relays **no terminal bytes** over the socket.
- The client does not put its own terminal in raw mode; pi sets raw mode on the
  shared TTY directly.
- Session control (open request, exit notification) still travels as JSON-RPC on
  `admin.sock`; only the three terminal fds cross as `SCM_RIGHTS` ancillary data.
- On pi exit or client disconnect, the service tears the session down (T-105) and
  closes the received fds.

## Consequences

### Positive

- pi gets the user's real TTY directly, so its `ink` TUI, raw mode, and window
  size all work natively with zero terminal emulation.
- No byte-relay loop and no PTY master/slave plumbing in bob; no SIGWINCH
  forwarding — the fd *is* the terminal, so resizes are seen directly.
- Keeps the single control-plane socket (ADR-007): `admin.sock` carries both the
  control RPC and the fd-passing ancillary data.
- Consistent with the trust model: fd-passing works only between processes that
  can already connect to the 0700 socket (the service-owner uid), so it adds no
  new trust surface (ADR-005 / ADR-008).

### Negative

- `SCM_RIGHTS` is Unix-only and lower-level (`sendmsg`/`recvmsg` with ancillary
  data); the admin-rpc transport must be extended to send/receive fds, which the
  current newline-delimited JSON-RPC framing does not yet do. Unix-only is
  acceptable (S-002 is Unix-only).
- The session's stdio *is* the client's terminal, so it is tied to that one
  client connection — no detach/reattach. Acceptable for interactive chat.
- The service holds child-process fds that originate from the client; teardown
  must close them so they do not leak.

### Neutral

- The RPC-worker spawn path (`--mode rpc`, piped stdio) is unchanged; this adds a
  second, interactive spawn path beside it.
- Does not affect admission (ADR-010): interactive chat remains gated by socket
  access + the `tool_call` membrane.

## Alternatives Considered

### Alternative A: SCM_RIGHTS fd-passing (chosen)

Described above.

### Alternative B: Service-allocated PTY + byte relay

**Description:** `bob serve` allocates a PTY, spawns pi on the slave, and relays
bytes between the PTY master and the `bob chat` client over `admin.sock`; the
client puts its own terminal in raw mode and forwards window-size changes.
**Rejected because:** it adds a byte-relay loop, PTY master/slave management,
client-side raw-mode handling, and explicit SIGWINCH/window-size forwarding —
substantially more code and failure modes than handing pi the real terminal
directly. Its only advantage (detach/reattach, multi-client) is not a CR-002
requirement. Retained as the upgrade path if detachable sessions are ever needed.
