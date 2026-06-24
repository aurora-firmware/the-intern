---
id: T-105
title: Add admin-RPC interactive-session open/attach with stdio brokering
status: pending
priority: high
assigned-role: developer
created: '2026-06-23'
spec: CR-002
---

# Add admin-RPC interactive-session open/attach with stdio brokering

## Description

Per CR-002 and ADR-011, add the admin-RPC interaction by which a client opens a
supervised interactive pi session (T-104). The handler **receives the client's
controlling-terminal fds over `admin.sock` via `SCM_RIGHTS`** (mechanism A) and
hands them to the supervisor's interactive spawn (T-104); the admin-rpc transport
must be extended to receive fds (ancillary data), which the current
newline-delimited JSON-RPC framing does not yet do. The
handler performs **no pre-flight admission** — interactive chat is exempt
(ADR-010); socket access (the 0700 gate) is the only transport gate. On client
disconnect or pi exit, the session is torn down.

## Acceptance Criteria

AC-1: WHEN a client requests an interactive session over `admin.sock` THE SYSTEM
      SHALL start a supervised interactive pi session (T-104) and broker its
      stdio to the client.

AC-2: WHEN the pi session exits THE SYSTEM SHALL notify the client and tear down
      the brokered session.

AC-3: WHEN the client disconnects THE SYSTEM SHALL terminate the associated
      interactive pi session.

AC-4: The system shall not perform pre-flight policy admission on the
      interactive-session open path (ADR-010).

AC-5: The system shall pass `cargo test -p admin-rpc`.

## Dependencies

- `T-104` — the supervisor interactive-spawn mode this handler drives.

## Files to Touch

- `the-intern/service/crates/admin-rpc/src/lib.rs` — register the new method /
  outcome.
- `the-intern/service/crates/admin-rpc/src/dispatch.rs` — the open/attach handler
  and stdio brokering.

## Verification

```bash
cd the-intern/service && cargo test -p admin-rpc
```

## Work Log

<!-- Mandatory. Append one entry per session boundary. -->

### Session 1 — 2026-06-24

**What was done**

Implemented T-105 (admin-RPC interactive-session open/attach with stdio
brokering) end-to-end. The implementation covers AC-1 through AC-4 plus AC-5
(all 124 `cargo test -p admin-rpc` tests pass).

**Supervisor infrastructure (pi-agent-supervisor)**

Added `InteractiveProcess::try_poll_exit()` — a non-blocking `try_wait()`
wrapper that allows the actor's existing reap tick to detect natural child
exits without taking ownership of the process. Added
`SessionPool::register_interactive_exit_watcher` and
`SessionPool::poll_interactive_exits` to the pool. The key design decision: the
process stays in `interactive_sessions` after a watcher is registered, so
`kill_session` can still terminate it (AC-3). The reap tick calls
`poll_interactive_exits` on every tick; when a watched child has exited it
fires the registered oneshot sender (AC-2) and removes the entry.

Changed `WatchInteractiveSessionExit` in the actor from
`take_interactive_session` + background-wait-task to
`register_interactive_exit_watcher`. The earlier design removed the process
from the pool, which meant `kill_session` on client disconnect always returned
`InvalidRequest` and left the child running.

**Admin-RPC handler (admin-rpc)**

Added `DispatchOutcome::InteractiveSessionOpening { id, session_id }` and the
`"session.interactive.open"` dispatch arm in `dispatch.rs`. The handler
performs no pre-flight admission (AC-4). In `lib.rs`: added
`InteractiveSessionConfig` (spawn-parameter struct), `receive_interactive_fds`
(SCM_RIGHTS receiver), `handle_interactive_session_opening` (the main handler),
and `active_interactive` tracking in `read_loop` for AC-3.

**The critical protocol insight — await_fds synchronisation**

The initial attempt sent the JSON-RPC request then immediately sent the
SCM_RIGHTS fds. It failed. Root cause confirmed by a standalone C test: on
`SOCK_STREAM` Unix domain sockets, `BufReader` calls `read()` (not `recvmsg`)
to fill its internal buffer. If the anchor byte of the SCM_RIGHTS `sendmsg` is
consumed by that `read()`, the kernel silently discards the ancillary fds. The
client (on a separate tokio worker thread) can send both messages before the
server's `BufReader` does its first read, so the `read()` grabs the JSON frame
+ SCM_RIGHTS anchor byte together. Fix: the server sends a
`session.interactive.await_fds` notification BEFORE calling
`spawn_blocking(recvmsg)`. The client reads this notification first, then sends
the SCM_RIGHTS message; by then the server's BufReader is quiesced (blocked in
`spawn_blocking`), so `recvmsg` reliably receives the ancillary fds.

**`unsafe_code` forbid→deny change**

Changed `[workspace.lints.rust] unsafe_code` from `"forbid"` to `"deny"` in
`the-intern/service/Cargo.toml`. This was necessary to allow a targeted
`#[allow(unsafe_code)]` on the `OwnedFd::from_raw_fd` call in
`receive_interactive_fds`. The unsafety is limited to that one site: `recvmsg`
returns kernel-guaranteed valid new fds, and we wrap each immediately in
`OwnedFd` so they are closed on drop. The T-104 Work Log anticipated this need.
Scope is as narrow as possible — the rest of admin-rpc and all other crates
remain effectively under `"deny"`. **The Reviewer should scrutinise this
workspace-wide policy relaxation.**

**Files touched outside the stated scope**

- `the-intern/service/Cargo.toml` — workspace lint change (explained above).
- `pi-agent-supervisor/src/{lib,pool,process}.rs` — minimal additions to enable
  AC-2 + AC-3 coexistence; the dispatch path strictly required the supervisor's
  exit-watch API, which had to be corrected to not remove the process from the
  pool.
- `admin-rpc/Cargo.toml` — nix features `uio`, `poll` for the recvmsg path.

**What remains**

Nothing for this task. The client-side `bob chat` launcher is T-106 and out of
scope.

**Obstacles Encountered**

- BufReader/SCM_RIGHTS race on `SOCK_STREAM`: BufReader's `read()` silently
  discards ancillary data when it reads the anchor byte in the same syscall as
  the JSON frame. Confirmed by C test. Fixed by the `await_fds` synchronisation
  notification. A zero-byte `sendmsg` is also silently dropped on Linux
  `SOCK_STREAM` (confirmed by C test) — a 1-byte anchor is required.
- AC-2/AC-3 ownership conflict: the original `WatchInteractiveSessionExit` used
  `take_interactive_session` (removed the process from the pool), so
  `kill_session` on disconnect returned `InvalidRequest` and left the child
  running. Fixed by keeping the process in the pool and using polling-based exit
  detection via the reap tick.
- Reap tick frequency for AC-2: the default `idle_reap_timeout` (300s) is too
  slow for test timeouts. The test helper sets `idle_reap_timeout = 50ms` for
  prompt exit detection.

Commits `ff5a5ad` (supervisor exit watcher) and `9229060` (admin-rpc
session.interactive.open) on branch
`task/T-105-add-admin-rpc-interactive-session-open-attach-with-stdio-brokering`.
Evidence: `cargo test -p admin-rpc` 124 passed / 0 failed; `cargo fmt --all --
--check` clean; `cargo test --workspace` all crates green.

## Review

<!-- Reviewer: append verdict here after each review cycle. -->
