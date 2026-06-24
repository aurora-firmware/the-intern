---
id: T-104
title: Add an interactive supervised pi-spawn mode to the pi-agent supervisor
status: completed
priority: high
assigned-role: developer
created: '2026-06-23'
spec: CR-002
---

# Add an interactive supervised pi-spawn mode to the pi-agent supervisor

## Description

Per CR-002 and ADR-011, add a second spawn mode to the pi-agent supervisor that
launches an **interactive** pi session (distinct from the `--mode rpc` worker)
**on terminal fds received from the client via `SCM_RIGHTS`** (mechanism A,
ADR-011), with `--extension <path>` (T-101) and the env contract
(`BOB_SESSION_ID`, `BOB_EXTENSION_SOCK_PATH`) set. The interactive session is tracked in the supervisor's session table so it
is visible to `sessions list` and is terminated on shutdown. This task is the
supervisor-side spawn + lifecycle only; wiring it to a client is T-105.

## Acceptance Criteria

AC-1: WHEN the supervisor is asked to start an interactive session THE SYSTEM
      SHALL spawn pi in interactive mode with `--extension <path>` and
      `BOB_SESSION_ID` / `BOB_EXTENSION_SOCK_PATH` set.

AC-2: WHILE an interactive session is running THE SYSTEM SHALL include it in the
      session table reported by `sessions list`.

AC-3: WHEN the service shuts down THE SYSTEM SHALL terminate active interactive
      sessions as part of child reaping.

AC-4: The system shall pass `cargo test -p pi-agent-supervisor`.

## Dependencies

- `T-101` — the `--extension` spawn argument and supervisor `Config` field.
- `T-103` — the verified pi interface and the brokering mechanism.

## Files to Touch

- `the-intern/service/crates/pi-agent-supervisor/src/lib.rs` — interactive-mode
  entry point + session-table tracking.
- `the-intern/service/crates/pi-agent-supervisor/src/process.rs` — interactive
  spawn on the received terminal fds (ADR-011).
- `the-intern/service/crates/pi-agent-supervisor/src/pool.rs` — lifecycle/reaping.

## Verification

```bash
cd the-intern/service && cargo test -p pi-agent-supervisor
```

## Work Log

<!-- Mandatory. Append one entry per session boundary. -->

### Session 1 — 2026-06-23

Implemented the supervisor-side interactive pi spawn mode as specified by T-104,
ADR-011 mechanism A, building on the extension-arg plumbing from T-101.

**What was done:**

Three complete TDD cycles were run in a single session, one per layer, then
integrated into a single commit after all cycles were green:

1. **`process.rs`** — Added `InteractiveProcessConfig` (command, args, deadline,
   session_id, extension_sock_path, extension_path) and `InteractiveProcess`
   which spawns the child on caller-supplied `OwnedFd` stdio fds rather than
   piped stdio. The spawn validates the extension file exists, sets
   `BOB_SESSION_ID` and optionally `BOB_EXTENSION_SOCK_PATH` on the environment,
   appends `--extension <path>` to the command line, and passes the three fds as
   stdin/stdout/stderr via `Stdio::from(OwnedFd)`. The `terminate()` method
   mirrors the existing RPC worker's graceful-then-forced termination. Three
   tests cover: env vars + extension arg on child, fail-closed when extension is
   missing, graceful SIGTERM.

2. **`pool.rs`** — Added `interactive_sessions: HashMap<SessionId,
   InteractiveProcess>` to `SessionPool`. `start_interactive_session` spawns the
   process and inserts it under its session_id. `list_sessions` was extended
   with `.chain(self.interactive_sessions.keys().copied())` so interactive and
   RPC sessions are reported together. `shutdown_all` drains
   `interactive_sessions` and calls `terminate()` on each, recording a new
   `interactive_sessions_terminated` counter added to `ShutdownReport` in
   `reaper.rs`. Two tests cover: list_sessions includes interactive session,
   shutdown_all terminates and counts it.

3. **`lib.rs`** — Added `StartInteractiveSession` variant to the `Command` enum
   carrying all the config fields plus the three `OwnedFd`s and a oneshot
   response channel. `Handle::start_interactive_session` sends the command and
   awaits the result. The actor's run loop handles it by constructing
   `InteractiveProcessConfig` and delegating to
   `pool.start_interactive_session`. Two tests cover: session id returned and
   visible in `list_sessions`, actor shutdown terminates the interactive child
   (verified via `/proc/{pid}` check).

**What was tried and rejected:**

- Considered using a separate `InteractiveSessionRequest` config struct for the
  Handle method to avoid `#[allow(clippy::too_many_arguments)]`. Rejected because
  T-105 will wrap this in a higher-level RPC handler anyway, and adding a pub
  struct solely to appease Clippy would be premature abstraction. The allow
  annotation explains why.
- Considered an `impl Drop for InteractiveProcess` that would kill the child.
  Rejected because the existing `RpcWorkerProcess` does not do this either, and
  lifecycle management is explicit through `terminate()`. Implicit drop-kills
  would break the graceful shutdown sequence.

**What remains:**

Nothing for T-104. T-105 wires the client side (SCM_RIGHTS receive over
admin.sock → fds → `start_interactive_session`). The
`Handle::start_interactive_session` API is ready for T-105 to call with
`OwnedFd` values it constructs from received raw file descriptors.

**Obstacles Encountered:**

- `#[workspace.lints.rust] unsafe_code = "forbid"` applies crate-wide, so
  `OwnedFd::from_raw_fd()` (unsafe) cannot be called inside the supervisor. This
  is intentional: T-105 (the SCM_RIGHTS receive path) will call it, and T-104
  only receives the already-constructed `OwnedFd`. `Stdio::from(OwnedFd)` is
  safe and works correctly for setting child stdio.
- Shell positional-arg test design: the test for `--extension` in child args
  needed care because `sh -c script arg0 arg1` makes `$0=arg0` (not the
  extension path). Used `$@` to print all positional args, which includes
  `--extension` and `<path>` appended by `spawn()`.

Committed as `33ac961` on branch
`task/T-104-add-an-interactive-supervised-pi-spawn-mode-to-the-pi-agent-supervisor`.
Evidence: `cargo test -p pi-agent-supervisor` 49 passed / 0 failed (up from 42);
`cargo fmt --all -- --check` clean; `cargo build -p bob` clean.

## Review

<!-- Reviewer: append verdict here after each review cycle. -->

### Review Verdict — 2026-06-23

PASS

Both stages passed.

**Stage 1 — Acceptance Criteria**

- AC-1 MET: `InteractiveProcess::spawn` appends `--extension <path>` to the
  command line, sets `BOB_SESSION_ID` unconditionally, and sets
  `BOB_EXTENSION_SOCK_PATH` when `extension_sock_path` is non-empty. The
  fail-closed guard on the extension file is present. Three process-level tests
  verify the env contract and the missing-extension error path.

- AC-2 MET: `SessionPool::list_sessions` chains `active_workers` keys with
  `interactive_sessions` keys. The actor propagates the result unchanged.
  Tests at both pool and actor level confirm the returned session ID appears in
  `list_sessions` immediately after `start_interactive_session`.

- AC-3 MET: `SessionPool::shutdown_all` drains `interactive_sessions` and calls
  `terminate()` on each, recording the count in
  `ShutdownReport::interactive_sessions_terminated`. The actor's `run()` loop
  invokes `shutdown_all()` when the command channel closes. Tests at both
  layers verify SIGKILL-based reaping via pid-file checks.

- AC-4 MET: `cargo test -p pi-agent-supervisor` on branch `task/T-104-...`
  passes 49 tests, 0 failed (up from 42 on dev-agent). `cargo fmt --all --
  --check` and `cargo build -p bob` both clean.

**Stage 2 — Code Quality**

No issues. The terminate path mirrors the existing `RpcWorkerProcess` pattern.
The `try_wait` race guard in the deadline arm is correct. Tests are independent,
use unique names, and cover success and failure paths. The `#[allow(clippy::too_many_arguments)]`
annotation is explained and justified. Only the four specified files were
modified; `OwnedFd::from_raw_fd` (unsafe) stays correctly deferred to T-105.

Minor observation (non-blocking): `total_process_count()` in `pool.rs` counts
only warm + active RPC workers, so interactive sessions do not consume
`max_processes` quota. This appears intentional — interactive sessions use a
separate allocation path — and is consistent with the task scope.
