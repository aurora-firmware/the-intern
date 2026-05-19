---
id: B-005
title: bob serve admin-socket existence check is a TOCTOU race after 
  admin_rpc::start()
severity: medium
status: in-progress
created: '2026-05-19'
---

# bob serve admin-socket existence check is a TOCTOU race after admin_rpc::start()

## Summary

`bob/src/serve.rs:191-197` synchronously checks `cfg.admin_sock_path.exists()` immediately after `admin_rpc::start()`. The admin-rpc actor binds its UDS asynchronously inside the spawned task, so the existence check races: on a fast machine the bind has usually happened by the time we check, but there is no guarantee. Tests pass only because the worker child is `sh -c exit 0` (fast). Under high scheduler contention or a slower bind path, startup verification could spuriously report "admin socket missing" or proceed before the socket is ready.

## Reproduction Status

Status: confirmed by code review — no runtime flake observed yet because the race window is short and existing test load doesn't push it.

## Evidence

- Logs / stack traces / failing assertions: none — race window is small and inconsistent.
- Screenshots or recordings: none
- Failing command or test: n/a (latent race, not yet observed in CI)
- First diagnostic step if not yet reproduced: inspect `the-intern/service/crates/bob/src/serve.rs:191-197` and confirm the synchronous `Path::exists()` after `admin_rpc::start()`. Then inspect `admin-rpc/src/lib.rs` `start()` for the absence of a bind-complete signal.

## Reproduction Steps

1. Open `the-intern/service/crates/bob/src/serve.rs:191-197` and observe the pattern: `admin_rpc::start(cfg).await?; if !cfg.admin_sock_path.exists() { … }`.
2. Open `the-intern/service/crates/admin-rpc/src/lib.rs` `start()` and confirm the UDS bind happens inside the spawned actor task, not synchronously.
3. Conceptual repro: under high scheduler contention the bob check can run before the bind completes. Forcing the race requires injecting a delay before `UnixListener::bind` inside admin-rpc.

## Expected Behavior

Startup verification should await a readiness signal from `admin_rpc::start()` (e.g., `start` returns once the listener is bound, or exposes a ready channel) before claiming the socket is up.

## Actual Behavior

A synchronous `Path::exists()` check immediately after `start()` — no synchronisation with the async bind. The success of the check depends on scheduler timing.

## Environment

- OS / platform: Linux (Codex execution environment)
- Language / runtime version: Rust workspace under `the-intern/service` (rustc stable)
- Relevant dependencies: `bob`, `admin-rpc`, tokio
- Branch / commit: `dev-agent` post-merge of T-040 (`ceb872d`)

## Related

- Task: n/a
- Specification: bob serve startup sequencing (no dedicated spec; see `project/docs/system_overview.md`)

## Suspected Area

`the-intern/service/crates/bob/src/serve.rs` startup-verification sequence; and `crates/admin-rpc/src/lib.rs::start` not exposing a bind-complete signal.

## Fix Verification

```bash
cd the-intern/service
cargo test -p bob
cargo test -p admin-rpc
```

A future test that injects a slow bind inside `admin-rpc::start` should observe `bob::serve` waiting for readiness rather than failing the existence check.

## Diagnosis Log

<!-- Mandatory before implementation. Append one entry before changing production code. Format:
### Diagnosis N — YYYY-MM-DD
Reproduction status:
Evidence captured:
Isolated fault:
Root cause or fault hypothesis:
Planned verification:
-->

### Diagnosis 1 — 2026-05-19

**Reproduction status:** Confirmed by code review. Not reproducible at runtime without artificial scheduler delays.

**Evidence captured:**
- `admin_rpc::start()` (`crates/admin-rpc/src/lib.rs:397`) is synchronous: `pub fn start(cfg: Config) -> (Handle, JoinHandle<()>)`. Inside `start()`, `Listener::bind` is called on the current thread, not inside the spawned task. For AF_UNIX the inode is created before `start()` returns.
- The bug report's framing — "the UDS bind happens inside the spawned actor task" — is incorrect. Only `run_listener` (the accept loop) is spawned; bind completes synchronously.
- However: when `Listener::bind` fails, the `Err` is matched at lines 431-439, an error is logged, and `maybe_listener` is set to `None`. The error is then dropped. `start()` still returns `(Handle, JoinHandle<()>)`.
- `bob/src/serve.rs:191-197` detects this with `if !cfg.admin_sock_path.exists() { return Err(...); }` — a weak filesystem proxy.

**Isolated fault:** `admin_rpc::start` swallows `std::io::Error` from `Listener::bind` and unconditionally returns `(Handle, JoinHandle<()>)`. The caller cannot distinguish "started with listener" from "started without listener because bind failed" except by probing the filesystem.

**Root cause or fault hypothesis:** The `start()` signature has no error path, so there is no mechanism to surface a bind failure. The filesystem existence check is a contract workaround. The original TOCTOU framing is a secondary concern; the primary defect is the silently-swallowed bind failure.

**Planned verification:** Change `start()` to return `Result<(Handle, JoinHandle<()>), std::io::Error>`. Propagate the bind failure as `Err`; remove the `exists()` check in `bob::serve`. Add a regression test in `admin-rpc/src/lib.rs` that exercises an unwritable bind path and asserts `start()` returns `Err`. Run `cargo test -p admin-rpc && cargo test -p bob && cargo test --workspace`.

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

### Session 1 — 2026-05-19

After reading `admin-rpc/src/lib.rs::start`, `admin-rpc/src/listener.rs::bind`, and `bob/src/serve.rs::try_start_subsystems`, the actual defect is that `admin_rpc::start` swallows `Listener::bind` errors and returns a success-equivalent `(Handle, JoinHandle<()>)` tuple unconditionally — `bob::serve` detects failure only via `cfg.admin_sock_path.exists()`. The "async bind TOCTOU" framing was incorrect; the bind is fully synchronous.

Fix chosen: change `admin_rpc::start` to return `Result<(Handle, JoinHandle<()>), std::io::Error>` so bind failures propagate to `bob::serve`. Removed the `exists()` check entirely.

TDD:
- Wrote `start_returns_err_when_bind_fails_on_unwritable_path` first (red) — verifies the new error path.
- Changed the `start()` signature, propagated the `Listener::bind` failure with `?`, updated every call site in the `admin-rpc` test module to `.expect(...)`.
- Updated `bob::serve` to `admin_rpc::start(cfg).map_err(|e| format!(...))?`; removed the `cfg.admin_sock_path.exists()` block.

Rejected alternatives:
- Oneshot bind-ready channel — unnecessary indirection given the bind is already synchronous.
- Retry/sleep around the existence check — addresses a symptom, not the contract.

Evidence:
- `cargo test -p admin-rpc` — 79 passed, 0 failed (includes the new regression test).
- `cargo test -p bob` — 53 total passed, 0 failed.
- `cargo test --workspace` — green, 0 failures.

Commit `0357a62` on `bug/B-005-admin-socket-bind-readiness` — `fix(admin-rpc,bob): surface admin socket bind failure from start()`. Nothing remains for the next session.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that diagnosis, fix, verification, and code quality passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->
