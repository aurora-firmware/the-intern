---
id: T-210
title: Regenerate the pi skill package from the updated canonical worklog and 
  email-triage sources
status: pending
priority: high
assigned-role: developer
created: '2026-09-17'
---

# Regenerate the pi skill package from the updated canonical worklog and email-triage sources

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

`T-205`–`T-209` rewrite the canonical (`skills/`) worklog and email-triage
skill sources. The `.pi/skills/` tree is generated output
(`package-pi-skills.sh`); it must be regenerated so the packaged skills bob
actually installs match the rewritten canonical content, exactly as `T-199`
did for the equivalent earlier change. Also embed the freshly regenerated
package into the `bob` binary's asset table per the existing build wiring
(no new mechanism — same regenerate-and-rebuild step `T-199` performed).

## Acceptance Criteria

AC-1: WHEN `package-pi-skills.sh` runs THE SYSTEM SHALL produce
`.pi/skills/worklog/` and `.pi/skills/email-triage/` content byte-identical
to the rewritten canonical `skills/worklog/` and `skills/email-triage/`
source, in the packaging target's layout.

AC-2: The system shall not leave any generated `.pi/skills/worklog/` or
`.pi/skills/email-triage/` file containing "carried forward", "carry
forward", "reconcil", or "open worklog item" text.

AC-3: The system shall pass the package's own existing verification test
(`test_package_pi_skills.sh`) unchanged in shape, run against the
regenerated output.

## Dependencies

- `T-205` — rewritten canonical `worklog` skill source
- `T-206` — rewritten canonical `email-triage` `SKILL.md`/`worklog.md`
- `T-207` — rewritten canonical `email-triage` `escalation.md`
- `T-208` — rewritten canonical `email-triage` category workflows (batch A)
- `T-209` — rewritten canonical `email-triage` category workflows (batch B)

## Files to Touch

- `the-intern/bob-skills/.pi/skills/worklog/` — regenerated, not hand-edited
- `the-intern/bob-skills/.pi/skills/email-triage/` — regenerated, not
  hand-edited

## Verification

```bash
cd the-intern/bob-skills && ./package-pi-skills.sh && ./test_package_pi_skills.sh
grep -rn "carried forward\|carry forward\|reconcil\|open worklog item" .pi/skills/worklog .pi/skills/email-triage
# expect no output from the grep
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
