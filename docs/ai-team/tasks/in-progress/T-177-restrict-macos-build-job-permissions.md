---
id: T-177
title: Restrict macOS build job permissions
status: pending
priority: low
assigned-role: developer
created: '2026-08-16'
spec: S-013
---

# Restrict macOS build job permissions

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

The workflow-level `contents: write` permission is required by the release job,
but is inherited unnecessarily by `build-macos`. Restrict that job to
`contents: read`; checkout, Cargo build, and artifact upload do not need
repository-contents write permission.

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

AC-1: THE SYSTEM SHALL grant `build-macos` only `contents: read` permission.
AC-2: THE SYSTEM SHALL retain the existing workflow-level release permission and
      all macOS artifact packaging and upload behavior.

## Dependencies

- None

## Files to Touch

- `.github/workflows/deploy.yml` — set job-scoped read-only contents permission
- `.github/workflows/test_deploy_workflow.py` — add a regression assertion for that permission

## Verification

```bash
python .github/workflows/test_deploy_workflow.py
```

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

### Session 1 — 2026-08-16

Added a regression test requiring `build-macos` to declare `permissions: {contents: read}` and
also guarding the workflow-level `contents: write` required for release creation. The new test
first failed because `build-macos` had no permissions block. The minimal workflow update adds the
job-scoped read-only permission while preserving all macOS packaging/upload behavior. The workflow
regression suite then passed: 37 tests OK. Implementation commit: `740c91a`
(`fix(ci): restrict macos build job permissions`).

The task's `python` command was unavailable in this shell, so the equivalent `python3` command
was used. An unrelated untracked `.github/workflows/__pycache__/` remains untouched.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->
