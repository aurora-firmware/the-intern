---
id: T-193
title: Add the bob worklog list subcommand
status: pending
priority: high
assigned-role: developer
created: '2026-08-30'
---

# Add the bob worklog list subcommand

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

Adds the `list` half of Component 3, extending the surface T-192 created.

**Grammar** (`crates/bob/src/cli/mod.rs`): add a `List` variant to
`WorklogCommand` with an optional `--date <YYYY-MM-DD>` flag.

**Dispatch** (`crates/bob/src/lib.rs`): add `worklog_list(&self, json,
date)` to `DispatchRuntime` + both impls (`ProductionRuntime`,
`FakeRuntime`), and route `WorklogCommand::List` through the existing
`Command::Worklog` early-return block.

**Handler** (`crates/bob/src/cli/commands.rs` +
`crates/bob/src/cli/commands/worklog.rs`): add the `worklog_list` wrapper
and `run_list`. It must: resolve the target date (`--date` if given, else
today); if `<cwd>/worklog/` does not exist, exit non-zero naming that
directory (never create it); run the T-191 reconciliation step
**unconditionally against today's file** before producing any output — this
is required on every `list` invocation regardless of `--date`, per S-015's
Design Principles ("every entry point that touches today's file performs
reconciliation first, unconditionally") and the Reconciliation-step
Responsibility row ("Runs unconditionally at the start of both `append` and
`list`"); read the target day's entries via the T-190 store and render them
ordered by `HH:MM`; emit human-readable text or, with `--json`, a JSON
object — both including today's carried-forward item-identifier set. Name
grammar tests `worklog_list_*`.

Only the *displayed past-dated file* is exempt from writes: `--date <past>`
renders that file as-is and never reconciles or modifies it, but today's
file is still reconciled first (which may itself create today's file when
`worklog/` exists and there is something open to carry forward — S-015
rejects computing the carried-forward set without writing the entries). The
reported carried-forward set is always today's, and is empty only when
nothing is open.

## Acceptance Criteria

AC-1: WHEN `bob worklog list` is parsed with or without `--date` THE SYSTEM
SHALL dispatch to the list handler without loading service configuration or
opening `admin.sock`.

AC-2: IF `<cwd>/worklog/` does not exist THEN THE SYSTEM SHALL exit
non-zero with a message naming that path and SHALL NOT create it.

AC-3: WHEN `list` runs with any `--date` value THE SYSTEM SHALL run the
reconciliation step against today's file before producing output, and
WHERE the target date is in the past THE SYSTEM SHALL render that
past-dated file's entries as-is without writing to it.

AC-4: WHEN entries are rendered THE SYSTEM SHALL order them by each entry's
`HH:MM` value.

AC-5: WHEN `list` succeeds THE SYSTEM SHALL print human-readable output by
default and a JSON object with `--json`, each including today's
carried-forward item-identifier set.

## Dependencies

- `T-192` — creates the `bob worklog` grammar, dispatch wiring, and `cli/commands/worklog.rs`
- `T-190` — worklog entry file store (called directly by `run_list`)
- `T-191` — reconciliation step (called directly by `run_list`)

## Files to Touch

- `the-intern/service/crates/bob/src/cli/mod.rs` — `WorklogCommand::List` with `--date`
- `the-intern/service/crates/bob/src/lib.rs` — `DispatchRuntime::worklog_list` + impls + `List` routing
- `the-intern/service/crates/bob/src/cli/commands.rs` — `worklog_list` wrapper
- `the-intern/service/crates/bob/src/cli/commands/worklog.rs` — `run_list` + context split

## Verification

```bash
cd the-intern/service && cargo build -p bob && cargo test -p bob worklog
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
