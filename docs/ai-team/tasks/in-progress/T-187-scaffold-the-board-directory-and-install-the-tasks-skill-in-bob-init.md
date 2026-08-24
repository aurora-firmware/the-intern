---
id: T-187
title: Scaffold the board directory and install the tasks skill in bob init
status: in-progress
priority: medium
assigned-role: developer
created: '2026-08-23'
spec: S-014
---

# Scaffold the board directory and install the tasks skill in bob init

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

CR-009 amends S-012 so `bob init` creates an empty board directory in the
workspace it scaffolds, alongside `worklog/`, with the same owner-only protection
every other directory it creates has. Fixing the resolution point at the
workspace root means every session spawned with a working directory inside that
workspace attaches to the same board, rather than creating one wherever that
session happened to run.

The board directory holds operator and agent work product rather than files this
command owns, so `--force` must never remove or replace anything inside it; an
existing directory at that path is skipped and named in the warnings. S-012's
existing rule is that `--force` "may overwrite only files owned by this command",
and the board is the first thing `bob init` creates that it deliberately does not
own afterwards — so that guarantee needs its own test rather than riding along
with directory creation.

`bob init` must not become a precondition: `bob task` continues to work in a
directory `bob init` never touched.

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

AC-1: WHEN `bob init` scaffolds a workspace THE SYSTEM SHALL create an empty
board directory with mode `0700` on Unix and write no file into it.
AC-2: IF `--force` is supplied while the board directory already contains task
files THEN THE SYSTEM SHALL leave every one of them unchanged.
AC-3: WHEN `bob init` runs THE SYSTEM SHALL install the `tasks` skill tree at the
shared install path alongside the existing three.
AC-4: WHILE no workspace has been scaffolded THE SYSTEM SHALL still allow a board
to be created by `bob task`.

## Dependencies

- `T-186` — the fourth skill tree must exist to be installed, and this task extends the same integration test.
- `T-182` — the board directory this creates must be the one the resolver finds.
- `T-179` — modifies the same materializer file, and the renamed package must already be in place.

## Files to Touch

- `the-intern/service/crates/bob/src/init_materializer.rs` — create the board directory; exempt its contents from `--force`.
- `the-intern/service/crates/bob/tests/init_e2e.rs` — cover creation, the `--force` guarantee, and the installed skill set.

## Verification

```bash
(cd the-intern/service && cargo test -p bob --test init_e2e)
```

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

### Session 1 — 2026-08-24

Implemented CR-009's board-directory scaffolding in `bob init`. Read T-182's
`resolve_board_path`/`BoardOperation::Write` and confirmed the board directory
name the resolver expects is `tasks/` at the workspace root (hardcoded as a
literal string there too — no shared constant exists to reuse). Read
`init_materializer.rs`'s existing `--force` handling first, as instructed:
`ensure_directory` unconditionally normalizes mode on existing directories
(used for `worklog/`, `config/`), and `write_generated_file` skips-and-reports
existing files unless `force` is set, then overwrites-and-reports under
`force`. Neither pattern fits the board's requirement — content must never be
touched, mode included, under any combination of existence/force — so I added
a new `ensure_board_directory` helper that follows the same
existence-check-then-branch structure but only ever does two things: create
fresh (mode 0700, added to `created_paths`) or skip entirely and report
(`skipped_paths`), regardless of the `force` flag. It also rejects symlinks
and non-directory conflicts the same way the existing helpers do, for
consistency. `init.rs`'s report renderer already prints `skipped_paths` under
a "skipped existing:" section, so the CR-009/S-012 requirement that a
pre-existing board be "named in the warnings" is satisfied by the existing
generic reporting path — no change needed there, and it's outside this task's
Files to Touch anyway.

Verified rather than re-implemented the two assumptions the task called out:
(1) `install_shared_skills` installs the embedded asset table generically, so
the `tasks` skill tree that landed in T-186 is already installed by `bob
init` with no code change — confirmed by rerunning
`init_materializes_shared_skills_and_bootstrap_policy_in_isolated_xdg_dirs`,
which already asserts `tasks/SKILL.md` is installed (added in T-186); (2)
`bob task` still works without `bob init` ever having run — confirmed via the
pre-existing `non_serve.rs::task_new_creates_board_and_task_without_an_admin_socket`
test, since this task's board-directory code lives entirely inside
`materialize_workspace_with_paths`, which only `bob init` calls, with zero
coupling introduced into `task_board`/CLI task dispatch.

TDD cycles, both committed separately: (1) two unit tests in
`init_materializer.rs` — fresh-creation with mode 0700 and zero entries, and a
force-guarantee test looping over `force ∈ {false, true}` against a
pre-seeded board containing a task file, asserting the file's content is
untouched and the directory lands in `skipped_paths` (not `created_paths` or
`replaced_paths`) in both cases; confirmed both RED before implementing
`ensure_board_directory`, then GREEN after. (2) two e2e tests in
`init_e2e.rs` exercising the real `bob` binary end-to-end — board creation
with mode/emptiness assertions, and a force-guarantee test that runs `bob
init`, seeds a task file into the resulting `tasks/` directory, reruns `bob
init --force` (needed because the live config already exists from the first
run, so `--force` is required for the second invocation to succeed at all),
and asserts the file survives untouched and the CLI's stdout names the board
path under "skipped existing:". These e2e tests passed on first run rather
than red-first, since the underlying behavior was already implemented and
unit-tested earlier in this same session — noted as an intentional deviation,
not a scope violation, since they add real full-CLI-path coverage the unit
tests don't (actual env/XDG resolution, the real binary, the real report
renderer).

Verification: `cargo test -p bob --test init_e2e` (the task's specified
command) passes 4/4. Full workspace suite `cargo test --workspace` passes
clean on rerun; one unrelated flaky failure in `pi-agent-supervisor` (a
process-count timing assertion, untouched by this task) surfaced once under
parallel execution and passed both in isolation and on a full rerun, so it's
pre-existing flakiness, not a regression. `cargo fmt --all -- --check` clean.
Only the two files listed under Files to Touch were modified — confirmed via
`git diff --stat` against the branch point.

Nothing remains open for this task's four ACs. Documentation for the new
workspace layout (bob-companion plugin, shipped mdBook manual) is explicitly
out of scope per CR-009 and is already tracked as T-188 and T-189.

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

Stage 1 (acceptance criteria) — all four met, each checked against code, not
assumed:

- AC-1: `ensure_board_directory` creates `workspace_path.join("tasks")` with
  `set_owner_only_mode(path, 0o700)` and writes nothing into it. Confirmed by
  reading `init_materializer.rs` and by both the unit test
  `creates_an_empty_board_directory_with_owner_only_permissions` and the e2e
  test `init_creates_an_empty_board_directory_with_owner_only_permissions`,
  which I ran directly (both pass).
- AC-2 (this task's core value) — traced `ensure_board_directory` line by
  line. It takes no `force` parameter at all (its signature is
  `(path, report)`, and its caller in `materialize_workspace_files` never
  threads `force` into it), so the guarantee is structural, not conditional:
  there is no code path through which `--force` can reach this function.
  When `path.exists()` and is a directory, the function only ever pushes to
  `report.skipped_paths` and returns — it never calls `fs::write`,
  `fs::remove_*`, `set_owner_only_mode`, or any other mutation on a
  pre-existing board, and (unlike `ensure_directory`) it does not even
  normalize the mode of a pre-existing board, which is stricter than the AC
  requires. Symlinks are rejected via the same `reject_symlink_target`
  helper used by `ensure_directory`/`write_generated_file` (checked with
  `fs::symlink_metadata`, unconditionally, before the existence check), and a
  non-directory conflict is rejected with the same
  `fs::metadata` + `!metadata.is_dir()` → `ServiceError::InvalidRequest`
  pattern those helpers use. Ran the unit test
  `force_never_removes_or_replaces_existing_board_directory_contents`
  (loops `force ∈ {false, true}` against a pre-seeded board with a task
  file) and the e2e test
  `init_force_never_removes_or_replaces_existing_board_directory_contents`
  — both pass. Also confirmed the pre-existing board lands under the
  existing generic `"skipped existing:"` report section in
  `cli/commands/init.rs` (`write_path_section(out, "skipped existing",
  &report.skipped_paths)`), satisfying the "named in the warnings"
  requirement with no renderer change needed.
- AC-3 — verified by reading the installer, not the Work Log's claim.
  `install_shared_skills` iterates `embedded_pi_skill_assets()` generically
  (no hardcoded skill-name list) and calls `write_generated_file` per asset.
  `embedded_pi_skill_assets()` is generated at build time by
  `bob/build.rs`, which recursively walks the entire tracked
  `the-intern/bob-skills/.pi/skills` directory and emits one `EmbeddedAsset`
  per file found — `tasks/SKILL.md` already exists in that tracked tree
  (from T-186), so it is picked up automatically. No hardcoded skill list
  exists elsewhere in the `bob` crate that would need updating. This
  confirms AC-3 required zero code changes, as claimed.
- AC-4 — `bob task`'s board creation goes through
  `task_board::board::resolve_board_path` with `BoardOperation::Write`,
  which is entirely independent of `materialize_workspace_with_paths`
  (only `bob init` calls the latter); the pre-existing test
  `non_serve.rs::task_new_creates_board_and_task_without_an_admin_socket`
  exercises this without `bob init` ever running.

No unspecified behavior was added and no unexpected files were touched:
`git diff --stat` against `dev-agent` shows exactly the two files listed
under Files to Touch (109 and 68 insertions, 0 deletions).

Stage 2 (code quality) — correctness confirmed by tracing the logic above;
tests are independent (fresh `tempfile::tempdir()`/isolated XDG env per
test, no shared mutable state) and cover both the fresh-creation and
pre-existing/force-guarantee paths; the new helper's doc comment accurately
describes its behavior; no dead code; no security concerns (local
filesystem operations only, following the same validated-path patterns as
the adjacent helpers); no performance concerns. Ran the task's exact
Verification command, `cargo test -p bob --test init_e2e` (4/4 pass), the
two new unit tests directly (2/2 pass), and `cargo fmt --all -- --check`
(clean).

Flaky-test note for the loop, not a review blocker: the Work Log's reported
one-off failure of `pi-agent-supervisor`'s
`actor_shutdown_terminates_active_and_warm_worker_processes` under
`cargo test --workspace` is pre-existing flakiness unrelated to this
change — this diff touches zero files in `pi-agent-supervisor`, confirmed
via `git diff --stat`. It does not affect this verdict.
