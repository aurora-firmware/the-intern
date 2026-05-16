---
id: T-025
title: Add end-to-end shell integration smoke test
status: pending
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

## Review
