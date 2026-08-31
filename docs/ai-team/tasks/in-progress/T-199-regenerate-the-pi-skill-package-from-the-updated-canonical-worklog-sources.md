---
id: T-199
title: Regenerate the pi skill package from the updated canonical worklog 
  sources
status: pending
priority: medium
assigned-role: developer
created: '2026-08-30'
---

# Regenerate the pi skill package from the updated canonical worklog sources

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

Closing step of Component 4: regenerate the pi packaging target from the
canonical, vendor-neutral skill source now that T-195 (the `worklog` skill)
and T-196 (the `email-triage` skill's worklog surface) have rewritten it.

Run `the-intern/bob-skills/package-pi-skills.sh` and commit the regenerated
output. That script already lists `worklog` and `email-triage` in its
`skill_names` array, so no script change is needed — this task only runs it
and commits the result. The affected regenerated files are:

- `.pi/skills/worklog/SKILL.md`, `.pi/skills/worklog/references/entry-format.md`,
  `.pi/skills/worklog/references/reconciliation.md`
- `.pi/skills/email-triage/SKILL.md`,
  `.pi/skills/email-triage/references/worklog.md`,
  `.pi/skills/email-triage/references/escalation.md` (T-196), and the six
  `.pi/skills/email-triage/references/categories/*.md` files (T-200)

Each regenerated `SKILL.md` differs from its canonical source only by the
`allowed-tools: Read Bash` frontmatter line the script injects; every other
file is a byte-for-byte copy. `test_package_pi_skills.sh` must pass.

## Acceptance Criteria

AC-1: WHEN `package-pi-skills.sh` is run THE SYSTEM SHALL exit 0 and update
the `.pi/skills/worklog/` and `.pi/skills/email-triage/` trees to match the
canonical source, each `SKILL.md` differing only by the injected
`allowed-tools` line.

AC-2: WHEN `test_package_pi_skills.sh` is run after regeneration THE SYSTEM
SHALL exit 0.

AC-3: WHEN regeneration is complete THE SYSTEM SHALL leave `git status`
clean under `the-intern/bob-skills/.pi/skills/` (all regenerated output
committed).

AC-4: The system shall make no change to `package-pi-skills.sh` itself.

## Dependencies

- `T-195` — rewrites the canonical `worklog` skill this task regenerates
- `T-196` — rewrites the canonical `email-triage` skill worklog surface this task regenerates
- `T-200` — rewrites the six `email-triage` category workflow files this task regenerates

## Files to Touch

- `the-intern/bob-skills/.pi/skills/worklog/**` — regenerated from `skills/worklog/`
- `the-intern/bob-skills/.pi/skills/email-triage/**` — regenerated from `skills/email-triage/` (`SKILL.md`, `references/worklog.md`, `references/escalation.md`, and `references/categories/*.md`)

## Verification

```bash
cd the-intern/bob-skills && ./package-pi-skills.sh && ./test_package_pi_skills.sh && git status --porcelain .pi
```

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

### Session 1 — 2026-08-31

Pure regeneration task closing Component 4. Read the empty Work Log, then the packaging script (`the-intern/bob-skills/package-pi-skills.sh`) and its guard test (`the-intern/bob-skills/test_package_pi_skills.sh`).

Red observation: the guard test itself always passes because it runs against an isolated `mktemp` copy of the canonical source, so it cannot detect drift in the tracked `.pi/` tree. I established the real red signal by diffing the canonical `skills/worklog/SKILL.md` and `skills/email-triage/SKILL.md` against their `.pi/skills/` copies (stripped of the injected `allowed-tools: Read Bash` line). Both were substantially stale versus the T-195 / T-196 / T-200 rewrites — the old copies still described `worklog` as the diary-mechanics owner rather than delegating to the `bob worklog` command.

Green: ran `./package-pi-skills.sh` (exit 0), then `./test_package_pi_skills.sh` (5 passed, 0 failed, exit 0). Regeneration modified 12 files, all confined to `the-intern/bob-skills/.pi/skills/` — the `worklog` tree (SKILL.md + references/entry-format.md + references/reconciliation.md) and the `email-triage` tree (SKILL.md + references/worklog.md, escalation.md, and all six categories/*.md plus the categories/README.md byte match unchanged). The `himalaya` and `tasks` trees regenerated to byte-identical output (no diff), confirming the change is scoped to the two rewritten skills.

Verification of the copy contract: wrote a throwaway check (not committed) that, for every skill, (a) confirms `.pi/.../SKILL.md` with the `allowed-tools: Read Bash` line removed is `diff`-identical to its canonical source, (b) confirms that line appears exactly once, and (c) `cmp`s every non-SKILL.md file byte-for-byte against canonical. All 20 checks passed.

Committed the regenerated output on the task branch as `chore(bob-skills): regenerate pi skill package from canonical worklog sources` (03ea2e1). `package-pi-skills.sh` and `test_package_pi_skills.sh` are untouched (AC-4). Post-commit re-run of the full verification command (`./package-pi-skills.sh && ./test_package_pi_skills.sh && git status --porcelain .pi`) is clean and idempotent — the committed tree is exactly what the script produces.

Nothing tried and rejected beyond noting that authoring a new unit test was not applicable (the task's TDD adaptation says the existing guard test is the red/green gate). Nothing remains.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->

### Review Verdict — 2026-08-31

PASS

Reviewed branch `task/T-199-...` at `03ea2e1` (1 commit ahead of `dev-agent`),
diff `git diff dev-agent...03ea2e1`: 12 files changed, all under
`the-intern/bob-skills/.pi/skills/worklog/` and `.pi/skills/email-triage/`.

Stage 1 — acceptance (all four ACs met):

- AC-1: In a clean detached worktree at `03ea2e1`,
  `cd the-intern/bob-skills && ./package-pi-skills.sh` exits 0. Direct
  copy-contract check over all four packaged skills: each `.pi/.../SKILL.md`
  with the single `allowed-tools: Read Bash` line stripped is `diff`-identical
  to its canonical `skills/.../SKILL.md`, and that line appears exactly once;
  every non-SKILL.md file (`references/*.md`,
  `references/categories/*.md`, `references/categories/README.md`) is
  `cmp`-identical byte-for-byte to canonical. No canonical file is missing
  from the `.pi` tree and no stale `.pi` file remains. 16 file checks + 4
  SKILL.md checks all pass.
- AC-2: `./test_package_pi_skills.sh` after regeneration exits 0 — 5 passed,
  0 failed.
- AC-3: After running the script on the branch-head checkout,
  `git status --porcelain` (whole tree, and scoped to `.pi/skills/`) is
  empty — the committed `.pi/` tree is byte-for-byte what the script
  produces (idempotent).
- AC-4: `git diff dev-agent...03ea2e1 -- the-intern/bob-skills/package-pi-skills.sh`
  is empty; `test_package_pi_skills.sh` is likewise untouched.

Stage 2 — code/quality review over the diff:

- Regenerated content reflects the T-195 / T-196 / T-200 canonical rewrites:
  `worklog/SKILL.md`, `references/entry-format.md`, and
  `references/reconciliation.md` now delegate all diary mechanics (file
  location, creation, entry format, first-run detection, carry-forward) to
  the `bob worklog` command (`bob worklog list` / `bob worklog append`);
  `email-triage/SKILL.md`, `references/worklog.md`, `references/escalation.md`,
  and all six `references/categories/*.md` files updated to the
  `bob worklog append` surface and the "reconciled automatically on every
  call" model.
- Scope confined to the two rewritten skills: the `himalaya` and `tasks`
  `.pi` trees are not in the diff and regenerate to byte-identical output.
- No implementation code, script, or task lifecycle file modified on the
  branch (`git diff --name-only dev-agent...03ea2e1 -- 'docs/ai-team/**'`
  is empty).

No blocking or minor observations. Next owner: Development Loop.
