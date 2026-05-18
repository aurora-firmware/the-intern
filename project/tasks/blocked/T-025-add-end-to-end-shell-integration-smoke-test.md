---
id: T-025
title: Add end-to-end shell integration smoke test
status: blocked
priority: medium
assigned-role: unassigned
created: '2026-05-16'
spec: S-001
---

# Add end-to-end shell integration smoke test

## Description

Add an integration test under `the-intern/service/tests/` that drives the
entire shell loop end to end:

1. Create an ephemeral temp dir; compute `admin_sock_path` and
   `extension_sock_path` inside it; spawn `bob serve` as a child process with
   environment overrides pointing at those paths.
2. Wait up to 2 seconds for both socket files to appear.
3. Run `bob status` as a child process against the spawned server; assert
   exit code 0 and a non-empty status payload.
4. Run `bob sessions list --json` against the spawned server; assert exit
   code 0 and that the JSON output is an empty array.
5. Send `SIGTERM` to the spawned `bob serve`; assert it exits with code 0
   within `cfg.shutdown_drain_deadline`.
6. Assert both socket files are removed after exit.

The test is a smoke test, not a full coverage matrix — confidence that the
seven phase-1a tasks integrate end to end.

## Acceptance Criteria

AC-1: WHEN the integration test spawns `bob serve` pointed at an ephemeral socket path THE SYSTEM SHALL produce both `admin.sock` and `extension.sock` within 2 seconds.
AC-2: WHEN the test runs `bob status` against the spawned server THE SYSTEM SHALL exit with code 0 and print a non-empty status payload.
AC-3: WHEN the test runs `bob sessions list --json` THE SYSTEM SHALL exit with code 0 and print an empty JSON array.
AC-4: WHEN the test sends `SIGTERM` to the spawned `bob serve` THE SYSTEM SHALL exit with code 0 within the configured drain deadline and remove both socket files.

## Dependencies

- `T-017` — `bob serve` runtime
- `T-018` — admin.sock listener actually binds (so AC-1's 2-second appearance check can pass)
- `T-021` — extension.sock listener actually binds (so AC-1's 2-second appearance check can pass)
- `T-019` — `service.status` and `sessions.list` methods
- `T-024` — `bob status` and `bob sessions list` client subcommands

## Files to Touch

- `the-intern/service/tests/shell_e2e.rs` — new

## Verification

```bash
cd the-intern/service && cargo test --test shell_e2e
```

## Work Log

### Session 1 — 2026-05-18

Read the canonical task file and confirmed the Work Log was empty. Implemented a new end-to-end smoke test target (`shell_e2e`) in the Rust service workspace where Cargo resolves `--test` targets (`crates/bob/tests/`). The test spawns `bob serve` with ephemeral socket env overrides, waits up to 2 seconds for `admin.sock` and `extension.sock`, runs `bob status`, runs `bob sessions list --json`, sends SIGTERM, enforces shutdown deadline, and asserts socket cleanup.

Initial red failures were compile-level (feature-gated `nix` signal imports), then converted to runtime-level by switching to `kill -TERM` command and adding explicit timeouts for child command execution to avoid indefinite hangs. The deterministic failure is now AC-2: `bob status` times out against a running `bob serve`. Inspection found `serve` starts `admin-rpc` with default config (no listener path) while separately binding raw sockets, which leaves no RPC request handling on the bound admin socket path.

Since fixing that requires production-file changes outside T-025's test-only ownership, bug `B-001` was opened and the task was escalated for scope guidance. A process issue was also logged: the `new-bug` skill instructions are out of sync with the actual `ai-team bug new` CLI flags.

## Review

### Escalation — 2026-05-18

Problem: AC-2/AC-3 cannot pass with current runtime wiring under the task's file-ownership constraint.

Attempted: Implemented full smoke test, added deterministic command timeouts, reran verification with escalated socket-capable environment, and isolated behavior to serve/admin-rpc integration.

Failed because: `bob status` hangs even after sockets exist; fixing requires modifying production files outside the approved T-025 scope (`serve.rs` runtime wiring).

Architect guidance: Block T-025 against `B-001` and route the production fix through bug handling first. T-025 must not expand into prior runtime/admin-RPC wiring repair. After `B-001` merges, resume T-025 as a test-only task and verify with `cd the-intern/service && cargo test --test shell_e2e -- --nocapture`.
