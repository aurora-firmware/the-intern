---
id: T-231
title: Add the the-intern-docs skill source and pi packaging entry
status: pending
priority: medium
assigned-role: developer
created: '2026-10-13'
---

# Add the the-intern-docs skill source and pi packaging entry

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

Add the fifth bob-supplied skill, `the-intern-docs`, to the canonical skill
source and register it with the pi packaging script (CR-016 items 1–2; S-011
v0.3 Component 6, Component 2, Phase 6; ADR-017 §2).

Create `the-intern/bob-skills/skills/the-intern-docs/SKILL.md`. It holds only:
- frontmatter whose `description` triggers when the user asks about bob or the
  Intern itself (what it is; installing, configuring, operating, scheduling,
  troubleshooting it; its CLI) and not during unrelated work;
- a short topic index mapping topics to the reference pages, modelled on the
  topic map pi gives for its own docs. The pages keep the manual's own layout
  so its relative cross-links (`../<dir>/index.md`) resolve inside the copy;
  the paths are fixed by this plan and must match T-232 exactly:
  `references/quickstart/index.md`, `references/end-user-guide/index.md`,
  `references/operator-guide/index.md`, `references/architecture-overview/index.md`,
  `references/extension-author-guide/index.md`
  (one per `the-intern/docs/src/<dir>/index.md`, CLI reference excluded);
- the instruction to answer CLI questions from `bob --help` and
  `bob <subcommand> --help`, not from prose.
It contains no operating policy and never tells the agent to act on bob.

Add `the-intern-docs` to `skill_names` in `package-pi-skills.sh` and extend
`test_package_pi_skills.sh` (which runs in its own WORK_DIR) to expect it,
with no `references/` in the generated tree. Do NOT commit the regenerated
`.pi/skills/the-intern-docs/` tree — the binary embeds everything under
`.pi/skills`, so committing it before T-232 would break the `init_assets`
tests and embed an index with no pages; T-232 commits it together with the
build-time page embedding. Follow
`docs/ai-team/docs/coding-guidelines-skills.md` (no internal IDs).

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

AC-1: The system shall provide `the-intern-docs/SKILL.md` in the canonical
      skill source whose description scopes it to questions about bob or
      the Intern and whose body indexes exactly the five reference pages
      named in the Description.
AC-2: The `the-intern-docs` SKILL.md shall instruct the agent to answer CLI
      questions from `bob --help` / `bob <subcommand> --help` and shall
      contain no operating policy or instruction to act on bob.
AC-3: WHEN `test_package_pi_skills.sh` runs THE SYSTEM SHALL generate
      `the-intern-docs/SKILL.md` in its WORK_DIR from the canonical source,
      with no `references/` directory, and the test shall pass.
AC-4: The task's commit shall contain no `.pi/skills/the-intern-docs/` file
      and no copy of a manual page anywhere under `bob-skills/`.
AC-5: The SKILL.md shall contain no internal task/bug/spec/ADR/issue IDs.

## Dependencies

- None

## Files to Touch

- `the-intern/bob-skills/skills/the-intern-docs/SKILL.md` — new canonical skill
- `the-intern/bob-skills/package-pi-skills.sh` — add `the-intern-docs` to `skill_names`
- `the-intern/bob-skills/test_package_pi_skills.sh` — expect the fifth skill (WORK_DIR checks)

## Verification

```bash
bash the-intern/bob-skills/test_package_pi_skills.sh
test -z "$(git ls-files the-intern/bob-skills/.pi/skills/the-intern-docs)"
test ! -e the-intern/bob-skills/skills/the-intern-docs/references
! grep -nE "\b(T|B|S|CR)-[0-9]{3}\b|ADR-[0-9]{3}|#[0-9]{2,}" the-intern/bob-skills/skills/the-intern-docs/SKILL.md
```

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

### Session 1 — 2026-10-14

I added the fifth bob-supplied skill, `the-intern-docs`. First I extended
`test_package_pi_skills.sh`. A new test expects `the-intern-docs/SKILL.md` to be
generated in the isolated WORK_DIR with no `references/` directory, and the
existing allowed-tools/body-identical check now includes the new skill. That run
failed (4 passed, 2 failed). I then wrote the canonical
`skills/the-intern-docs/SKILL.md` and added `the-intern-docs` to `skill_names`
in `package-pi-skills.sh`, after which all 6 tests pass.

The SKILL.md has three parts:
- A description that triggers only on questions about bob or the Intern itself
  and explicitly excludes unrelated work such as email, worklog and tasks.
- A topic table pointing at exactly the five fixed paths
  `references/{quickstart,end-user-guide,operator-guide,architecture-overview,extension-author-guide}/index.md`.
  It notes that the pages cross-link as `../<dir>/index.md`.
- An instruction to answer CLI questions from `bob --help` and
  `bob <subcommand> --help`, not from the prose pages.

It contains no operating policy, never tells the agent to act on bob, and has no
internal IDs. The no-IDs grep, the `git ls-files` check for the `.pi` tree and
the no-`references/` check from the task's Verification section all pass.

I did not regenerate or commit `.pi/skills/the-intern-docs/`. The test only
generates into a temp directory, so the repo tree is untouched. I wrote no
`references/` directory and no manual page copies. Nothing was tried and
rejected.

Remaining: T-232 must add the build-time page embedding and commit the generated
`.pi/skills/the-intern-docs/` tree together with it. Committing the tree earlier
would embed an index with no pages and break the `init_assets` tests. Reviewer
note: the AC-1 test label still says "three skills", which I left unchanged.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->
