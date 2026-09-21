---
id: T-215
title: Update the bob worklog CLI layer to drop --left/--next
status: pending
priority: high
assigned-role: developer
created: '2026-09-21'
---

# Update the bob worklog CLI layer to drop --left/--next

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

`T-214` narrows the stored entry to `Done` alone. This task removes
`--left`/`--next` from `WorklogCommand::Append`'s clap definition
(`cli/mod.rs`) so a call still passing either flag fails with clap's own
unknown-argument error, per `S-015`'s Contract ("a call that still passes
`--left` or `--next` fails with an unknown-argument error rather than
accepting and silently discarding them"); removes `left`/`next` from
`DispatchRuntime::worklog_append`'s signature and both its
`ProductionRuntime` and test `FakeRuntime` implementations (`lib.rs`); and
removes the `left`/`next` fields from `WorklogEntryOutput`/
`AppendedEntryOutput` output rendering (`cli/commands/worklog.rs`). Update
`WorklogCommand::Append`'s doc comments, which currently describe the
four-flag shape.

## Acceptance Criteria

AC-1: WHEN `bob worklog append` is invoked with `--left` or `--next` THE
SYSTEM SHALL reject the call with an unknown-argument error rather than
accepting it.

AC-2: WHEN `bob worklog append --item <item> --done <done>` is invoked with
both required flags and neither retired flag THE SYSTEM SHALL accept the
call.

AC-3: The system shall not include a `left` or `next` field in `bob worklog
append` or `bob worklog list` JSON output.

AC-4: WHERE `WorklogCommand::Append`'s doc comments exist in `cli/mod.rs`
THE SYSTEM SHALL describe the `--item`/`--done` shape only.

## Dependencies

- `T-214` — provides the `Done`-only store/duplicate-check this layer
  dispatches into

## Files to Touch

- `the-intern/service/crates/bob/src/cli/mod.rs` — drop `--left`/`--next`
  from `WorklogCommand::Append`; update doc comments; update the module's
  own tests
- `the-intern/service/crates/bob/src/cli/commands/worklog.rs` — drop
  `left`/`next` from `run_append`'s signature and from
  `WorklogEntryOutput`/`AppendedEntryOutput`; update the module's own tests
- `the-intern/service/crates/bob/src/lib.rs` — drop `left`/`next` from
  `DispatchRuntime::worklog_append`, `ProductionRuntime`'s implementation,
  and the test `FakeRuntime`'s implementation; update the module's own
  tests

## Verification

```bash
cd the-intern/service && cargo build -p bob && cargo test -p bob lib:: cli::
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
