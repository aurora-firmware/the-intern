---
id: T-106
title: Make bob chat a service-required launcher for the supervised interactive 
  pi session
status: pending
priority: high
assigned-role: developer
created: '2026-06-23'
spec: CR-002
---

# Make bob chat a service-required launcher for the supervised interactive pi session

## Description

Per CR-002 and the amended S-002, rewrite the `bob chat` CLI so it: (1) requires
the bob service to be running and fails with a clear error and non-zero exit if
it cannot connect to `admin.sock`; (2) opens a supervised interactive pi session
via the T-105 admin-RPC interaction and connects the user's terminal to it; (3)
exits when the pi session ends. Remove the old admin-socket chat REPL (the
`chat.open` / `chat.send` subscription loop) from the client. `bob chat` is no
longer a standalone pi launcher — it is a front-end to the running service.

## Acceptance Criteria

AC-1: WHEN `bob chat` runs and the service is reachable THE SYSTEM SHALL open a
      supervised interactive pi session and connect the user's terminal to it.

AC-2: IF the bob service is not running THEN THE SYSTEM SHALL exit with a clear
      error and a non-zero status, without launching a bare pi.

AC-3: WHEN the interactive pi session ends THE SYSTEM SHALL exit `bob chat`.

AC-4: The system shall remove the `chat.open` / `chat.send` subscription REPL
      from the `bob chat` client.

AC-5: The system shall pass `cargo test -p bob`.

## Dependencies

- `T-105` — the admin-RPC interactive-session open/attach interaction.

## Files to Touch

- `the-intern/service/crates/bob/src/cli/commands/chat.rs` — rewrite as the
  service-required launcher.
- `the-intern/service/crates/bob/src/client/admin_rpc.rs` — client support for
  the new interaction, if needed.

## Verification

```bash
cd the-intern/service && cargo test -p bob
```

## Work Log

<!-- Mandatory. Append one entry per session boundary. -->

### Session 1 — 2026-06-24

**What was done**

Rewrote `bob chat` as the client side of the `session.interactive.open` protocol
from T-105/ADR-011. The new implementation:

1. Connects directly to `admin.sock` (no AdminClient intermediary — raw socket
   access is needed for SCM_RIGHTS); if the socket is absent, returns a clear
   human-readable error without spawning pi (AC-2).
2. Sends `session.interactive.open` as a newline-delimited JSON-RPC 2.0 frame.
3. Reads frames until `session.interactive.await_fds` arrives (the sync
   notification that the server is now blocked in `recvmsg` and BufReader is
   quiesced).
4. Calls `sendmsg` via nix with `SCM_RIGHTS` carrying stdin/stdout/stderr fds
   and a 1-byte anchor payload.
5. Reads and validates the JSON-RPC success response.
6. Reads frames until `session.interactive.exited` arrives, then returns
   `Ok(())` (AC-3).

The entire old chat REPL — `ChatSubscription`, `ChatInputLines`, `StdinLines`,
`run_with_parts`, `run_with_parts_async`, `build_chat_send_params`,
`write_chat_notification` and all their tests — was removed (AC-4).

**Tests added (4 new)**

- `exits_with_clear_error_when_service_is_not_running` — AC-2: socket absent →
  error naming service/socket.
- `opens_interactive_session_and_exits_when_session_exits` — AC-1 + AC-3: full
  handshake with fake server, exits when `session.interactive.exited` received.
- `returns_service_down_when_server_closes_connection_before_exited` — AC-3
  negative: connection close before exited → error.
- `run_signature_matches_service_required_launcher` — AC-4: compile-time check
  that the old REPL types are gone.

**Scope expansion into `lib.rs` and `Cargo.toml`**

- `bob/src/lib.rs`: removed `#![forbid(unsafe_code)]` (replaced with a comment).
  The workspace-level `deny` still applies everywhere except the targeted
  `#[allow(unsafe_code)]` on `send_fds_via_scm_rights`. This mirrors the T-105
  `admin-rpc/src/lib.rs` treatment.
- `bob/Cargo.toml`: added `socket` and `uio` features to the existing `nix`
  dependency for `sendmsg`/`IoSlice` support.

`admin_rpc.rs` was not modified.

**What was tried and rejected**

Initially called `connect_admin()` first (to get the clear error message) then
dropped it and reconnected directly. This caused a double-connect race in tests
— the test server saw the first connection (dropped immediately) and wrote its
handshake to it, while the second real connection got nothing. Fixed by
connecting once directly and mapping the connection error locally in
`service_not_running_error()`, matching the same message style as the existing
`map_service_down_to_missing_socket` helper.

**Obstacles Encountered**

- `#![forbid(unsafe_code)]` in `bob/src/lib.rs` blocked the workspace-level
  `#[allow(unsafe_code)]` on `send_fds_via_scm_rights`. Solution: remove the
  crate-level `forbid` (workspace `deny` is still effective).
- `nix` `sendmsg` requires `socket` and `uio` features not present in
  `bob/Cargo.toml`. Added minimally.
- The test server consumes the SCM_RIGHTS anchor byte via `read()` — the
  ancillary fds are invisible to `tokio::io::split` reads (the kernel strips
  them). This is correct and expected; the test only needs to confirm the
  anchor byte was received before sending the response.

**What remains**

Nothing for this task.

Commit `3dfa07e` on branch
`task/T-106-make-bob-chat-a-service-required-launcher-for-the-supervised-interactive-pi-session`.
Evidence: `cargo test -p bob` 119 passed / 0 failed (unit) + integration suites
green; `cargo test --workspace` all crates green; `cargo fmt --all -- --check`
clean.

## Review

<!-- Reviewer: append verdict here after each review cycle. -->
