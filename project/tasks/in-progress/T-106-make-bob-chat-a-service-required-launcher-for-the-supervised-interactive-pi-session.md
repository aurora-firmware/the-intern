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

## Review

<!-- Reviewer: append verdict here after each review cycle. -->
