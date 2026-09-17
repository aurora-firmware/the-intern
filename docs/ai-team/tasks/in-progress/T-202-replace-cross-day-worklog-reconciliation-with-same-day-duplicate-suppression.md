---
id: T-202
title: Replace cross-day worklog reconciliation with same-day duplicate 
  suppression
status: in-progress
priority: high
assigned-role: developer
created: '2026-09-17'
---

# Replace cross-day worklog reconciliation with same-day duplicate suppression

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

`S-015` (amended by `CR-013`, v0.5) removed automatic cross-day
reconciliation from `bob worklog` and replaced it with a same-day-only
exact-duplicate check. `crates/bob/src/worklog/reconcile.rs` still
implements the old behavior end to end: `nearest_prior_existing_date`,
`carry_forward_open_items`, and `report_carried_forward` all read a *prior*
day's file and copy entries into today's. This task removes all of that and
replaces it with `Component 1` of the amended spec: before `append` writes,
compare the incoming entry's `Done`/`Left`/`Next` against that
item-identifier's most recent entry already in **today's** file only; if all
three match, write nothing; otherwise write the new entry as normal (even
same item, same day, if any field differs). `store.rs`'s `item_open_state`
helper has no remaining caller once cross-day logic is gone and is deleted
with it. Neither `append` nor `list` may read or write any file other than
the one the invocation names (S-015 Design Principle, "A day's file must
contain only what was appended to it that day").

## Acceptance Criteria

AC-1: The system shall not read, copy from, or write to any worklog day
file other than the one an invocation names.

AC-2: WHEN the same-day duplicate check runs for an item-identifier whose
most recent entry already in today's file has `Done`, `Left`, and `Next`
all identical (after the store's existing whitespace-trim rule, no
case-folding) to the incoming entry THE SYSTEM SHALL write nothing.

AC-3: WHEN any one of `Done`, `Left`, or `Next` differs from that
item-identifier's most recent entry in today's file, or today's file has no
entry yet for that item-identifier, THE SYSTEM SHALL append the incoming
entry as a new entry.

AC-4: IF today's file holds more than one entry for an item-identifier THEN
THE SYSTEM SHALL compare the incoming entry only against the
chronologically last one, not any earlier entry for that item.

## Dependencies

- None

## Files to Touch

- `the-intern/service/crates/bob/src/worklog/reconcile.rs` — delete the
  cross-day functions and their tests; add the same-day duplicate-check
  function and its tests (module name/file name may stay `reconcile` for
  minimal churn, or be renamed — developer's call, not part of the
  spec-mandated behavior)
- `the-intern/service/crates/bob/src/worklog/store.rs` — delete the now-
  unused `item_open_state` helper and its tests

## Verification

```bash
cd the-intern/service && cargo build -p bob && cargo test -p bob worklog::
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
