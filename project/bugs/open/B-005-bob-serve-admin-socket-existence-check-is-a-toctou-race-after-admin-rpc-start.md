---
id: B-005
title: bob serve admin-socket existence check is a TOCTOU race after 
  admin_rpc::start()
severity: medium
status: open
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
