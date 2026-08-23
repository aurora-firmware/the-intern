---
id: T-179
title: Rename the runtime skills package directory and update code references
status: pending
priority: high
assigned-role: developer
created: '2026-08-23'
spec: S-014
---

# Rename the runtime skills package directory and update code references

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

CR-010 renames `the-intern/email-skills/` to `the-intern/bob-skills/`. The
package holds domain-free skills — `worklog` by S-011's design, and `tasks` once
S-014 lands — so its email-oriented name no longer describes what it is: the set
of runtime skills bob supplies to every session it spawns.

Move the tree with `git mv` so history follows, then update every executable
reference. Three Rust files resolve the package by path and will fail to build or
test otherwise: `build.rs` embeds it at a relative path, `init_assets.rs` asserts
the embedded source directory's path suffix, and `init_materializer.rs` resolves
the example email configuration through it. The pi packaging test asserts
repository-relative paths into the package.

Documentation references are deliberately out of scope here — T-180 and T-181
handle them. Historical artifacts keep the old name: completed tasks, resolved
bugs, and progress reports record what was true when written and must not be
rewritten.

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

AC-1: The system shall locate the runtime skills package at
`the-intern/bob-skills/`, with no `the-intern/email-skills/` path remaining in
the working tree.
AC-2: WHEN the bob crate is built and tested THE SYSTEM SHALL resolve, embed, and
assert the package under its new path.
AC-3: WHEN the pi packaging test is run THE SYSTEM SHALL pass against the renamed
package.
AC-4: The system shall leave completed tasks, resolved bugs, and progress reports
that reference the old name unmodified.

## Dependencies

- `T-178` — the Claude target must be deleted first, so the rename never touches files that are about to be removed.

## Files to Touch

- `the-intern/email-skills/` → `the-intern/bob-skills/` — move the tree with `git mv`.
- `the-intern/service/crates/bob/build.rs` — update the relative package path.
- `the-intern/service/crates/bob/src/init_assets.rs` — update the asserted source-directory suffix.
- `the-intern/service/crates/bob/src/init_materializer.rs` — update the example-config path.
- `the-intern/bob-skills/test_package_pi_skills.sh` — update the asserted repository-relative paths.

## Verification

```bash
(cd the-intern/service && cargo test -p bob)
./the-intern/bob-skills/test_package_pi_skills.sh
! test -e the-intern/email-skills
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
