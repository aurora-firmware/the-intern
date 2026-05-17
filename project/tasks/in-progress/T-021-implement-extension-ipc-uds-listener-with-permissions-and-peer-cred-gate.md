---
id: T-021
title: Implement extension-ipc UDS listener with permissions and peer-cred gate
status: pending
priority: high
assigned-role: unassigned
created: '2026-05-16'
spec: S-001
---

# Implement extension-ipc UDS listener with permissions and peer-cred gate

## Description

Same pattern as T-018, applied to `extension.sock` per S-002 §Component 5 and
S-001 §Component 1. Behaviour:

- Create parent directory with mode 0700.
- `unlink` any stale socket file.
- Bind UDS, `chmod` 0660.
- Accept connections; perform peer-credentials check (Linux `SO_PEERCRED` /
  macOS `LOCAL_PEERCRED`).
- The JS extension and the service always run under the same uid in v1; the
  default allowed set is just the service's own uid (no override needed
  unless `extension_allowed_uids` is set in config).
- Allowed connections are handed to a per-connection task; the task body is
  filled in by T-022.
- Rejected connections are closed before any application frame is exchanged.

## Acceptance Criteria

AC-1: The system shall provide `extension_ipc::listener::Listener::bind(cfg)` that binds a Unix domain socket at `cfg.extension_sock_path`, creating its parent directory with mode 0700 and the socket file with mode 0660.
AC-2: WHEN a connection's peer uid equals the service's uid THE SYSTEM SHALL accept the connection and hand it to the per-connection task.
AC-3: IF a connection's peer uid does not match the service's uid (or a configured allow-list) THEN THE SYSTEM SHALL close the connection before exchanging any application frames and emit `tracing::warn!`.
AC-4: WHEN the listener starts and a stale socket file is present at `cfg.extension_sock_path` THE SYSTEM SHALL `unlink` it before binding.

## Dependencies

- `T-011` — `extension-ipc` crate scaffold
- `T-015` — `BobConfig.extension_sock_path` populated

## Files to Touch

- `the-intern/service/crates/extension-ipc/src/listener.rs` — new
- `the-intern/service/crates/extension-ipc/src/peer_cred.rs` — new; Linux + macOS branches
- `the-intern/service/crates/extension-ipc/src/lib.rs` — touch; wire `Listener::bind` into `start`

## Verification

```bash
cd the-intern/service && cargo test -p extension-ipc listener
cd the-intern/service && cargo test -p extension-ipc peer_cred
```

## Work Log

## Review
