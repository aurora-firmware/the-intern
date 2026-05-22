---
id: T-074
title: Remove the redundant in-service uid allow-list, leaving socket 
  permissions as the sole connection gate
status: pending
priority: medium
assigned-role: unassigned
created: '2026-05-22'
---

# Remove the redundant in-service uid allow-list, leaving socket permissions as the sole connection gate

<!--
Task Quality Rules (see the new-task skill for full details):
  - Atomic — one clear outcome.
  - One-shottable — ≤ 3–4 files touched, ≤ 5 ACs, Description ≈ 20 lines.
  - Verifiable — concrete Verification command or explicit manual steps.
  - Self-contained — Description is enough to start without follow-up questions.
  - EARS — every AC matches one of the five EARS patterns below.
  - Dependency-honest — list every prior task this one reads from or modifies.
-->

## Description

ADR-005 (`project/decisions/ADR-005-application-level-request-identity-is-self-asserted-within-the-local-socket-trust-boundary.md`)
decides that the socket's filesystem permissions are the sole transport trust
gate, and records the removal of the redundant in-service uid allow-list.

Today each IPC listener gates connections twice. The filesystem layer is the
real gate: the listener chmods the socket's parent directory to `0o700`
(owner-only) and the socket file to `0o660`, so the OS already restricts
connections to the service-owner uid. On top of that, `accept()` reads the peer
uid via `SO_PEERCRED` and checks `bob_core::auth::is_allowed` against a
configured `allowed_uids` list. Behind the `0o700` directory that allow-list is
unreachable for any non-owner uid — it only ever sees the service-owner uid,
which it always admits — so it enforces nothing the filesystem does not, while
carrying real code and config surface.

Remove the in-service allow-list so the filesystem permissions are the single
connection gate:

- Remove `bob_core::auth::is_allowed` and its tests. Keep `PeerCred` and
  `peer_cred_from_fd` — the peer uid/pid stays available as an optional audit
  signal.
- In both the `admin-rpc` and `extension-ipc` listeners, drop the allow-list
  check from `accept()` and the `gate_peer` test helper; a connection the OS
  allowed through is accepted.
- Remove every `allowed_uids` / `service_uid` field and its plumbing from the
  listener configs, the `admin-rpc` / `extension-ipc` `Config` types,
  `BobConfig` (raw, public, defaults), and `bob serve`.
- Update the documentation that describes the removed gate: the
  `crates/admin-rpc` line in `the-intern/service/README.md` and the
  socket-node labels in `user_diagrams.md`, so they describe the
  filesystem-permission gate rather than a peer-credential / peer-UID gate.

The socket `0o700` directory and `0o660` file modes MUST remain enforced on
every bind and stay covered by their existing permission tests — that is now
the entire connection gate. This task removes no behaviour beyond the redundant
check; it supersedes the peer-cred allow-list description in S-002 per ADR-005.

## Acceptance Criteria

<!-- EARS pattern reference. Every criterion must match one pattern:
  1. Ubiquitous            — The system shall [outcome]
  2. Event-driven          — WHEN [trigger] THE SYSTEM SHALL [outcome]
  3. Unwanted-behaviour    — IF [fault] THEN THE SYSTEM SHALL [outcome]
  4. State-driven          — WHILE [state] THE SYSTEM SHALL [outcome]
  5. Optional              — WHERE [feature included] THE SYSTEM SHALL [outcome]

Examples:
  AC-1: WHEN the user submits valid credentials THE SYSTEM SHALL
        redirect to /dashboard within 200ms.
  AC-2: IF the password is incorrect THEN THE SYSTEM SHALL return 401
        and display "Invalid credentials".
  AC-3: The system shall log every authentication attempt with user id
        and outcome.
-->

AC-1: The `bob_core::auth` module shall no longer provide a uid allow-list
      predicate — `is_allowed` and its `allowed_uids` / `service_uid`
      parameters shall be removed, while `PeerCred` and `peer_cred_from_fd`
      remain.

AC-2: WHEN the admin or extension listener accepts a connection THE SYSTEM
      SHALL admit it without consulting any in-service uid allow-list.

AC-3: The `BobConfig`, the `admin-rpc` / `extension-ipc` `Config` types, and
      both listener configs shall no longer carry uid allow-list or
      service-uid fields.

AC-4: The admin and extension listeners shall continue to create the socket
      parent directory at mode `0o700` and the socket file at mode `0o660`,
      verified by the existing permission tests.

AC-5: The `crates/admin-rpc` entry in `the-intern/service/README.md` and the
      socket-node labels in `user_diagrams.md` shall describe the connection
      gate as the socket's filesystem permissions, with no remaining reference
      to a peer-credential or peer-UID gate.

## Dependencies

- `T-073` — modifies `bob/src/config.rs` (adds the chat-client identity
  field); this task also edits `bob/src/config.rs` (removes the allow-list
  fields), so it must run after T-073 to avoid a file conflict.

## Files to Touch

- `the-intern/service/crates/bob-core/src/auth.rs` — remove `is_allowed` and
  its tests; keep `PeerCred` and `peer_cred_from_fd`.
- `the-intern/service/crates/admin-rpc/src/listener.rs` — remove the allow-list
  check from `accept()`, the `gate_peer` helper, and the `admin_allowed_uids` /
  `service_uid` fields of `ListenerConfig`; update tests.
- `the-intern/service/crates/admin-rpc/src/peer_cred.rs` — drop `is_allowed`
  from the re-export.
- `the-intern/service/crates/admin-rpc/src/lib.rs` — remove allow-list /
  service-uid fields from `Config` and the plumbing into `ListenerConfig`.
- `the-intern/service/crates/extension-ipc/src/listener.rs`,
  `.../src/peer_cred.rs`, `.../src/lib.rs` — the same removals for the
  extension listener.
- `the-intern/service/crates/bob/src/config.rs` — remove the `admin_allowed_uids`
  (and any `service_uid`) fields from `BobConfig`, its raw counterpart, and the
  defaults; update config tests.
- `the-intern/service/crates/bob/src/serve.rs` — stop threading allow-list /
  service-uid values into the listener configs.
- `the-intern/service/README.md` — reword the `crates/admin-rpc` description
  so it no longer calls the listener a "peer-credential gate".
- `user_diagrams.md` — reword the `admin.sock` / `extension.sock` node labels
  so they no longer say "peer UID gate".

## Verification

```bash
cd the-intern/service
cargo test -p admin-rpc
cargo test -p extension-ipc
cargo test --workspace
```

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

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->
