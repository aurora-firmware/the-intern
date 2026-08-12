---
id: T-168
title: Document bob init bootstrap workflow
status: pending
priority: medium
assigned-role: unassigned
created: '2026-08-12'
---

# Document bob init bootstrap workflow

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

Document the released `bob init` workflow after T-167. Replace the manual
workspace skill-copy procedure with the shared-install-path model, explain
the local files init creates, show the required manager-address follow-up,
and prominently describe the CR-007 permissive bootstrap policy and review
step. Keep the CLI reference generated from `bob --help` where applicable.

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

AC-1: WHEN an operator follows the quickstart THE DOCUMENTATION SHALL show
`bob init <workspace>` before serving or scheduling the initialized workspace.
AC-2: The system shall document that skills install once at bob's shared path
and that no workspace `.pi/skills` copy is created.
AC-3: The system shall state that the generated bootstrap policy permits all
arguments for `bash`, `read`, `write`, and `edit`, remains default-deny for
other tools, and must be reviewed and narrowed.
AC-4: WHEN the mdBook is built THE DOCUMENTATION SHALL render without errors.

## Dependencies

- `T-169` — end-to-end verified CLI spelling, output, and shared-skill behavior.

## Files to Touch

- `the-intern/docs/src/quickstart/index.md` — first-run instructions.
- `the-intern/docs/src/operator-guide/index.md` — deployment, permissions, and policy guidance.
- `the-intern/docs/src/cli-reference/index.md` — command reference integration.

## Verification

```bash
mdbook build the-intern/docs
```

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

### Session 1 — 2026-08-13
Updated the quickstart and operator guide for the released `bob init` flow: initialized local files, one shared skill installation, no workspace `.pi/skills`, the required manager-address follow-up, and the deliberately broad four-tool bootstrap policy that must be reviewed and narrowed. The email-triage deployment procedure now uses `bob init` rather than manual workspace assembly.

Updated the CLI-reference generator to include `init` and `schedule`. Also fixed its mdBook preprocessor invocation so the specified root-level `mdbook build the-intern/docs` works as well as a docs-directory build. Both completed successfully (with only the pre-existing mdbook-mermaid version warning).

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->
