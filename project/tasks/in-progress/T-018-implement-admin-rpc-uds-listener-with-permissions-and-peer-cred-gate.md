---
id: T-018
title: Implement admin-rpc UDS listener with permissions and peer-cred gate
status: pending
priority: high
assigned-role: unassigned
created: '2026-05-16'
spec: S-001
---

# Implement admin-rpc UDS listener with permissions and peer-cred gate

## Description

Implement the Unix domain socket listener for `admin.sock` per S-002
§Component 4. Behaviour:

- Create the socket's parent directory with mode 0700 if missing.
- `unlink` any stale socket file at the configured path before binding.
- Bind the UDS, then `chmod` the socket to 0660 and apply optional
  `admin_allowed_gid` from config.
- Accept connections; for each new connection perform a peer-credentials
  check (`SO_PEERCRED` on Linux, `LOCAL_PEERCRED` on macOS).
- If the peer uid matches the service's uid or any uid in
  `cfg.admin_allowed_uids`, hand the connection to a per-connection task
  (the task body is filled in by T-019).
- Otherwise close the connection before any application frame is exchanged
  and emit `tracing::warn!` carrying the rejected uid.

## Acceptance Criteria

AC-1: The system shall provide `admin_rpc::listener::Listener::bind(cfg)` that binds a Unix domain socket at `cfg.admin_sock_path`, creating the parent directory with mode 0700 and the socket file with mode 0660.
AC-2: WHEN a client connects with a peer uid in `cfg.admin_allowed_uids` or equal to the service's own uid THE SYSTEM SHALL accept the connection and hand it to the per-connection task.
AC-3: IF a client connects with a peer uid not in the allowed set THEN THE SYSTEM SHALL close the connection before exchanging any application frames and emit a `tracing::warn!` event carrying the rejected uid and no payload bytes.
AC-4: WHEN the listener starts and a stale socket file is present at `cfg.admin_sock_path` THE SYSTEM SHALL `unlink` it before binding.

## Dependencies

- `T-011` — `admin-rpc` crate scaffold
- `T-015` — `BobConfig.admin_sock_path`, `admin_allowed_uids`, `admin_allowed_gid` populated

## Files to Touch

- `the-intern/service/crates/admin-rpc/src/listener.rs` — new
- `the-intern/service/crates/admin-rpc/src/peer_cred.rs` — new; Linux + macOS branches behind `#[cfg]`
- `the-intern/service/crates/admin-rpc/src/lib.rs` — touch; wire `Listener::bind` into `start`

## Verification

```bash
cd the-intern/service && cargo test -p admin-rpc listener
cd the-intern/service && cargo test -p admin-rpc peer_cred
```

## Work Log

## Review
