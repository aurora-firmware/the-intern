---
id: T-166
title: Implement init workspace and config materializer
status: pending
priority: high
assigned-role: unassigned
created: '2026-08-12'
---

# Implement init workspace and config materializer

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

Implement the filesystem-only S-012 materializer using T-165's assets. It
must install skills once at bob's shared XDG install path and create only
workspace-local context placeholders, `config/email-triage.toml`, and
`worklog/`. Generate the live loader config with its absolute shared install
path and CR-007's four broad named-tool rules. Keep all write, permission,
conflict, force, and `.git` safeguards in this module, with isolated-tempdir
tests; do not add clap or command dispatch yet.

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

AC-1: WHEN given a new relative or absolute workspace path THE SYSTEM SHALL
resolve it and materialize the shared skills plus workspace-local files with
Unix modes 0700 for directories and 0600 for generated files.
AC-2: WHEN generating a fresh live config THE SYSTEM SHALL use bob's resolved
XDG config location, an absolute shared skill install path, and exactly four
no-matcher action rules for `bash`, `read`, `write`, and `edit`.
AC-3: IF a generated workspace file exists without force THEN THE SYSTEM SHALL
leave it unchanged and report it; IF live config exists without force THEN THE
SYSTEM SHALL leave it unchanged and return an error.
AC-4: WHEN force is supplied THE SYSTEM SHALL replace only generated files and
shall never modify a target `.git` directory.
AC-5: The system shall verify that the generated bootstrap rules deny an
unsupported tool and that materialization opens no admin socket.

## Dependencies

- `T-165` — embedded shared pi-package assets.

## Files to Touch

- `the-intern/service/crates/bob/src/init_materializer.rs` — filesystem/config materializer and focused tests.
- `the-intern/service/crates/bob/src/config.rs` — expose shared XDG path resolution needed by the materializer without changing loader semantics.
- `the-intern/service/crates/bob/src/lib.rs` — expose the internal materializer module.

## Verification

```bash
cargo test -p bob init_materializer
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
