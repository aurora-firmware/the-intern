---
id: T-233
title: Update bob init expectations to the five-skill set
status: completed
priority: medium
assigned-role: developer
created: '2026-10-13'
---

# Update bob init expectations to the five-skill set

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

Update every `bob init` expectation that pins the embedded or installed
skill set to four skills so it expects five, including `the-intern-docs`
with its `references/` pages (CR-016 item 8; S-012 v0.4 Files created,
Verification, Phase 5).

Known pins (search for others with
`grep -rn "tasks/SKILL\|worklog/SKILL\|himalaya/SKILL" the-intern/service`):
`src/init_materializer.rs` tests, `src/cli/commands/init.rs` tests,
`tests/init_e2e.rs` (including the chat-banner skill list at ~line 324,
which the grep below misses), `tests/non_serve.rs`. `src/init_assets.rs` is already
updated by T-232. Do not change `bob init` behaviour: plain
`bob init <path> [--force]` and `--skills-only [--force]` keep their per-file
semantics; `--skills-only` resolves the default skill install path from the
environment alone (S-012 v0.4). Only the expected skill set changes.

The sandbox note in the repo memory applies: some socket tests can hang in a
restricted sandbox — verify with the targeted test binaries below.

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

AC-1: WHEN `bob init <path>` runs on a fresh data directory THE SYSTEM SHALL
      install five skill trees, including `the-intern-docs/SKILL.md` and its
      five `references/<dir>/index.md` pages, and the tests shall assert
      this (the chat-banner list included).
AC-2: WHEN `bob init --skills-only` runs on an empty skill install path THE
      SYSTEM SHALL create all five skill trees, and the tests shall assert
      this.
AC-3: The tests shall keep asserting the existing per-file semantics (existing
      files untouched without `--force`, replaced with `--force`) unchanged.
AC-4: The system shall have no remaining test expectation that pins the
      skill set to four skills.

## Dependencies

- `T-232` — the embedded set contains the docs skill and its pages

## Files to Touch

- `the-intern/service/crates/bob/src/init_materializer.rs` — test expectations
- `the-intern/service/crates/bob/src/cli/commands/init.rs` — test expectations
- `the-intern/service/crates/bob/tests/init_e2e.rs` — five-skill expectations
- `the-intern/service/crates/bob/tests/non_serve.rs` — five-skill expectations (if it pins the set)

## Verification

```bash
cd the-intern/service
cargo test -p bob init_materializer
cargo test -p bob cli::commands::init
cargo test -p bob --test init_e2e
cargo test -p bob --test non_serve
cargo fmt --all -- --check
```

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

### Session 1 — 2026-10-14

I read the task and found which tests pinned the skill set.

Already non-strict (the "red" step could not be a real failure):
- `init_materializer.rs` `materializes_new_workspace_and_shared_assets_...`
  checked only `email-triage/SKILL.md`.
- The skills-only tests seeded `himalaya` and `tasks`, and never asserted the
  full set on an empty path.
- `init_e2e.rs` `init_materializes_shared_skills_...` enumerated four skills
  (`email-triage`, `himalaya`, `worklog`, `tasks`) and had no check for the docs
  skill or its pages.
- The chat-banner test looped over the same four names.
- The `init.rs` tests build synthetic `MaterializationReport`s with arbitrary
  paths (`email-triage`, `tasks`, `himalaya`), so they pin no set.
- `non_serve.rs` has no init or skill-set expectations; its "AC-4" matches are
  unrelated.
- No test said "four skills". The only "four" strings are about bootstrap policy
  rules, which are unrelated and untouched.

What I changed:
- In `init_materializer.rs` I added an expected-names constant, an
  expected-reference-dirs constant, and a helper
  `assert_five_skill_trees_installed`. The helper checks that each `SKILL.md`
  exists, that each docs `references/<dir>/index.md` exists, and that the
  install path contains exactly those five skill directories (catching both a
  missing and an extra skill).
- Two new tests use that helper:
  `materialize_workspace_installs_all_five_skill_trees_with_docs_reference_pages`
  (AC-1) and
  `install_skills_only_creates_all_five_skill_trees_on_an_empty_install_path`
  (AC-2). Both passed on first run because T-232 already provides the
  behaviour; I proved they can fail by temporarily renaming one expected page
  directory (both went red), then reverted the rename.
- In `init_e2e.rs` the init test now also asserts `the-intern-docs/SKILL.md` and
  the five reference index pages, and the chat-banner list has five entries,
  including `the-intern-docs`.
- AC-3: the existing per-file tests (no-force skips, `--force` replaces, newly
  shipped skill installed without disturbing others) are untouched and pass.
- No `bob init` behaviour or production code changed.

Tried and rejected: adding tests to `init.rs` and `non_serve.rs` (nothing there
pins the set, so it would be scope creep), and a separate e2e test for
`--skills-only` (the materializer unit test covers it more cheaply with
isolated paths).

Verification: `init_materializer` (`--lib`) 16 passed, `init_e2e` 4 passed,
`fmt --check` clean, full workspace suite green via `./scripts/cargo-dev.sh`,
no orphaned fixtures. Remaining: nothing.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->

### Review Verdict — 2026-10-14
PASS

Stage 1: AC-1 met (init_e2e asserts `the-intern-docs/SKILL.md`, the five `references/<dir>/index.md` pages, and the chat-banner list has five names; materializer test covers fresh `materialize_workspace`). AC-2 met (new skills-only test on an empty path asserts all five trees and exactly five directories). AC-3 met (existing per-file tests untouched). AC-4 met (no remaining four-skill pin; `init.rs` and `non_serve.rs` use synthetic data or have no skill-set expectations). Only test files changed; no production behaviour changed.

Stage 2: Helper and constants are clear, tests are independent (own tempdirs), and the exact-set assertion catches both missing and extra skills. Verified on the task branch via `./scripts/cargo-dev.sh`: `--lib init_materializer` 16 passed, `--test init_e2e` 4 passed, `fmt --check` clean.

Non-blocking: the `EXPECTED_SKILL_NAMES` and reference-dir lists are duplicated between the unit tests and `init_e2e.rs`; acceptable given the integration test's separate crate boundary.
