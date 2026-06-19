---
id: B-009
title: Production extension.sock bind omits the documented 0700/0660 permission 
  gate
severity: medium
status: in-progress
created: '2026-06-13'
---

# Production extension.sock bind omits the documented 0700/0660 permission gate

## Summary

ADR-005 states that *each* listener creates its socket inside a parent directory
it chmods to `0o700` and sets the socket file to `0o660`, making the
owner-only directory the trust gate. This holds for `admin.sock` but **not** for
`extension.sock`: the production `bob serve` path binds the extension socket
directly with a raw `tokio::net::UnixListener::bind`, without creating/chmodding
the parent directory or the socket file. A correctly-gated extension listener
exists in `extension-ipc` but is not used by `bob serve`. If the configured
`extension_sock_path` resolves under a directory whose mode permits other local
accounts (and the socket's own mode is group/other-accessible), a process under
a *different* local uid can connect to the channel that carries `tool_call`
authorization verdicts and forwarded events — which is exactly what the `0700`
parent-directory gate exists to prevent. ADR-008 scopes whom bob *serves*; it
does not guarantee the machine has no other local accounts or service uids, so
the exposure is conditional on the actual parent/socket modes, not eliminated by
the single-user scope. This is a real divergence from the documented security
invariant (ADR-005) and an asymmetry with `admin.sock`.

## Reproduction Status

Status: confirmed (by code inspection)

The production bind path does not call any directory/socket `set_permissions`.

## Evidence

- `the-intern/service/crates/bob/src/serve.rs:257` — extension socket bound via
  `UnixListener::bind(&cfg.extension_sock_path)` with no parent-dir creation, no
  `0o700` chmod, and no `0o660` socket chmod.
- `the-intern/service/crates/admin-rpc/src/listener.rs:44-64` — the admin
  listener *does* create the `0o700` parent and chmod the socket `0o660` (the
  intended pattern). Its tests assert these modes at `:161-180`.
- `the-intern/service/crates/extension-ipc/src/listener.rs:24,33` — a correctly
  gated extension listener exists (`0o700` parent, `0o660` socket) but is not on
  the `bob serve` path.
- ADR-005 §Context/Decision — "Each listener creates the socket in a parent
  directory it chmods to `0o700` … and sets the socket file to `0o660`."

## Reproduction Steps

1. Configure `extension_sock_path` to a path whose parent is an existing
   world-traversable directory.
2. Run `bob serve`.
3. Stat the extension socket's parent directory and the socket file.
4. Observe the parent is not forced to `0700` and the socket is not `0660`,
   unlike `admin.sock`.

## Expected Behavior

The production `extension.sock` bind enforces the same gate as `admin.sock`:
owner-only (`0o700`) parent directory and `0o660` socket file, per ADR-005.

## Actual Behavior

`bob serve` binds `extension.sock` with a raw `UnixListener::bind`; the parent
directory and socket file retain whatever modes the umask/existing directory
provide. The documented owner-only gate is not guaranteed.

## Environment

- OS / platform: Linux/macOS (Unix-likes)
- Language / runtime version: Rust workspace (`the-intern/service`)
- Relevant dependencies: tokio UnixListener
- Branch / commit: observed on `dev-agent` at `f588a6c` and PR #22 head

## Related

- Specification: `S-002-bob-service-shell-architecture.md` (two-socket gate
  model), `ADR-005` (filesystem-permission trust gate), `ADR-007` (control
  plane records this asymmetry as tracked here).

## Suspected Area

`the-intern/service/crates/bob/src/serve.rs` extension-socket bind. Likely fix:
route the production extension bind through the gated `extension-ipc` listener
(or replicate its `0o700`/`0o660` setup), and unlink any stale socket first as
`admin-rpc` does.

## Fix Verification

```bash
# After binding, the extension socket's parent dir is 0700 and the socket is 0660.
cargo test -p extension-ipc
# Add/confirm an integration assertion mirroring admin-rpc listener.rs:161-180
# against the bob serve extension bind path.
```

## Diagnosis Log

<!-- Mandatory before implementation. Append one entry before changing production code. Format:
### Diagnosis N — YYYY-MM-DD
Reproduction status:
Evidence captured:
Isolated fault:
Root cause or fault hypothesis:
Planned verification:
-->

### Diagnosis 1 — 2026-06-19

**Reproduction status:** Confirmed by code inspection and direct mode observation.
No running process is required to reproduce because the fault is structural: the
production bind path never calls `set_permissions`.

**Evidence captured:**

1. `the-intern/service/crates/bob/src/serve.rs` line 185-191: `extension_ipc::start()`
   is called with `..extension_ipc::Config::default()`, which sets
   `extension_sock_path` to `PathBuf::new()` (empty). Because
   `extension-ipc/src/lib.rs` line 211 skips the gated listener when the path is
   empty, the `extension-ipc::Listener::bind()` (which applies `0o700`/`0o660`) is
   never called on the production path.
2. `the-intern/service/crates/bob/src/serve.rs` lines 256-265: The production code
   then falls through to `tokio::net::UnixListener::bind(&cfg.extension_sock_path)`
   — a raw bind with no parent-directory creation, no `0o700` chmod on the parent,
   and no `0o660` chmod on the socket file.
3. Direct simulation: with a `0o755` parent directory and umask `0022`, a plain
   `bind()` produces a socket file with mode `0o755` (group and other traversable).
   This confirms the exposure described in ADR-005.
4. `the-intern/service/crates/extension-ipc/src/listener.rs` lines 18-36: The gated
   `Listener::bind()` correctly applies `create_dir_all` + `set_permissions(0o700)`
   on parent, removes stale socket, binds, then `set_permissions(0o660)` on the
   socket. Its tests at lines 96-129 assert both modes. This code is correct but
   unused by `bob serve`.
5. `the-intern/service/crates/admin-rpc/src/listener.rs` lines 44-74:
   `admin_rpc::Listener::bind()` applies the identical `0o700`/`0o660` pattern via
   `admin_rpc::start()`, called correctly from `serve.rs` lines 242-247.
6. All existing serve tests (30 unit + 2 shell e2e) pass. No existing test asserts
   extension socket or parent directory permissions.

**Isolated fault:** Two-part fault in `the-intern/service/crates/bob/src/serve.rs`:
- **Fault A (line 185-191):** `extension_ipc::start()` receives an empty
  `extension_sock_path` because `..extension_ipc::Config::default()` is used instead
  of supplying `cfg.extension_sock_path`. This silently bypasses the gated
  `extension-ipc::Listener::bind()`.
- **Fault B (lines 256-265):** A separate, duplicate, ungated raw
  `UnixListener::bind()` is issued for `cfg.extension_sock_path` to satisfy the
  `_extension_listener` field in `Runtime`. This bind has no permission gates.

**Root cause or fault hypothesis:** The production serve path was written as if the
extension socket would be bound by a second explicit `UnixListener::bind` call in
`serve.rs` (stored in `Runtime::_extension_listener`), while the
`extension_ipc::start()` call was left with an empty `extension_sock_path`. The
security-gated path in `extension-ipc::Listener::bind()` therefore never executes
for the production socket. The fault is a missed wiring: `cfg.extension_sock_path`
was not forwarded to `extension_ipc::Config`, and the fallback raw bind has no
permission logic.

**Planned verification:**
- `cargo test -p extension-ipc` — gated bind behavior unchanged.
- New integration test in `serve.rs`: after `start_subsystems` with a
  world-traversable parent directory, stat the extension socket's parent and confirm
  mode `0o700`, and stat the socket file and confirm mode `0o660` — mirroring
  `admin-rpc/src/listener.rs:161-180`.
- `cargo test --workspace` — full suite passes.

**Planned fix:** Two coordinated changes to `serve.rs`: (1) forward
`cfg.extension_sock_path.clone()` into the `extension_ipc::start()` config so the
gated `extension-ipc::Listener::bind()` is invoked; (2) remove the separate raw
`UnixListener::bind(&cfg.extension_sock_path)` call and the
`_extension_listener: UnixListener` field from `Runtime`, since the `extension-ipc`
listener already holds the bound, gated socket.

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
- For PASS: brief confirmation that diagnosis, fix, verification, and code quality passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->
