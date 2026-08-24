---
id: T-186
title: Add the canonical tasks skill and deliver it to the pi package
status: in-progress
priority: medium
assigned-role: developer
created: '2026-08-23'
spec: S-014
---

# Add the canonical tasks skill and deliver it to the pi package

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

Writes the skill that teaches an agent to use the board, and delivers it through
the packaging mechanism that already exists.

The skill covers when work belongs on a board rather than in an in-session
checklist, how to write a description and a Definition of Done that another run
can pick up cold, what each status commits to — including why a blocked task
needs to say what it is waiting on and who owns it — and which subcommand
performs each move. It must **not** restate the file format as law: the command
defines the format, and skill prose that repeats it is free to drift from it.
Per S-011 the text must be intelligible without access to this repository's
specifications, decision records, tasks, or bugs.

The binary embeds the generated pi package wholesale, so the skill becomes an
embedded asset as soon as the packaging script emits it. That breaks two
exhaustive assertions in the same change: `init_assets.rs` pins the embedded
relative-path list, and `init_e2e.rs` asserts the installed skill set. Both are
updated here, not later.

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

AC-1: The system shall carry a `tasks` skill in the canonical skill source
describing when and how to use the board without defining the file format.
AC-2: WHEN the pi packaging script is run THE SYSTEM SHALL generate a `tasks`
skill tree alongside the existing three.
AC-3: The system shall assert an embedded asset list and an installed skill set
that both include the `tasks` skill.
AC-4: The system shall contain no reference to this repository's specifications,
decision records, tasks, or bugs in the skill's text.

## Dependencies

- `T-179` — the canonical source must already be at its new path.
- `T-185` — the skill describes the complete `bob task` surface, so that surface must exist.

## Files to Touch

- `the-intern/bob-skills/skills/tasks/SKILL.md` — new canonical skill (regenerate `.pi/skills/tasks/` from it).
- `the-intern/bob-skills/package-pi-skills.sh` — add the skill to the generated set.
- `the-intern/service/crates/bob/src/init_assets.rs` — extend the asserted embedded path list.
- `the-intern/service/crates/bob/tests/init_e2e.rs` — extend the asserted installed skill set.

## Verification

```bash
./the-intern/bob-skills/package-pi-skills.sh
./the-intern/bob-skills/test_package_pi_skills.sh
(cd the-intern/service && cargo test -p bob)
```

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

### Session 1 — 2026-08-24

Read S-014 and the existing worklog/himalaya/email-triage canonical skills for
tone and precedent, and read board.rs, store.rs, task.rs (the T-182 through
T-185 `bob task` implementation) and the build.rs / init_materializer.rs
wiring to understand what the tasks skill needed to teach without restating.

Wrote `the-intern/bob-skills/skills/tasks/SKILL.md`: when work belongs on the
board versus an in-session checklist, how to write a description and
Definition of Done a cold reader can act on, what todo/doing/blocked/done
each commit to (including that a blocked task must name what it's waiting on
and who owns lifting it, since the command itself enforces none of this),
which subcommand performs each move (new/list/status/note/show, named by
purpose rather than exact flags), and a short board-discovery note. Every
syntax/format claim is deliberately deferred to the command's own `--help`
rather than restated, per the task's constraint and S-014's "command is the
normative definition" principle. Grepped the file for spec/ADR/task/bug
tokens and repo-name references before committing — none present.

Added `tasks` to `package-pi-skills.sh`'s `skill_names` array and regenerated
`.pi/skills/tasks/` via the script; `test_package_pi_skills.sh` passed
unmodified (its assertions are per-skill, not exhaustive, so it didn't need
touching and wasn't touched).

Confirmed the two exhaustive assertions broke exactly as flagged: ran
`cargo test -p bob --lib init_assets` before touching the test file and got
two failures (`exposes_a_stable_relative_path_list_and_matching_bytes`,
`contains_the_three_shipped_skill_roots`) because the generated tree now
includes `tasks/SKILL.md`. Updated `init_assets.rs`'s `expected_paths` list
and renamed/updated the roots test to `contains_the_four_shipped_skill_roots`
including `"tasks"`. Reran — green, and the full `cargo test -p bob --lib`
suite (231 tests) stayed green.

`init_e2e.rs`'s two tests turned out not to break automatically (their
skill-presence checks are per-item `assert!`s and a non-exhaustive loop, not
an exact-set comparison), so nothing there was actually red before editing —
but AC-3 requires the installed-skill-set assertion to cover the tasks skill,
so I added a fourth `assert!` for `skill_install_path/tasks/SKILL.md` in
`init_materializes_shared_skills_and_bootstrap_policy_in_isolated_xdg_dirs`
and added `"tasks"` to the loop array in
`initialized_workspace_chat_banner_lists_the_shared_skill_names`. Ran
`cargo test -p bob --test init_e2e` (real `pi` binary is on PATH in this
sandbox, unlike the Unix-socket tests CLAUDE.md warns about) — both pass,
confirming the shared skill install path and the chat `[Skills]` banner both
now include `tasks` with no code changes needed in `init_materializer.rs` or
the pi extension, since both already iterate the embedded asset table
generically.

Ran the task's full verification block (`package-pi-skills.sh`,
`test_package_pi_skills.sh`, `cargo test -p bob`) plus `cargo fmt --all --
--check` and `cargo test --workspace` end to end — everything passes, and
`git status` is clean after regeneration (packaging is idempotent). Three
commits on the task branch: skill authoring + packaging (feat), the
init_assets.rs assertion update (test), and the init_e2e.rs assertion update
(test). Only the four files named in Files to Touch were edited, plus the
mechanically generated `.pi/skills/tasks/SKILL.md` that `package-pi-skills.sh`
produces as its direct output.

Nothing remains for this task; all four acceptance criteria are met and
verified. Reviewer should read the new SKILL.md for tone/scope (it mirrors
worklog's structure) and can spot-check AC-4 by re-running the same grep for
spec/ADR/task/bug tokens.

One correction to how this task was framed at handoff: the loop's briefing
said both `init_assets.rs` and `init_e2e.rs` contained assertions that would
break automatically. In practice only `init_assets.rs`'s two assertions are
exhaustive (`assert_eq!` on a full list) and actually went red before the
fix. `init_e2e.rs`'s checks are non-exhaustive per-item assertions and stayed
green even before I touched them. I added the `tasks` assertions there anyway
because AC-3 explicitly requires the installed-skill-set assertion to include
the tasks skill — so that file's "red" step was really "AC-3 requires an
assertion that doesn't yet exist," not an existing test breaking.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->
