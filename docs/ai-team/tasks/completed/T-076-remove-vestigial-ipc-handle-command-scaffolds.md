---
id: T-076
title: Remove vestigial IPC handle command scaffolds
status: completed
priority: low
assigned-role: unassigned
created: '2026-05-22'
---

# Remove vestigial IPC handle command scaffolds

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

The original IPC actor scaffolds left two public handle methods that no real
caller uses: `admin_rpc::Handle::ping()` and
`extension_ipc::Handle::send_message()`. Both send a private command into their
actor and then return `ServiceError::NotImplemented`. The real production paths
are the admin Unix-socket listener / JSON-RPC dispatcher and
`extension_ipc::run_connection`; these handle methods only advertise fake
capability and keep dead command branches/tests alive.

Remove the vestigial command surfaces without changing the real listener or
connection behavior:

- Delete `admin_rpc::Handle::ping`, its private `Command::Ping` variant, the
  actor match branch, and the test that asserts it returns `NotImplemented`.
- Delete `extension_ipc::Handle::send_message`, its private
  `Command::SendMessage` variant, the actor match branch, and the test that
  asserts it returns `NotImplemented`.
- Keep each crate's existing `Config`, `Handle`, `Actor`, and `start()` shape
  intact so `bob::serve` startup/shutdown wiring does not change in this task.
- Do not remove or alter JSON-RPC method `NotImplemented` responses such as
  `sessions.kill`; this task is only about the unused handle command scaffolds.

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

AC-1: The `admin-rpc` crate shall no longer expose `Handle::ping`, define
      `Command::Ping`, or contain a test whose purpose is to assert that
      `ping()` returns `ServiceError::NotImplemented`.

AC-2: The `extension-ipc` crate shall no longer expose
      `Handle::send_message`, define `Command::SendMessage`, or contain a test
      whose purpose is to assert that `send_message()` returns
      `ServiceError::NotImplemented`.

AC-3: WHEN `bob::serve` starts the admin-rpc and extension-ipc actors THE
      SYSTEM SHALL preserve the existing `start(cfg) -> (Handle, JoinHandle)`
      integration shape and shutdown behavior.

AC-4: The system shall leave unrelated placeholder behaviour unchanged,
      including JSON-RPC methods that intentionally return
      `ServiceError::NotImplemented` when their backing subsystem handle is
      absent or the method is not implemented yet.

## Dependencies

- None — this is a cleanup task independent of T-073 through T-075.

## Files to Touch

- `the-intern/service/crates/admin-rpc/src/lib.rs` — remove the vestigial
  `ping` command surface and its test.
- `the-intern/service/crates/extension-ipc/src/lib.rs` — remove the vestigial
  `send_message` command surface and its test.

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

### Session 1 — 2026-05-22

Read the task file (Work Log was empty — first session). Examined both target files to understand the dead surfaces before touching anything.

Baseline verification. Ran `cargo test -p admin-rpc` (95 tests, all green) and `cargo test -p extension-ipc` (30 tests, all green) to confirm the starting state.

admin-rpc removal. Deleted `enum Command { Ping }`, the `Handle::ping` method, and the corresponding actor `match` branch. The actor's run loop became trivially `while self.rx.recv().await.is_some() {}`. Replaced the channel type with `mpsc::Sender/Receiver<std::convert::Infallible>` — no real commands exist, and using `Infallible` makes that explicit to the compiler. Added an `#[allow(dead_code)]` annotation on `Handle::tx` with a comment explaining it is kept solely to control the actor channel's lifetime (when all Handle clones drop, the channel closes and the actor exits cleanly). Removed the `ServiceError`/`ServiceResult` import from the crate root, and deleted the `handle_ping_returns_not_implemented` test.

extension-ipc removal. Same pattern: deleted `enum Command { SendMessage(String) }`, `Handle::send_message`, the actor match branch, and swapped to `Infallible` channel types. Removed the `bob_core::error::{ServiceError, ServiceResult}` import and deleted the `handle_send_message_returns_not_implemented` test.

What was considered and rejected. Considered leaving the private `Command` enum as an empty enum instead of replacing it with `Infallible`. Chose `Infallible` because it makes the "no commands can ever be sent" invariant machine-checked rather than relying on a naming convention.

Verification. After the changes: `cargo test -p admin-rpc` passes 94 tests (one removed), `cargo test -p extension-ipc` passes 29 tests (one removed), `cargo test --workspace` passes all tests with zero failures. No warnings on the two modified crates.

What remains. Nothing — all four acceptance criteria are satisfied. AC-1 and AC-2: dead surfaces gone. AC-3: `start(cfg) -> (Handle, JoinHandle<()>)` shape and `bob::serve` wiring are untouched. AC-4: unrelated JSON-RPC `NotImplemented` responses (e.g., `sessions.kill`) are unmodified.

Commit on `task/T-076-remove-vestigial-ipc-handle-command-scaffolds`:
- `3d2927e` removal of both vestigial command surfaces.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->

### Review Verdict — 2026-05-22

PASS

Both stages passed.

**Stage 1 — Spec compliance**

- AC-1: Confirmed. `Handle::ping`, `Command::Ping`, the actor match branch, and the `handle_ping_returns_not_implemented` test are all absent from `admin-rpc/src/lib.rs`. The `ServiceError`/`ServiceResult` import was also correctly removed. The commit reduces the file by 39 lines (net).
- AC-2: Confirmed. `Handle::send_message`, `Command::SendMessage`, the actor match branch, and the `handle_send_message_returns_not_implemented` test are all absent from `extension-ipc/src/lib.rs`. The `ServiceError`/`ServiceResult` import was also correctly removed. The commit reduces the file by 40 lines (net).
- AC-3: Confirmed. Both `start(cfg) -> (Handle, JoinHandle<()>)` signatures are unchanged. The `bob` crate was not modified in commit `3d2927e`. The channel now carries `std::convert::Infallible`, which is a sound choice — the compiler enforces that no commands can be sent, and the `Handle::tx` field is retained with an `#[allow(dead_code)]` annotation and explanatory comment so the RAII lifetime-based shutdown mechanism is preserved exactly as before.
- AC-4: Confirmed. Only the two files listed under "Files to Touch" were modified in commit `3d2927e`. The `admin-rpc/src/dispatch.rs` module — which contains the `sessions.kill` and other JSON-RPC `NotImplemented` responses — was not touched.
- No unspecified behavior or files added.

**Stage 2 — Code quality**

- Correctness: The `Infallible` channel pattern is correct. The actor run loop `while self.rx.recv().await.is_some()` terminates cleanly when the last `Handle` clone drops, exactly preserving the prior shutdown behavior. The unreachable-branch comment is accurate.
- Tests: `cargo test -p admin-rpc` passes 94 tests (1 removed). `cargo test -p extension-ipc` passes 29 tests (1 removed). `cargo test --workspace` passes all tests across every crate with zero failures or warnings on modified crates.
- Security: No issues. No credentials, no new permissions, no external input.
- Readability: The `#[allow(dead_code)]` annotation is paired with a clear comment explaining the lifetime-control intent. No dead code or debugging artifacts remain.
- Performance: No concerns. The actor loop is minimal and correct.
