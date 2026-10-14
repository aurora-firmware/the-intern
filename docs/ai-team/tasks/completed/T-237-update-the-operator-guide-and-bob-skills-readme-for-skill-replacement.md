---
id: T-237
title: Update the operator guide and bob-skills README for skill replacement
status: completed
priority: medium
assigned-role: developer
created: '2026-10-13'
---

# Update the operator guide and bob-skills README for skill replacement

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

Update the operator guide and `bob-skills/README.md` for the new install and
skill-folder behaviour and the docs skill's action rules (CR-016 items 6, 8;
S-013 v0.4 Component 5; S-011 v0.3 action rules; S-012 v0.4).

Operator guide (`the-intern/docs/src/operator-guide/index.md`):
- The `--skills-only` section (~lines 215–242): it installs at the default
  skill install path resolved from the environment alone — it never reads
  `config.toml` or follows a `skill_install_path` override (the current text
  says "at `skill_install_path`", which is wrong). Lines ~233–242 also say
  `install.sh` never passes `--force` and tell the operator to rerun
  `bob init --skills-only` after a failure — replace with the new contract:
  the folder is replaced, and the recovery is to rerun `install.sh`.
- Zip install / "Upgrading a running install": `install.sh` asks before
  overwriting whenever a binary or installed skills exist (also on a
  same-version reinstall), warns when the binary differs or skills exist
  without a binary, `-y` skips the prompt, and the whole default skill folder
  is emptied and refilled on every install — local edits are not kept and
  nothing else should be kept in that folder; a failed skill step can leave
  skills missing until `install.sh` is rerun; a configured
  `skill_install_path` override is not refreshed by `install.sh`.
- Non-zip upgrades (`mise`, Cargo): refresh installed skills, the manual
  included, with `bob init --skills-only --force`; pages or skills a release
  drops linger until the next `install.sh` run.
- Narrowed action-rule listing (~lines 1214–1270): add `read` rules for the
  docs skill's `.../the-intern-docs/SKILL.md` and
  `.../the-intern-docs/references/*.md` at the skill install path, and
  `bash` rules for `bob --help` plus one exact `bob <subcommand> --help`
  pattern per subcommand — exact patterns with no wildcard, following the
  guide's own convention (~lines 1425–1427); a pattern like `bob *--help`
  would also admit chained commands. Note the broad first-run ruleset
  already admits both.
`bob-skills/README.md`: list the fifth skill, say its canonical source has no
`references/` (the pages are copied from the manual at build time), and add
the same rules to its rule listing (~lines 224–344). No internal IDs; follow
`coding-guidelines-skills.md` §1–2.

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

AC-1: The operator guide shall state that `bob init --skills-only` uses the
      default skill install path resolved from the environment and never
      follows a `skill_install_path` override.
AC-2: The operator guide shall describe the install prompt, its warnings,
      `-y`, the whole-folder replacement on every install, that nothing else
      should be kept in that folder, and the rerun recovery for a failed
      skill step.
AC-3: The operator guide shall tell `mise`/Cargo upgraders to run
      `bob init --skills-only --force` and that dropped pages linger until
      the next `install.sh` run.
AC-4: The operator guide's and `bob-skills/README.md`'s narrowed rule listings
      shall each include read rules for the docs skill's `SKILL.md` and
      `references/*.md`, and exact, wildcard-free bash rules for
      `bob --help` and each `bob <subcommand> --help`; `bob-skills/README.md`
      shall list five skills.
AC-5: The added text shall contain no internal task/bug/spec/ADR/issue IDs.

## Dependencies

- `T-234` — earlier edits to the operator guide (sequencing on the same file)
- `T-236` — final `install.sh` behaviour and wording the guide describes

## Files to Touch

- `the-intern/docs/src/operator-guide/index.md` — `--skills-only`, install/upgrade, non-zip upgrade, narrowed rules
- `the-intern/bob-skills/README.md` — fifth skill, rule listing

## Verification

```bash
mdbook build the-intern/docs
grep -n -- "-y\b\|--skills-only --force\|the-intern-docs\|--help" the-intern/docs/src/operator-guide/index.md the-intern/bob-skills/README.md
! git diff -U0 "$(git merge-base dev-agent HEAD)" -- the-intern/docs/src/operator-guide/index.md the-intern/bob-skills/README.md | grep '^+[^+]' | grep -nE "\b(T|B|S|CR)-[0-9]{3}\b|ADR-[0-9]{3}|#[0-9]{2,}" 
bash the-intern/docs/test_operator_guide_email_triage_trust.sh
```

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

### Session 1 — 2026-10-14

I read the task, CR-016-related install behaviour in `install.sh` and `README.txt`, and the existing guide and `bob-skills` README sections. First I wrote a throwaway grep script in the scratchpad that encoded AC-1 to AC-4 and confirmed it failed everywhere. Then I rewrote the operator guide in two steps.

Install and upgrade prose, committed first:
- The `--skills-only` paragraph now says the default path is resolved from the environment alone, and that `config.toml` and `skill_install_path` overrides are never read or followed.
- "Upgrading a running install" gained a bullet list covering the overwrite prompt, the two warnings, `-y`, whole-folder replacement with nothing else kept in that folder, the failed-skill-step state with the rerun-`install.sh` recovery, and the unrefreshed override.
- I replaced the "zip install already does this for you" paragraph with the new replace-and-rerun contract.
- I added a `mise`/Cargo/source-build paragraph telling those users to run `bob init --skills-only --force`, with the note that dropped pages linger until the next `install.sh` run.

Rule listings and README, committed second:
- Both narrowed rule listings now carry the two docs-skill read rules and exact `bob --help` plus ten `bob <subcommand> --help` bash rules. I took the subcommand list from `bob --help` output and skipped the built-in `help` subcommand.
- Each listing has a note explaining why the patterns are exact and wildcard-free. The guide's note adds that `bob task*` and `bob worklog*` already admit two of them and that the first-run ruleset admits all of them.
- The README now says five skills and lists `the-intern-docs` in the layout and the `.pi/skills` tree, with a note that its canonical source has no `references/` because the pages are copied at build time. I put the `the-intern-docs` tree entry before `tasks` so existing ID-bearing lines stayed unchanged.

Tried and rejected: I first re-wrapped the README intro sentence and tree lines, which dragged existing IDs into the diff's added lines and failed the AC-5 check. I redid those edits so the old lines stay byte-identical.

I did not touch the generated `.pi/skills` mirror or any lifecycle file. Remaining: only the reviewer's pass over the diff. Existing internal IDs elsewhere in the README remain, since they were outside this task's added text.

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

Stage 1 (acceptance): all five criteria met, verified on the task branch.
- AC-1: the `--skills-only` text now says the default path is resolved from the environment alone and that `config.toml` / `skill_install_path` are never read or followed.
- AC-2: the prompt, both warnings, `-y`, whole-folder replacement, "keep nothing else there", and the rerun-`install.sh` recovery are described. Checked against `the-intern/install-bundle/install.sh`: prompt on binary or any skill-folder entry (same version included), warning wording, `-y` still prints warnings, `rm -rf` then `init --skills-only`, failed step is a warning only, override never touched. All match.
- AC-3: the `mise`/Cargo/source-build paragraph gives `bob init --skills-only --force` and says dropped pages linger until the next `install.sh` run.
- AC-4: both listings carry the two `the-intern-docs` read rules and exact, wildcard-free `bob --help` plus ten `bob <subcommand> --help` rules. These match `bob --help` (init, task, serve, status, sessions, audit, policy, schedule, chat, worklog; built-in `help` skipped) and the guide's exact-pattern convention for `himalaya template write`. The README lists five skills and says the canonical source has no `references/`.
- AC-5: the added-lines ID check finds nothing.
- Only the two listed files changed.

Verification rerun: `mdbook build` succeeds; the grep matches in both files; the ID check is clean; `test_operator_guide_email_triage_trust.sh` passes 7/7.

Stage 2 (quality): coding-guidelines-skills.md §1 (no internal IDs in added text) and §2 (no environment-specific values; placeholder paths) are respected. The prose is accurate and consistent between the guide and the README.

Non-blocking observations:
- The guide says "any answer other than `y`" stops the install, but `install.sh` also accepts `Y`.
- The guide says "different version", but `install.sh` compares binary bytes with `cmp`. Behaviour is equivalent in practice.
- Pre-existing internal IDs elsewhere in the README are outside this task's scope.
