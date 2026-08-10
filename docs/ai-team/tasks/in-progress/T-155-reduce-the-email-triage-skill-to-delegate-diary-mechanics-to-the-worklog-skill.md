---
id: T-155
title: Reduce the email-triage skill to delegate diary mechanics to the worklog 
  skill
status: pending
priority: medium
assigned-role: developer
created: '2026-08-09'
spec: S-011
---

# Reduce the email-triage skill to delegate diary mechanics to the worklog skill

## Description

S-011 Implementation Order Phase 3, depends on T-154. Now that a standalone
`worklog` skill exists (T-154), remove the diary-mechanics instructions from
the canonical `email-triage` skill
(`the-intern/email-skills/skills/email-triage/SKILL.md` and its
`references/worklog.md`) and replace them with a delegation reference to the
`worklog` skill. `email-triage` keeps detection, classification, and the
act-or-escalate decision, plus its own retry of a carried-forward blocked
action (S-011 Responsibility Separation, `email-triage` row: "Delegates all
diary mechanics to `worklog`; retains retry of a carried-forward blocked
action"). This is a content reduction, not a rewrite of the triage policy
itself.

## Acceptance Criteria

AC-1: The system shall remove diary-mechanics instructions (entry format,
      first-run detection, reconciliation) from
      `the-intern/email-skills/skills/email-triage/SKILL.md` and its
      references, replacing them with an explicit pointer to the `worklog`
      skill.
AC-2: The system shall retain, in the canonical `email-triage` skill, the
      detection, classification, act-or-escalate decision, and
      carried-forward-blocked-action retry logic unchanged.
AC-3: WHEN the reduced `email-triage` skill is read together with the
      `worklog` skill THE SYSTEM SHALL contain the same complete diary
      discipline that existed before this reduction, with no instruction
      dropped.
AC-4: WHEN the canonical email-triage reduction lands THE SYSTEM SHALL
      regenerate the tracked `.pi/skills/email-triage/` output with T-153's
      packaging script and commit the result in the same change, so no
      committed generated file still carries diary content the canonical
      source no longer has.

## Dependencies

- `T-152` — canonical email-triage source (the files this task edits) must
  exist
- `T-154` — the `worklog` skill it delegates to must exist
- `T-153` — the pi packaging script must exist, because this task changes
  canonical content whose tracked generated `.pi/skills/email-triage/`
  output (T-153's decision: generated output stays committed) must be
  regenerated in the same change, or the repository carries two divergent
  copies of the skill content (Gate 2 dependency correction, 2026-08-09)
- `T-156` — `worklog` must already be in the pi package before the diary
  mechanics are removed from `email-triage`, so the committed package never
  ships without the diary discipline in either skill (Gate 2 dependency
  correction, 2026-08-09)

## Files to Touch

- `the-intern/email-skills/skills/email-triage/SKILL.md` — remove diary
  mechanics, add delegation pointer
- `the-intern/email-skills/skills/email-triage/references/worklog.md` —
  reduced to whatever email-triage-specific content (if any) remains, or
  removed if fully superseded by the `worklog` skill
- `the-intern/email-skills/.pi/skills/email-triage/SKILL.md` — regenerated
  (never hand-edited) to match the reduced canonical source
- `the-intern/email-skills/.pi/skills/email-triage/references/worklog.md` —
  regenerated (never hand-edited)

## Verification

```bash
grep -q "worklog" the-intern/email-skills/skills/email-triage/SKILL.md
cd the-intern/email-skills && ./package-pi-skills.sh && \
  git diff --exit-code HEAD -- .pi/skills
```

Run the second command after committing the regenerated output: it asserts
the *committed* `.pi/skills` tree matches the script's output, so an
uncommitted regeneration is a legitimate non-empty diff. It is meaningful
for a deleted reference file only because T-153 AC-4 requires the script to
regenerate each skill tree from scratch — if this task removes
`skills/email-triage/references/worklog.md`, the generated copy disappears
too and shows up as a deletion here.

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
