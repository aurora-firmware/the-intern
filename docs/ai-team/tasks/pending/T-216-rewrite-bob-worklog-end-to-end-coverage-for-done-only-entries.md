---
id: T-216
title: Rewrite bob worklog end-to-end coverage for Done-only entries
status: pending
priority: high
assigned-role: developer
created: '2026-09-21'
---

# Rewrite bob worklog end-to-end coverage for Done-only entries

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

`crates/bob/tests/non_serve.rs`'s worklog block invokes `bob worklog
append` with `--left`/`--next` throughout and asserts `- Left:`/`- Next:`
content in both text and JSON output; `T-215` removes both flags. Rewrite
these invocations and assertions to the `--item`/`--done` shape, and add
coverage that a call still passing `--left`/`--next` is rejected (S-015
Contract). Existing coverage this change does not touch (fresh-directory
creation, missing-`worklog/`-directory error on `list`) is kept as-is, only
dropping any `Left`/`Next`-specific assertions it happens to make.

## Acceptance Criteria

AC-1: WHEN `bob worklog append` is invoked twice for the same item the same
day with identical `--done` values THE SYSTEM SHALL leave exactly one
entry for that item-identifier in today's file, and the second invocation's
output shall report the write as suppressed.

AC-2: WHEN `bob worklog append` is invoked twice for the same item the same
day with different `--done` values THE SYSTEM SHALL leave two entries for
that item-identifier in today's file.

AC-3: WHEN `bob worklog append` is invoked with `--left` or `--next` THE
SYSTEM SHALL exit non-zero with an unknown-argument error.

AC-4: The system shall continue to create `<cwd>/worklog/<today>.md` and
write a readable `Done`-only entry via `bob worklog append` run in a fresh
temp directory with no admin socket present.

AC-5: The system shall continue to exit non-zero and name the missing
`worklog/` directory when `bob worklog list` runs where none exists.

## Dependencies

- `T-215` — provides the final CLI shape this test asserts against

## Files to Touch

- `the-intern/service/crates/bob/tests/non_serve.rs` — rewrite the worklog
  block's `--left`/`--next`-bearing invocations and assertions for the
  `Done`-only shape; add the unknown-argument-rejection test

## Verification

```bash
cd the-intern/service && cargo test -p bob --test non_serve worklog
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
