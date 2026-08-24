---
id: T-188
title: Update the companion plugin for bob task and the new workspace layout
status: completed
priority: medium
assigned-role: developer
created: '2026-08-23'
spec: S-014
---

# Update the companion plugin for bob task and the new workspace layout

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

The bob-companion plugin's account of the CLI and of the workspace `bob init`
produces both go stale.

`bob-cli` names the subcommand set in its frontmatter description and again in
its opening paragraph, and needs `task` added to both, with a flag-by-flag
section in its command reference alongside the existing subcommands. That
reference's `bob init` section and the `bob-setup` skill each enumerate the
workspace files and the installed skill package by name; both gain the board
directory and the fourth skill.

No new skill is added. S-014 places the command's operating instructions in the
skill bob supplies through its extension, so that any session bob spawns can use
the command regardless of what tooling an operator happens to run. The companion
plugin records that the subcommand exists and how to drive it; it does not become
a second account of how to use the board.

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

AC-1: The system shall list `task` among the bob subcommands in the `bob-cli`
skill's description and body.
AC-2: The system shall document every `bob task` subcommand and its flags in the
companion command reference.
AC-3: The system shall describe the workspace `bob init` produces as including
the board directory and the fourth installed skill, in both places that layout is
enumerated.
AC-4: The system shall add no new skill directory to the companion plugin.

## Dependencies

- `T-185` — the documented command surface must be final.
- `T-187` — the documented workspace layout must be final.

## Files to Touch

- `the-intern/bob-companion/claude/skills/bob-cli/SKILL.md` — subcommand list in the description and body.
- `the-intern/bob-companion/claude/skills/bob-cli/references/command-reference.md` — a `bob task` section, and the `bob init` layout.
- `the-intern/bob-companion/claude/skills/bob-setup/SKILL.md` — the workspace layout and installed skill set.

## Verification

```bash
grep -q "bob task" the-intern/bob-companion/claude/skills/bob-cli/SKILL.md
grep -q "bob task" the-intern/bob-companion/claude/skills/bob-cli/references/command-reference.md
grep -q "tasks/" the-intern/bob-companion/claude/skills/bob-setup/SKILL.md
test "$(ls the-intern/bob-companion/claude/skills | wc -l)" -eq 4
```

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

### Session 1 — 2026-08-24

Implemented T-188 as documentation-only TDD: for each of the four acceptance criteria, wrote a grep/awk-based assertable check first, ran it to confirm it failed against the stale content, then edited the content and reran to confirm green, then committed the cycle.

Read the source of truth before writing any docs: `TaskCommand` in `the-intern/service/crates/bob/src/cli/mod.rs` (subcommands `new`, `show`, `list`, `status`, `note`, plus the `--board` flag on the parent `Task` command), the handler in `cli/commands/task.rs`, and `resolve_board_path` in `task_board/board.rs` for the `--board`/`TASKS_DIR`/ancestor-search/`<cwd>/tasks` resolution order. Read `init_materializer.rs` and `init_assets.rs` to confirm `bob init` now creates an empty `tasks/` board directory (via `ensure_board_directory`) alongside `worklog/`, and installs a four-skill package (`email-triage`, `himalaya`, `tasks`, `worklog`) at `skill_install_path`.

Four red→green cycles, each committed separately on the task branch:
1. Added `task` to the `bob-cli` SKILL.md frontmatter description's subcommand enumeration and to the opening paragraph's subcommand list; also added a `bob task` row to the Quick command map and mentioned `task` in the "full flag-by-flag reference" pointer sentence, and a short paragraph noting the `tasks` pi-agent skill (not this plugin) owns board-usage discipline.
2. Added a full `## `bob task [--board <PATH>] <subcommand>`` section to `references/command-reference.md`, documenting the `--board` resolution order and each of `new`/`show`/`list`/`status`/`note` with every flag from the clap grammar.
3. Updated the two places that enumerate the workspace layout — the `bob init` section of `command-reference.md` and section 5 ("Initialize a workspace") of `bob-setup/SKILL.md` — to include the `tasks/` board directory in the file list and all four skill names (`himalaya`/`email-triage`/`tasks`/`worklog`) in the installed-skill-package description.
4. Verified AC-4 (no new skill directory) — this was already true before any edit (still 4 dirs: `bob-cli`, `bob-health-check`, `bob-setup`, `bob-troubleshooting`), so no fix cycle was needed there, just a confirming check.

A small follow-up refactor commit fixed an awkward sentence ("omitted it reads" → "if omitted, it reads") in the new `bob task status` doc, re-verified all checks stayed green, and committed separately.

Tried and rejected: an early regex check for AC-1 used `\btask\b` which false-matched the pre-existing phrase "...accomplishes a task" in the description — had to scope the pattern to the specific subcommand-enumeration substring instead. Similarly for AC-3, an early `tasks/` grep against the whole `command-reference.md` file false-passed because my newly-added `bob task` section already mentioned `tasks/` in the `--board` resolution prose; fixed by scoping each check with `awk` to just the relevant `## ...` section before asserting.

Nothing remains — all four ACs are green, the task's literal Verification block (four `grep`/`ls` commands) passes end-to-end, and only the three files listed under `Files to Touch` were modified. Ran the full check suite one final time after the grammar fix to confirm no regressions.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->

### Review Verdict — 2026-08-24

PASS

**Stage 1 — Acceptance criteria** (checked independently against source, not
just the Work Log):

- AC-1: PASS. `bob-cli/SKILL.md`'s frontmatter `description` lists `task`
  first among the subcommands, and the opening body paragraph lists it too
  (`init`, `task`, `serve`, `status`, `sessions`, `audit`, `policy`,
  `schedule`, `chat`).
- AC-2: PASS. Read `TaskCommand` in
  `the-intern/service/crates/bob/src/cli/mod.rs` directly: five variants
  (`New`, `Show`, `List`, `Status`, `Note`) plus the parent `Task` command's
  `--board` flag. Cross-checked every field against the new `## `bob task
  [--board <PATH>] <subcommand>`` section of `command-reference.md`:
  `new` (`title`, `--status`, `--created`, `--description`, `--done`),
  `show` (`id`, `--path`), `list` (`--status`), `status` (`id`, `status`,
  `--reason`), `note` (`id`, `text`) are all present with matching flag
  names, defaults, and repeatability. Also spot-checked the described
  behavior (partial-id resolution, `BoardOperation::Write` auto-create only
  on `new`, `--board` > `TASKS_DIR` > ancestor search > `<cwd>/tasks`
  resolution order) against `cli/commands/task.rs` and
  `task_board/board.rs::resolve_board_path` — matches.
- AC-3: PASS. Both `command-reference.md`'s `bob init` section and
  `bob-setup/SKILL.md` section 5 now list the `tasks/` board directory and
  all four installed skills (`himalaya`/`email-triage`/`tasks`/`worklog`).
  Verified against `init_materializer.rs` (`ensure_board_directory`,
  `worklog` dir) and `init_assets.rs`
  (`BTreeSet::from(["email-triage", "himalaya", "tasks", "worklog"])`) —
  matches.
- AC-4: PASS. Checked out the task branch into a scratch worktree and ran
  `ls the-intern/bob-companion/claude/skills`: exactly `bob-cli`,
  `bob-health-check`, `bob-setup`, `bob-troubleshooting` — the same 4
  directories as on `dev-agent`, no new skill directory added.
- No unspecified behavior added; only the three files listed under Files to
  Touch were modified (plus the task file itself). Ran the task's literal
  Verification block (4 `grep`/`ls` commands) against the worktree — all
  green.

Description constraint ("does not become a second account of how to use the
board"): confirmed. The new `bob-cli/SKILL.md` paragraph explicitly defers
board-usage discipline to the `tasks` pi-agent skill from T-186, and the new
`bob task` section in `command-reference.md` stays at the flag/behavior
level throughout (id resolution mechanics, error strings, defaults) with no
judgment calls about when to file, move, or word a task.

**Stage 2 — Code quality**: documentation-only change; content is accurate
against the source of truth, well organized, consistent with the existing
reference doc's style, and free of dead/commented-out content. Commit
messages follow `git-conventions` format.

No blocking issues found.
