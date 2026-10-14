---
id: T-239
title: Verify a bob chat session answers bob questions from the docs skill
status: completed
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

### Session 1 — 2026-10-14

**Policy used.** I kept the existing `.tmp/bob-dev` live config and ran no `bob init --force`, so nothing of the user's was overwritten. Its `[policy]` is `admitted_users = []` with four unconstrained `[[policy.action_rules]]` for the `bash`, `read`, `write` and `edit` tools. That admits the skill's `read` and `bob ... --help` `bash` calls, so no scratch dev home was needed. `pi_agent_idle_reap_timeout = "30s"` was also set.

**Setup.**
- `cargo build -p bob` was already up to date.
- `./scripts/bob-dev.sh init --skills-only --force` installed `the-intern-docs/SKILL.md` and all five `references/<dir>/index.md` pages (architecture-overview, end-user-guide, extension-author-guide, operator-guide, quickstart).
- I started the service with `./scripts/run-bob-dev.sh` (`bob status` returned ok, version 0.14.0-71-g5c9ceb0).
- pi version: **0.87.1** (`/home/daneel/.npm-global/bin/pi`), the same as README's installed-CLI entry.

**Spawn path.**
- `bob chat` needs a TTY, and there was none. I rejected faking a pty.
- Instead I used one-off scheduled jobs. Each was added with `bob schedule add --cron "* * * * *" --cwd <fresh empty dir> --prompt ...`, in its own empty directory under the scratchpad (confirmed empty with `ls -A`). I removed each job after its first firing.
- The jobs were `t239-q1`, `t239-q2` and `t239-q3`. The service spawned pi for each, which received skills via the shared skill path (S-011).
- Transcripts: `~/.pi/agent/sessions/--tmp-claude-1000--home-daneel-projects-the-intern-1f520645-a6c6-4f30-978b-41c8f6ea6f0f-scratchpad-empty{1,2,3}--/` (first-fired session in each).

**Questions and observed behavior** (first-fired session of each job):

1. Q1: "How do I add a scheduled job in bob? Answer briefly."
   - pi called `read` on `.tmp/bob-dev/data/bob/skills/the-intern-docs/SKILL.md`.
   - It then read `references/operator-guide/index.md`, and ran `bob --help && bob schedule --help` and `bob schedule add --help`.
   - Answer: "Use `bob schedule add` with an ID and cron expression: `bob schedule add --id daily-check --cron "0 9 * * *" --prompt "Check email" --cwd /absolute/workspace/path`. Use `--file prompt.txt` instead of `--prompt` to read the prompt from a file."
   - The flags match the real `bob schedule add --help`, so the answer is correct.
2. Q2: "What does `bob init --skills-only` do? Answer briefly."
   - pi read the same `SKILL.md`, then ran `bob init --help`.
   - Answer: "`bob init --skills-only` installs or refreshes only the shared skill package, without creating or modifying a workspace or live config. Existing skill files are preserved unless you also pass `--force`."
   - This matches the `bob init --help` text.
3. Q3 (unrelated): "Write a Python function that reverses a string. Answer briefly, do not create files."
   - pi made **no tool calls**, so no skill was read.
   - Answer: `def reverse_string(s: str) -> str: return s[::-1]`.

**Outcome.**
- AC-1 met: both bob questions were answered from the `the-intern-docs` skill (SKILL.md plus a reference page and/or `bob ... --help`), and the answers are correct.
- AC-2 met: the unrelated coding question was answered with zero tool calls, and the skill was not loaded.
- AC-3: this entry records the policy, spawn path, questions, excerpts, pi version and outcome.
- AC-4 not triggered: `pi` was on `PATH`, and nothing was mocked or substituted.

**Housekeeping.**
- I changed no README (the tested pi 0.87.1 equals the recorded installed-CLI version) and committed nothing on the task branch.
- I stopped the dev service and `./scripts/check-test-orphans.sh` reported no orphans.
- The user's own pre-existing scheduled jobs in the dev home (`funny-log-every-minute`, `try_files`) also fired during the run; I left them untouched and removed only my three jobs.

**Remaining.** Nothing. A human could still run an interactive `./scripts/bob-dev.sh chat` check, but the task treats this path as equivalent evidence.

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

Stage 1 (acceptance criteria), checked independently:
- AC-1 met: the pi transcripts for empty1 and empty2 show `read` of `the-intern-docs/SKILL.md` first. Q1 then read `references/operator-guide/index.md` and ran `bob --help`, `bob schedule --help` and `bob schedule add --help`. Q2 ran `bob init --help`. The sessions ran from fresh empty cwds.
- AC-2 met: all three empty3 sessions made zero tool calls and answered the Python question directly, so no skill was loaded.
- AC-3 met: the Work Log records the policy (the existing dev config's `[policy]` with unconstrained bash/read/write/edit rules), the spawn path (one-off scheduled jobs in empty cwds), the questions, excerpts, pi version 0.87.1 and the outcome.
- AC-4 not triggered: `pi --version` returns 0.87.1.
- The branch has no commits ahead of `dev-agent`. README's pi 0.87.1 entry matches, so no README change was needed.
- `find ... -name index.md` lists all five reference pages. `./scripts/check-test-orphans.sh` reports no orphans.
- The scheduled-job spawn path is the task's permitted fallback when no TTY is available, and it is equivalent under S-011.

Stage 2 (code quality): not applicable, since no code changed.

Non-blocking observations:
- Each job fired more than once, so there are extra sessions per directory. All of them show consistent behavior.
- An interactive `bob chat` check remains optional for a human.
