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

## Review

<!-- Reviewer: append verdict here after each review cycle. -->
