---
id: T-024
title: Implement bob client subcommands status sessions audit chat policy
status: pending
priority: high
assigned-role: unassigned
created: '2026-05-16'
spec: S-001
---

# Implement bob client subcommands status sessions audit chat policy

## Description

Replace the "not implemented" placeholders in `bob::cli::commands` (created in
T-014) with real implementations that drive `AdminClient` from T-023.
Subcommands and their server methods:

- `bob status` → `service.status`.
- `bob sessions list` → `sessions.list`.
- `bob sessions kill <id>` → `sessions.kill`.
- `bob audit tail` → `audit.tail.subscribe` (streams notifications, prints
  each until Ctrl-C, then `audit.tail.unsubscribe` on exit).
- `bob chat [--session <id>]` → `chat.open` (streams `chat.message`
  notifications, reads stdin lines and forwards each as `chat.send`).
- `bob policy reload` → `policy.reload`.

Every command supports the global `--json` flag: when set, output a single
JSON document per response (and one JSON document per notification for
streaming commands) instead of human-readable text. Connection errors yield a
single-line stderr message naming the missing socket and exit code 1.

## Acceptance Criteria

AC-1: WHEN `bob status` is invoked against a running `bob serve` THE SYSTEM SHALL print a human-readable status block to stdout and exit with code 0.
AC-2: WHEN `bob sessions list` is invoked against a running `bob serve` THE SYSTEM SHALL print the session list returned by the server.
AC-3: WHEN `bob audit tail` is invoked THE SYSTEM SHALL print each audit notification received from the server until interrupted by SIGINT, then exit with code 0 after sending `audit.tail.unsubscribe`.
AC-4: WHEN any command is invoked with `--json` THE SYSTEM SHALL emit one JSON document per server response or notification to stdout instead of the human-readable rendering.
AC-5: IF `bob serve` is not running (admin socket absent) THEN any non-serve subcommand SHALL exit with code 1 and print a single-line stderr message naming the missing socket path.

## Dependencies

- `T-023` — `AdminClient` and `Subscription`

## Files to Touch

- `the-intern/service/crates/bob/src/cli/commands.rs` — touch; dispatch to individual command handlers
- `the-intern/service/crates/bob/src/cli/commands/status.rs` — new
- `the-intern/service/crates/bob/src/cli/commands/sessions.rs` — new
- `the-intern/service/crates/bob/src/cli/commands/audit.rs` — new
- `the-intern/service/crates/bob/src/cli/commands/chat.rs` — new
- `the-intern/service/crates/bob/src/cli/commands/policy.rs` — new

## Verification

```bash
cd the-intern/service && cargo test -p bob cli::commands
# manual: with `bob serve` running, run `bob status` and `bob sessions list --json` and confirm output.
```

## Work Log

## Review
