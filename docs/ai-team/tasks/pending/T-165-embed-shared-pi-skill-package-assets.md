---
id: T-165
title: Embed shared pi skill package assets
status: pending
priority: high
assigned-role: unassigned
created: '2026-08-12'
---

# Embed shared pi skill package assets

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

Embed the generated `the-intern/email-skills/.pi/skills` package in the bob
binary as the single runtime delivery asset for S-012. Expose a deterministic
asset list for the later init materializer; do not create a second checked-in
copy or change the canonical `email-skills/skills` source. Include unit
coverage proving the embedded package contains the three shipped skill roots
and the expected files.

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

AC-1: The system shall compile the generated pi package into bob from the
canonical repository package path without adding a maintained duplicate.
AC-2: WHEN the init materializer requests an embedded asset THE SYSTEM SHALL
provide its stable relative path and byte content.
AC-3: The system shall verify that the embedded asset set contains the
`himalaya`, `email-triage`, and `worklog` skill roots.

## Dependencies

- None.

## Files to Touch

- `the-intern/service/crates/bob/build.rs` — register build-time tracking and embedding inputs.
- `the-intern/service/crates/bob/src/init_assets.rs` — expose embedded skill assets and unit tests.
- `the-intern/service/crates/bob/src/lib.rs` — expose the internal asset module.

## Verification

```bash
cargo test -p bob init_assets
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
