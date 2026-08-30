---
id: T-191
title: Add the worklog reconciliation step
status: pending
priority: high
assigned-role: developer
created: '2026-08-30'
---

# Add the worklog reconciliation step

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

Adds Component 1 of S-015: the **reconciliation step** that carries
still-open items forward into today's worklog file and reports today's
carried-forward set. Add `crates/bob/src/worklog/reconcile.rs` and declare
`pub mod reconcile;` in `crates/bob/src/worklog/mod.rs`.

Expose one operation — "ensure today's file is reconciled, then report
today's carried-forward set" — consuming the `WorklogStore` from T-190. It
is invoked internally by `append` and `list` (T-192/T-193); it is **not** a
standalone subcommand.

Reconciliation rule (S-015 Contract):

- Find the nearest prior worklog file that **exists** by walking
  `<cwd>/worklog/*.md` backward by date from today — regardless of whether
  that file still shows anything open. Do **not** filter on "has open
  items" at the file level: a day that closed everything it mentions is
  real information and must not be skipped for an older file.
- For each item-identifier whose **own last entry in that source file** is
  open (per T-190's open test), carry it forward into today's file **iff**
  today's file has no entry for that item-identifier yet.
- A carried-forward entry copies the source entry's `Left` and `Next`
  verbatim; its `Done` field states the item was carried forward and names
  the source file. When the source file holds more than one entry for the
  item-identifier, the chronologically last is the source.
- Presence-tested, therefore idempotent: a second run finds the entry
  present and does nothing. No "reconciled today" marker.

Reporting: return every item-identifier whose most recent entry **in
today's file** is both (a) a carried-forward entry — identifiable because
its `Done` states so — and (b) still open per the open test. An item closed
later the same day drops out. The set is returned regardless of whether
this call's own pass wrote the carry-forward entry or found it present.

Unit-test in-file.

## Acceptance Criteria

AC-1: WHEN reconciliation runs and the nearest prior worklog file that
exists has an open last entry for an item-identifier absent from today's
file THE SYSTEM SHALL append a carried-forward entry for it to today's
file, copying `Left` and `Next` verbatim and setting `Done` to name the
source file.

AC-2: WHILE the nearest prior worklog file that exists shows every item it
mentions as closed THE SYSTEM SHALL carry nothing forward and SHALL NOT
walk past it to an older file.

AC-3: WHEN reconciliation runs a second time for the same day THE SYSTEM
SHALL make no further change to today's file.

AC-4: IF a source file holds both an earlier open entry and a later closing
entry for one item-identifier THEN THE SYSTEM SHALL treat that item as
closed and not carry it forward.

AC-5: WHEN the operation returns THE SYSTEM SHALL report exactly the
item-identifiers whose most recent entry in today's file is a
carried-forward entry that is still open, whether or not this call wrote
them.

## Dependencies

- `T-190` — provides `WorklogStore` (path resolution, entry read/write, open test)

## Files to Touch

- `the-intern/service/crates/bob/src/worklog/reconcile.rs` — new: reconciliation + carried-forward reporting, unit tests
- `the-intern/service/crates/bob/src/worklog/mod.rs` — add `pub mod reconcile;`

## Verification

```bash
cd the-intern/service && cargo test -p bob worklog::reconcile
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
