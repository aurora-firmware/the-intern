---
id: T-156
title: Add the worklog skill to the pi packaging target output
status: pending
priority: low
assigned-role: developer
created: '2026-08-09'
spec: S-011
---

# Add the worklog skill to the pi packaging target output

## Description

S-011 Implementation Order Phase 3, depends on T-153 (packaging target
exists) and T-154 (worklog skill content exists). Extend the packaging
script/target added in T-153 to also generate
`the-intern/email-skills/.pi/skills/worklog/SKILL.md` (+ references) from
the new canonical `worklog` skill, so the pi package ships three skills
(`himalaya`, `email-triage`, `worklog`) instead of two, matching S-011's
"one always-active set" design principle.

## Acceptance Criteria

AC-1: WHEN the packaging script runs THE SYSTEM SHALL additionally generate
      `.pi/skills/worklog/SKILL.md` (and its references) from the canonical
      `worklog` skill source.
AC-2: The generated `.pi/skills/worklog/SKILL.md` body content shall be
      byte-for-byte identical to the canonical `worklog` skill source, with
      the same `allowed-tools` frontmatter convention as the other two
      generated skills.

## Dependencies

- `T-153` — packaging script must exist
- `T-154` — canonical `worklog` skill source must exist

## Files to Touch

- `the-intern/email-skills/package-pi-skills.sh` (or equivalent, from
  T-153) — extend to include `worklog`
- `the-intern/email-skills/.pi/skills/worklog/SKILL.md` — new generated
  output

## Verification

```bash
cd the-intern/email-skills && ./package-pi-skills.sh && \
  test -f .pi/skills/worklog/SKILL.md && \
  diff <(grep -v '^allowed-tools:' .pi/skills/worklog/SKILL.md) skills/worklog/SKILL.md && \
  diff -r skills/worklog/references .pi/skills/worklog/references
```

The two `diff`s are what actually verify AC-2 (byte-for-byte identical body
plus the added frontmatter field) and AC-1's `references` half; a bare
`test -f` passes on a file the script wrote from anywhere (Gate 2
verification correction, 2026-08-09).

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
