---
id: T-032
title: Implement pi-agent RPC child process lifecycle
status: pending
priority: high
assigned-role: unassigned
created: '2026-05-18'
spec: S-001
---

# Implement pi-agent RPC child process lifecycle

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

Replace the supervisor placeholder with a small child-process abstraction for
RPC-mode pi-agent workers. Phase 2 workers are launched as the configured command
and arguments from T-031, which default to `pi --mode rpc`. Each worker must own
stdin, stdout, stderr handling, and termination.

This task only proves process lifecycle and RPC framing primitives. It should
not implement the session registry, warm-pool allocation, prompt routing, or
admin integration; those are follow-up tasks.

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

AC-1: WHEN the supervisor spawns an RPC worker THE SYSTEM SHALL start the configured command with the configured arguments and piped stdin, stdout, and stderr.
AC-2: IF the configured command cannot be spawned THEN THE SYSTEM SHALL return `ServiceError::ChildProcess` with safe detail text.
AC-3: WHEN a JSON command is sent to an RPC worker THE SYSTEM SHALL write exactly one JSON object followed by LF to the child stdin.
AC-4: WHEN an RPC worker emits LF-delimited JSON on stdout THE SYSTEM SHALL parse each record as a JSON value without treating non-LF Unicode separators as delimiters.
AC-5: WHEN an RPC worker is terminated THE SYSTEM SHALL first request normal child termination and then force-kill the process if it remains alive past the configured child termination deadline sourced from `BobConfig.shutdown_reap_deadline`.

## Dependencies

- `T-031` — supervisor process configuration

## Files to Touch

- `the-intern/service/crates/pi-agent-supervisor/src/process.rs` — new child-process lifecycle and JSONL framing helper
- `the-intern/service/crates/pi-agent-supervisor/src/lib.rs` — expose or wire the process helper as needed
- `the-intern/service/crates/pi-agent-supervisor/Cargo.toml` — add serde/serde_json or async-process dependencies only if needed

## Verification

```bash
cd the-intern/service && cargo test -p pi-agent-supervisor process
```

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
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->
