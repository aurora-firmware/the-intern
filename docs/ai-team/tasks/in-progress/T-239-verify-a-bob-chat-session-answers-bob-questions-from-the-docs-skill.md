---
id: T-239
title: Verify a bob chat session answers bob questions from the docs skill
status: in-progress
priority: medium
assigned-role: developer
created: '2026-10-13'
---

# Verify a bob chat session answers bob questions from the docs skill

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

Live-verify the end goal of issue #138: a pi session bob spawns from an
arbitrary directory answers a question about bob from the `the-intern-docs`
skill (CR-016 Desired Changes; S-011 v0.3 Component 6; ADR-014 delivery).

Requires the real `pi` binary on `PATH` (project hard prerequisite — if it is
missing, stop and escalate; do not mock). Use the dev helpers so all state
stays under `.tmp/bob-dev`:
1. Build bob, then make the dev config admit the skill's tool calls:
   `./scripts/bob-dev.sh init <scratch-workspace>` (broad first-run profile)
   — without a `[policy]` section bob denies every action and the test
   would fail for the wrong reason. If `.tmp/bob-dev` already has a live
   config, `bob init` refuses without `--force`: use `--force` only on a
   scratch dev home, or keep and record the existing policy. Record which
   policy was used.
2. Refresh the dev skills: `./scripts/bob-dev.sh init --skills-only --force`;
   confirm `the-intern-docs/SKILL.md` and its five
   `references/<dir>/index.md` pages are present.
3. Start the service (`./scripts/run-bob-dev.sh`).
4. From a fresh empty directory with no skills, start a session and ask e.g.
   "How do I add a scheduled job in bob?" and "What does
   `bob init --skills-only` do?". Prefer `./scripts/bob-dev.sh chat`; if no
   TTY is available to the agent, a one-off scheduled job (or other
   bob-spawned run) with an empty working directory is equivalent evidence —
   all spawn paths receive skills the same way (S-011). If neither is
   possible, hand the task to a human with the steps above.
5. Confirm the session loads `the-intern-docs`, reads the relevant page
   and/or runs `bob ... --help`, and answers correctly; ask an unrelated
   coding question and confirm the skill is not loaded.
Record the transcript excerpts, the spawn path used, the pi version, and the
outcome in the Work Log. If the tested pi version differs from README.md's
compatibility section, update README.md. Run `./scripts/check-test-orphans.sh`
afterwards.

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

AC-1: WHEN a bob-spawned session started from a directory without any skills
      is asked how to use a bob feature THE SYSTEM SHALL answer from the
      `the-intern-docs` skill's reference pages or `bob --help`.
AC-2: WHEN the same session is asked an unrelated question THE SYSTEM SHALL
      not load the `the-intern-docs` skill.
AC-3: The Work Log shall record the policy used, the spawn path, the
      questions, transcript excerpts, the pi version, and the outcome.
AC-4: IF `pi` is not on `PATH` THEN the task shall be escalated, not
      substituted.

## Dependencies

- `T-233` — five-skill set installed by `bob init`
- `T-234` — manual pages readable as references

## Files to Touch

- `README.md` — only if the tested pi version differs from the compatibility section
- (otherwise none — evidence is recorded in this task's Work Log)

## Verification

```bash
# Manual — see Description steps 1–5; then:
find .tmp/bob-dev/data/bob/skills/the-intern-docs/references -name index.md
./scripts/check-test-orphans.sh
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
