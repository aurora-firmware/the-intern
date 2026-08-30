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

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->
