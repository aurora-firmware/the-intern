---
id: T-187
title: Scaffold the board directory and install the tasks skill in bob init
status: in-progress
priority: medium
assigned-role: developer
created: '2026-08-23'
spec: S-014
---

# Scaffold the board directory and install the tasks skill in bob init

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

CR-009 amends S-012 so `bob init` creates an empty board directory in the
workspace it scaffolds, alongside `worklog/`, with the same owner-only protection
every other directory it creates has. Fixing the resolution point at the
workspace root means every session spawned with a working directory inside that
workspace attaches to the same board, rather than creating one wherever that
session happened to run.

The board directory holds operator and agent work product rather than files this
command owns, so `--force` must never remove or replace anything inside it; an
existing directory at that path is skipped and named in the warnings. S-012's
existing rule is that `--force` "may overwrite only files owned by this command",
and the board is the first thing `bob init` creates that it deliberately does not
own afterwards — so that guarantee needs its own test rather than riding along
with directory creation.

`bob init` must not become a precondition: `bob task` continues to work in a
directory `bob init` never touched.

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

AC-1: WHEN `bob init` scaffolds a workspace THE SYSTEM SHALL create an empty
board directory with mode `0700` on Unix and write no file into it.
AC-2: IF `--force` is supplied while the board directory already contains task
files THEN THE SYSTEM SHALL leave every one of them unchanged.
AC-3: WHEN `bob init` runs THE SYSTEM SHALL install the `tasks` skill tree at the
shared install path alongside the existing three.
AC-4: WHILE no workspace has been scaffolded THE SYSTEM SHALL still allow a board
to be created by `bob task`.

## Dependencies

- `T-186` — the fourth skill tree must exist to be installed, and this task extends the same integration test.
- `T-182` — the board directory this creates must be the one the resolver finds.
- `T-179` — modifies the same materializer file, and the renamed package must already be in place.

## Files to Touch

- `the-intern/service/crates/bob/src/init_materializer.rs` — create the board directory; exempt its contents from `--force`.
- `the-intern/service/crates/bob/tests/init_e2e.rs` — cover creation, the `--force` guarantee, and the installed skill set.

## Verification

```bash
(cd the-intern/service && cargo test -p bob --test init_e2e)
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
