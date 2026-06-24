---
id: T-105
title: Add admin-RPC interactive-session open/attach with stdio brokering
status: completed
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

### Review Verdict — 2026-06-24

PASS

**Stage 1 — Acceptance Criteria**

AC-1 (client request starts a supervised interactive pi session and brokers stdio): Met.
`handle_session_interactive_open` in `lib.rs` receives three terminal fds via
`SCM_RIGHTS` (`receive_interactive_fds`) and calls
`supervisor.start_interactive_session`. The connection test
`run_connection_session_interactive_open_starts_session_and_returns_session_id`
verifies an `ok:true` response with a non-empty `session_id` UUID.

AC-2 (pi exit notifies client and tears down session): Met. After a successful
start, `watch_interactive_session_exit` registers a oneshot watcher. The actor's
reap tick calls `poll_interactive_exits` (via `try_poll_exit`) to detect natural
child exits without blocking. The exit watcher fires `session.interactive.exited`
to the client. The connection test
`run_connection_session_interactive_exited_notification_delivered_when_pi_exits`
verifies delivery of this notification within the test timeout.

AC-3 (client disconnect terminates interactive pi session): Met. `read_loop`
tracks `active_interactive`; on any exit from the loop (EOF, error, shutdown) it
calls `supervisor.kill_session(session_id)`. The process remains in the pool while
the watcher is registered so `kill_session` can reach it. The connection test
`run_connection_client_disconnect_terminates_interactive_session` verifies the child
process is gone from `/proc/<pid>` after the client closes.

AC-4 (no pre-flight admission on interactive-session open path): Met. The dispatch
arm `handle_session_interactive_open` allocates a `SessionId` and returns
`InteractiveSessionOpening`; there is no call to `evaluate_admission`,
`admitted_users`, or any policy-control check. ADR-010 compliance confirmed by
code inspection.

AC-5 (`cargo test -p admin-rpc` passes): Met. 124 passed / 0 failed, verified
from a worktree checkout of commit `9229060` on the task branch.

**Flagged Items Assessed**

1. Workspace-wide lint relaxation (`unsafe_code`: forbid → deny): Acceptable within
   this task. The crate-level `#![forbid(unsafe_code)]` in `admin-rpc/src/lib.rs`
   was removed; the workspace policy was relaxed from `forbid` to `deny`. The
   `#[allow(unsafe_code)]` is scoped narrowly to the single function
   `receive_interactive_fds`. Two unsafe blocks exist there:
   `BorrowedFd::borrow_raw(fd)` (sound: `fd` is the raw fd of a live socket that
   outlives this synchronous call) and `OwnedFd::from_raw_fd(raw)` (sound:
   kernel-guaranteed valid fds from `SCM_RIGHTS` wrapped immediately). SAFETY
   comments are present and accurate. The relaxation from `forbid` to `deny` does
   not allow unsafe elsewhere — the workspace `deny` lint ensures any other `unsafe`
   block still triggers a compile error. No ADR is required: the decision scope is
   confined to this task, the rationale is fully documented in the Work Log, and the
   T-104 Work Log anticipated the need.

2. New wire-protocol step (`session.interactive.await_fds`): Acceptable and
   technically necessary. The BufReader/recvmsg race is real and confirmed by the
   Developer's C test: BufReader's `read()` silently discards ancillary data when it
   consumes the anchor byte. The `await_fds` synchronisation step is the correct fix.
   No spec change is needed — ADR-011 delegates the wire-level synchronisation detail
   to the implementation, and the protocol is documented clearly in comments.

3. Scope expansion into `pi-agent-supervisor`: Accepted as justified minimal
   necessity. The three modifications are tightly coupled to AC-2/AC-3 correctness:
   `try_poll_exit` (non-blocking exit check for AC-2), `register_interactive_exit_watcher`
   and `poll_interactive_exits` (polling-based exit detection without removing the
   process from the pool, which is the design fix that makes AC-2 and AC-3 coexist),
   and `kill_session` extended to handle interactive sessions (AC-3). Without these
   the exit watcher design described in the Work Log cannot function correctly. The
   original T-104 scope listed only admin-rpc, but the T-104 implementation had a
   design gap (taking the process out of the pool broke AC-3) that the Developer
   correctly identified and fixed minimally.

**Stage 2 — Code Quality**

Correctness: Logic is sound. The two-step `await_fds` protocol correctly quiesces
BufReader before `recvmsg`. The process stays in the pool across both the AC-2
watcher and AC-3 kill path. `poll_interactive_exits` fires the watcher and removes
the process atomically. `shutdown_all` fires all exit watchers before terminating to
avoid dangling receivers. FD leak on protocol violation (wrong count) is prevented
by wrapping all raw fds in `OwnedFd` before the count check.

Tests: Success path (AC-1), exit notification (AC-2), and client-disconnect
termination (AC-3) are each covered by an integration test. The dispatch-level
outcome (AC-4, with and without supervisor) is covered by two unit tests.

Security: No hardcoded secrets. No external input flows unvalidated into spawned
commands — `InteractiveSessionConfig` carries server-configured values only.
SCM_RIGHTS fds are wrapped in `OwnedFd` immediately with proper SAFETY justification.

Readability: Functions are focused and documented. Minor observation (non-blocking):
the comment at `lib.rs` inside the `Ok(exit_rx)` arm at approximately line 605 says
"Note: the watcher task moved the session out of the pool via `take_interactive_session`"
which is stale — the new design keeps the process in the pool. The behavior description
on the next lines is correct, only the mechanism statement is wrong. Does not affect
correctness; can be cleaned up in a follow-on task.

Performance: `spawn_blocking` is used correctly for the blocking `recvmsg` call.
`try_poll_exit` is non-blocking and called on the existing reap tick — no additional
timer or busy loop is introduced.

`cargo fmt --all -- --check`: clean (no output, exit 0).
`cargo test --workspace`: all test suites passed (27 test result lines, 0 failures).
