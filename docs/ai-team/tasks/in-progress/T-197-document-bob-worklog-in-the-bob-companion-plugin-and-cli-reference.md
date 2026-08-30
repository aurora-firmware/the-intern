---
id: T-197
title: Document bob worklog in the bob-companion plugin and CLI reference
status: pending
priority: medium
assigned-role: developer
created: '2026-08-30'
---

# Document bob worklog in the bob-companion plugin and CLI reference

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

Component 5, part one: bring the operator-facing CLI documentation in line
with the new subcommand.

- `the-intern/bob-companion/claude/skills/bob-cli/references/command-reference.md`
  — add a `## bob worklog [append|list]` section after the `bob task`
  section, covering: `append` requires `--item`, `--done`, `--left`,
  `--next` (all non-empty, validated locally); `list` takes an optional
  `--date <YYYY-MM-DD>`; the worklog resolves **strictly** to
  `<cwd>/worklog/<date>.md` with no upward search and no override (contrast
  with `bob task`'s board search — ADR-015); both subcommands run first-run
  reconciliation automatically and report today's carried-forward item set;
  `--json` is supported; the command never opens `admin.sock`.
- `the-intern/bob-companion/claude/skills/bob-cli/SKILL.md` — add
  `bob worklog` to the one-line command summary, to the frontmatter
  `description`'s subcommand enumeration (a maintained surface — `task` was
  added there when S-014 landed), and to the command table with a row for
  "Append to / read the daily worklog". Also qualify the blanket claim
  that "All client subcommands talk to `bob serve` over the admin Unix
  socket (`admin.sock`)" — `bob worklog` (like `bob init` and `bob task`)
  is filesystem-only and never opens the socket.
- The CLI-reference preprocessor
  (`the-intern/docs/preprocessors/cli-reference/src/main.rs`) already
  derives its subcommand list from `bob --help` output (no hardcoded list
  since B-044), so it needs **no change**. Confirm by building the docs and
  checking a `bob worklog` page is generated.

## Acceptance Criteria

AC-1: The `bob-cli` `command-reference.md` shall contain a `bob worklog`
section documenting `append` (four required flags), `list` (optional
`--date`), cwd-strict resolution, automatic reconciliation, `--json`, and
that no admin socket is used.

AC-2: The `bob-cli` `SKILL.md` shall list `bob worklog` in its command
summary line, its frontmatter `description` subcommand enumeration, and its
command table, and shall no longer assert without qualification that every
client subcommand talks to `bob serve` over `admin.sock`.

AC-3: WHEN the mdBook docs are built with a `bob` binary that has the
`worklog` subcommand THE SYSTEM SHALL generate a `cli-reference/worklog`
page from `bob worklog --help`.

AC-4: The system shall make no edit to the CLI-reference preprocessor
source.

## Dependencies

- `T-193` — the `bob worklog` subcommand whose `--help` and behaviour are being documented

## Files to Touch

- `the-intern/bob-companion/claude/skills/bob-cli/references/command-reference.md` — new `bob worklog` section
- `the-intern/bob-companion/claude/skills/bob-cli/SKILL.md` — summary line + command table row

## Verification

```bash
cd the-intern/service && cargo build -p bob
cd ../docs && BOB_BIN="$PWD/../service/target/debug/bob" mdbook build && test -f book/cli-reference/worklog.html
grep -q 'bob worklog' ../bob-companion/claude/skills/bob-cli/SKILL.md
```

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

### Session 1 — 2026-08-30

Implemented the whole task in two TDD cycles, treating the Verification-block shell checks (plus per-AC content greps I wrote into `verify_ac1.sh` / `verify_ac2.sh`) as the failing tests.

Confirmed the real CLI surface first by building `bob` and reading `bob worklog --help`, `bob worklog append --help`, `bob worklog list --help`, plus `crates/bob/src/cli/mod.rs`, `crates/bob/src/cli/commands/worklog.rs`, `crates/bob/src/worklog/reconcile.rs`, and ADR-015 / S-015. Verified flag names (`--item`, `--done`, `--left`, `--next` all required; `list --date`), the local empty/all-whitespace rejection (`worklog entry field --<name> must not be empty`), the cwd-strict `<cwd>/worklog/<date>.md` rule with no upward search / no override, the "reconcile today's file first, unconditionally, then report today's sorted de-duplicated carried-forward set" behaviour (including that `list --date <past>` still reconciles today and reads the past day as-is, and that an absent `worklog/` makes reconciliation a no-op), the `carried_forward` JSON key, and that the command loads no config and never touches `admin.sock`.

Cycle 1 (AC-1): added `## `bob worklog [append|list]`` to `references/command-reference.md` between the `bob task` and `bob serve` sections, matching the house style — a level-2 heading with a signature, two prose paragraphs (filesystem-only + cwd-strict/ADR-015 contrast with `bob task`'s board walk-up and `--board`/`TASKS_DIR`; automatic first-run reconciliation and carried-forward reporting), then `###` subsections for `append` and `list` with bulleted flag notes. Committed as `docs(bob-cli): document bob worklog in the command reference`.

Cycle 2 (AC-2): in `SKILL.md` added `worklog` to the "single binary with subcommands" line, to the frontmatter `description` subcommand list (`… chat, and worklog subcommands`) plus an "append to or read the daily worklog" clause in the "Use whenever" enumeration (following the precedent set when `task` was added for S-014), and a Quick-command-map row `| Append to / read the daily worklog | `bob worklog append|list` |`. Changed "All client subcommands talk to `bob serve` over the admin Unix socket" to "Most …" and appended a sentence naming `bob init`, `bob task`, and `bob worklog` as the filesystem-only exceptions that never open `admin.sock`. Also extended the "Full flag-by-flag reference … including `init`, `task`, `worklog`, and `schedule`" pointer for accuracy. Committed as `docs(bob-cli): add bob worklog to the skill overview and qualify the admin-socket claim`.

AC-3 / AC-4: no change required. The CLI-reference preprocessor already derives its subcommand list from `bob --help` (B-044), so `BOB_BIN=… mdbook build` produced `book/cli-reference/worklog.html` from `bob worklog --help` with the preprocessor source untouched. Verified the page content and that `git diff --name-only dev-agent...HEAD` lists only the two in-scope files.

Considered and rejected: adding a `bob worklog` bullet to SKILL.md's "Things that are easy to get wrong" section — out of scope per the task's "only add the `bob worklog` coverage and qualify the admin-socket claim" instruction, and the gotchas (cwd-strict resolution, local validation) are already spelled out in `command-reference.md`. Also rejected making the doc prose bend to my initial over-strict assertions; I fixed the assertions instead.

Nothing remains. `cargo test --workspace` is green (788 passed, 0 failed).

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->
