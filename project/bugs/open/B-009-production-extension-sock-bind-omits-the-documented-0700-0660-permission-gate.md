---
id: B-009
title: Production extension.sock bind omits the documented 0700/0660 permission 
  gate
severity: medium
status: open
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
