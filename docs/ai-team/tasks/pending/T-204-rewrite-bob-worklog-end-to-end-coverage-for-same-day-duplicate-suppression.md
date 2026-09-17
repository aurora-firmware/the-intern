---
id: T-204
title: Rewrite bob worklog end-to-end coverage for same-day duplicate 
  suppression
status: pending
priority: high
assigned-role: developer
created: '2026-09-17'
---

# Rewrite bob worklog end-to-end coverage for same-day duplicate suppression

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

`crates/bob/tests/non_serve.rs`'s `T-194` block (from "bob worklog:
end-to-end coverage with no running service" onward) has 5 ACs; AC-4
(`worklog_list_carries_a_prior_day_open_item_forward_and_reports_it`) and
AC-5 (`worklog_append_twice_the_same_day_keeps_exactly_one_carried_forward_
entry`) assert the old cross-day carry-forward behavior `T-202`/`T-203`
remove — they must fail to compile/pass against the new CLI output and are
rewritten, not merely deleted, so the binary-level (no admin socket, no
`bob serve`) coverage of same-day duplicate suppression that replaces them
still exists. AC-1/2/3 (fresh-directory append, read-back, missing-directory
error) describe behavior this change does not touch and should be kept
essentially as-is, only dropping any `carried_forward`-specific assertions
they happen to make.

## Acceptance Criteria

AC-1: WHEN `bob worklog append` is invoked twice for the same item the same
day with identical `--done`/`--left`/`--next` values THE SYSTEM SHALL leave
exactly one entry for that item-identifier in today's file, and the second
invocation's output shall report the write as suppressed.

AC-2: WHEN `bob worklog append` is invoked twice for the same item the same
day with a different `--done` value (holding `--left`/`--next` fixed) THE
SYSTEM SHALL leave two entries for that item-identifier in today's file.

AC-3: IF a prior-day worklog file exists with an open item THEN `bob
worklog list` for a later day SHALL render only that later day's own file
and SHALL NOT show the prior day's item anywhere in its output.

AC-4: The system shall continue to exit non-zero and name the missing
`worklog/` directory when `bob worklog list` runs where none exists
(unchanged behavior, re-verified against the new binary).

AC-5: The system shall continue to create `<cwd>/worklog/<today>.md` and
write a readable entry via `bob worklog append` run in a fresh temp
directory with no admin socket present (unchanged behavior, re-verified
against the new binary).

## Dependencies

- `T-203` — provides the final CLI output shape this test asserts against

## Files to Touch

- `the-intern/service/crates/bob/tests/non_serve.rs` — rewrite the T-194
  worklog block's AC-4/AC-5 tests for same-day duplicate suppression; adjust
  AC-1–3's carried-forward-specific assertions if any; update the module
  doc comment naming this task instead of T-194's old description

## Verification

```bash
cd the-intern/service && cargo test -p bob --test non_serve worklog -- --nocapture
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
