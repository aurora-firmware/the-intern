---
id: T-214
title: Narrow bob worklog's entry storage and same-day duplicate check to Done 
  only
status: pending
priority: high
assigned-role: developer
created: '2026-09-21'
---

# Narrow bob worklog's entry storage and same-day duplicate check to Done only

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

`S-015` (amended by `CR-014`, v0.6) narrows the worklog entry format from
`Done`/`Left`/`Next` to `Done` alone, and narrows same-day duplicate
suppression to compare `Done` only. `crates/bob/src/worklog/store.rs`'s
`WorklogEntry`/`RecordedEntry` structs, its entry-writing `format!`, and its
`- Left:`/`- Next:` line parsing drop those two fields;
`crates/bob/src/worklog/reconcile.rs`'s `is_same_day_duplicate` compares
`Done` alone. A day's file already holding entries written under the prior
three-bullet shape must still parse for its header and `Done` (the parser
already defaults an absent bullet to empty, per its existing lenient
design); its `Left`/`Next` lines are neither read nor rewritten, and stay in
the file untouched.

The same change removes `--left`/`--next` from `WorklogCommand::Append`'s
clap definition and doc comments (`cli/mod.rs`), from the `worklog_append`
facade (`cli/commands.rs`), from `DispatchRuntime::worklog_append` and both
its `ProductionRuntime` and test `FakeRuntime` implementations (`lib.rs`),
and from `WorklogEntryOutput`/`AppendedEntryOutput` and the text renderer
(`cli/commands/worklog.rs`); `crates/bob/tests/non_serve.rs`'s worklog block
is rewritten to the `--item`/`--done` shape, keeping its fresh-directory-
creation and missing-`worklog/`-directory coverage as-is and dropping only
their `Left`/`Next` assertions. This is one task, not the originally planned
three (`T-215`/`T-216`, retired into this one), because these are every file
in the workspace naming `WorklogEntry`/`RecordedEntry`/`worklog_append`:
removing two struct fields invalidates all of their call sites
simultaneously, and Rust's whole-crate compilation means no smaller split
compiles on its own — confirmed during implementation (Architect escalation
review, 2026-09-21).

This task and `T-218` (the matching `email-triage` skill-content change,
adding a `Message-ID`-derived discriminator to the item-identifier) close
the same gap `CR-014`'s Architecture Consistency Review identified — this
narrowing must not be treated as safe to deploy on its own ahead of `T-218`,
since a caller still using the old non-unique identifier convention against
`Done`-only suppression can silently lose entries for two distinct messages
sharing a subject and sender. `T-221`, which depends on both this task and
`T-218`, mechanically checks that the corrected identifier reached the
packaged skill before the binary that embeds it is rebuilt.

## Acceptance Criteria

AC-1: WHEN append's same-day duplicate check runs for an item-identifier
whose most recent entry already in today's file has a `Done` value
identical (after the store's existing whitespace-trim rule, no
case-folding) to the incoming entry's `Done` THE SYSTEM SHALL write nothing.

AC-2: WHEN the incoming entry's `Done` differs from that item-identifier's
most recent entry in today's file, or today's file has no entry yet for
that item-identifier, THE SYSTEM SHALL append the incoming entry as a new
entry.

AC-3: The system shall write a new entry as a header line plus exactly one
`- Done: …` bullet with no `- Left:` or `- Next:` bullet, and shall not
include a `left` or `next` field in `bob worklog append` or `bob worklog
list` output in either text or JSON form.

AC-4: WHEN `bob worklog append` is invoked with `--left` or `--next` THE
SYSTEM SHALL exit non-zero with an unknown-argument error; WHEN invoked
with `--item` and `--done` alone THE SYSTEM SHALL accept the call.

AC-5: IF today's file holds an entry written under the prior three-bullet
shape THEN THE SYSTEM SHALL read that entry's header and `Done` value only,
and SHALL NOT modify its `Left`/`Next` lines.

## Dependencies

- None

## Files to Touch

- `the-intern/service/crates/bob/src/worklog/store.rs` — done (`bc4d976`) —
  narrow `WorklogEntry`/`RecordedEntry` to `Done` only; update the
  entry-writing format string and the day-file parser; update the module's
  own tests
- `the-intern/service/crates/bob/src/worklog/reconcile.rs` — done
  (`3df0da5`) — narrow `is_same_day_duplicate` to compare `Done` alone;
  update the module's own tests
- `the-intern/service/crates/bob/src/cli/mod.rs` — drop `--left`/`--next`
  from `WorklogCommand::Append`; update doc comments to the `--item`/
  `--done` shape; update the module's own tests
- `the-intern/service/crates/bob/src/cli/commands/worklog.rs` — drop
  `left`/`next` from `run_append`/`run_append_with_context` signatures,
  their `reject_entry_field` calls, and the `WorklogEntry` construction;
  drop the fields from `WorklogEntryOutput` and its
  `From<&RecordedEntry>` impl; drop the `- Left:`/`- Next:` lines from
  `write_worklog_day_text`; update the module's own tests
- `the-intern/service/crates/bob/src/cli/commands.rs` — drop `left`/`next`
  from the `worklog_append` facade
- `the-intern/service/crates/bob/src/lib.rs` — drop `left`/`next` from
  `DispatchRuntime::worklog_append` and both the `ProductionRuntime` and
  test `FakeRuntime` implementations; update the module's own tests
- `the-intern/service/crates/bob/tests/non_serve.rs` — rewrite the worklog
  block's invocations and assertions for the `Done`-only shape; add the
  unknown-argument-rejection test

## Verification

```bash
cd the-intern/service && cargo build -p bob && cargo test -p bob --lib worklog && cargo test -p bob --test non_serve worklog && cargo fmt --all -- --check
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
