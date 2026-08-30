---
id: T-194
title: Add end-to-end bob worklog coverage without a running service
status: pending
priority: medium
assigned-role: developer
created: '2026-08-30'
---

# Add end-to-end bob worklog coverage without a running service

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

Adds integration tests that exercise the real `bob` binary with no
`bob serve` running, in the style of the existing `bob task` cases in
`crates/bob/tests/non_serve.rs`
(`task_new_creates_board_and_task_without_an_admin_socket`,
`task_show_path_succeeds_without_an_admin_socket_and_finds_the_ancestor_board`).
Use the existing `bob_command_with_temp_state` helper and per-test
`tempfile::tempdir()` working directories set with `.current_dir(...)`.

Cover the cross-invocation guarantees the S-015 Contract makes that
in-crate unit tests cannot — in particular that carried-forward reporting
and idempotency hold across **separate process invocations** sharing a
working directory:

- `bob worklog append` in a directory `bob init` never touched creates
  `worklog/` and today's file and exits 0.
- `bob worklog list` in the same directory reads that entry back.
- `bob worklog list` in a directory with no `worklog/` exits non-zero and
  names the missing directory.
- With a hand-written prior-day worklog file containing an open item, a
  `bob worklog list` for a later day carries that item forward and reports
  it in the output.
- A second `bob worklog append` on the same day does not add a second
  carried-forward copy of that item.

## Acceptance Criteria

AC-1: WHEN `bob worklog append` runs in a fresh temp directory with no
`worklog/` and no admin socket THE SYSTEM SHALL exit 0 and create
`<dir>/worklog/<today>.md` containing the entry.

AC-2: WHEN `bob worklog list` runs in that same directory THE SYSTEM SHALL
exit 0 and print the entry just written.

AC-3: IF `bob worklog list` runs in a temp directory that has no `worklog/`
THEN THE SYSTEM SHALL exit non-zero and name the `worklog/` path it
expected.

AC-4: WHEN a prior-day file with an open item exists and `bob worklog list`
runs for a later day THE SYSTEM SHALL show a carried-forward entry for that
item and report it in the carried-forward set.

AC-5: WHEN `bob worklog append` is invoked twice for the same day after a
carry-forward THE SYSTEM SHALL leave exactly one carried-forward entry for
that item in today's file.

## Dependencies

- `T-192` — `bob worklog append`
- `T-193` — `bob worklog list`

## Files to Touch

- `the-intern/service/crates/bob/tests/non_serve.rs` — add `bob worklog` integration cases

## Verification

```bash
cd the-intern/service && cargo test -p bob --test non_serve
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
