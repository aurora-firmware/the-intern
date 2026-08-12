---
id: T-167
title: Wire bob init CLI command
status: pending
priority: high
assigned-role: unassigned
created: '2026-08-12'
---

# Wire bob init CLI command

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

Add `bob init <path> [--force]` to clap and route it to T-166's materializer.
Unlike service-dependent commands, init must bypass normal config loading,
telemetry initialization, and all admin-RPC communication so it works on a
machine with no config or running service. Render conflict messages, the
explicit broad-authority warning, and next steps for setting manager address,
starting serve, and reviewing/narrowing config.

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

AC-1: WHEN a user invokes `bob init <path>` THE SYSTEM SHALL parse the
required path and optional `--force` flag and invoke the materializer.
AC-2: WHILE dispatching `bob init` THE SYSTEM SHALL not load bob config,
initialize telemetry, or contact an admin socket.
AC-3: WHEN initialization succeeds THE SYSTEM SHALL print the generated paths,
the four-tool broad-authority warning, and actionable next steps.
AC-4: IF initialization refuses an existing live config THEN THE SYSTEM SHALL
return a non-zero command error that names the existing path.

## Dependencies

- `T-166` — tested workspace and config materializer.

## Files to Touch

- `the-intern/service/crates/bob/src/cli/mod.rs` — clap command definition and parser tests.
- `the-intern/service/crates/bob/src/cli/commands.rs` — init command facade.
- `the-intern/service/crates/bob/src/cli/commands/init.rs` — terminal rendering and command tests.
- `the-intern/service/crates/bob/src/lib.rs` — dispatch exception for the filesystem-only command.

## Verification

```bash
cargo test -p bob init
```

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

### Session 1 — 2026-08-12
Added `bob init <path> [--force]` clap parsing, a dedicated command module, and filesystem-only dispatch that bypasses config loading and telemetry. Success output names workspace, live-config, and shared-skill paths; lists materialization results; warns that unrestricted `bash`, `read`, `write`, and `edit` authority is broad; and gives manager-address, serve, and policy-review next steps. Tests cover parsing, output/conflict rendering, and the dispatch bypass.

The broad `cargo test -p bob init` filter also selected an unrelated existing scheduler test that failed with `ServiceDown`; exact T-167 test paths passed. The implementation leaves that unrelated failure out of scope.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->
