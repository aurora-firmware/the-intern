---
id: T-151
title: Extract canonical vendor-neutral source for the himalaya skill
status: pending
priority: medium
assigned-role: developer
created: '2026-08-09'
spec: S-011
---

# Extract canonical vendor-neutral source for the himalaya skill

## Description

S-011 Implementation Order Phase 2. Today the `himalaya` skill lives only as
pi-vendor-shaped content at
`the-intern/email-skills/.pi/skills/himalaya/{SKILL.md,references/*.md}`.
S-011 requires a canonical, vendor-neutral source that holds this content
exactly once, with per-vendor packaging (T-153) generating the pi-shaped
layout from it rather than the pi layout being hand-maintained directly.
Create `the-intern/email-skills/skills/himalaya/{SKILL.md,references/*.md}`
as that canonical source, moving the content there and removing the one
frontmatter field whose format is pi-specific (`allowed-tools: Read Bash`,
which has no equivalent in a vendor-neutral document — see S-011
Implementation Order Phase 2). Do not delete
`the-intern/email-skills/.pi/skills/himalaya/` yet — T-153 replaces it with
generated output once the packaging target exists, so the current
hand-written copy stays as the working pi package until then.

## Acceptance Criteria

AC-1: The system shall provide `the-intern/email-skills/skills/himalaya/SKILL.md`
      and its `references/` files as the canonical source, containing the same
      operational content as the current `.pi/skills/himalaya/` copy.
AC-2: The canonical `SKILL.md`'s frontmatter shall not contain the
      `allowed-tools` field.
AC-3: WHILE T-153 has not yet run THE SYSTEM SHALL leave
      `the-intern/email-skills/.pi/skills/himalaya/` unchanged so the existing
      pi package keeps working.

## Dependencies

- None

## Files to Touch

- `the-intern/email-skills/skills/himalaya/SKILL.md` — new canonical source
  (moved from `.pi/skills/himalaya/SKILL.md`, `allowed-tools` removed)
- `the-intern/email-skills/skills/himalaya/references/command-reference.md` —
  new canonical source (moved from `.pi/skills/himalaya/references/`)

## Verification

```bash
diff <(grep -v '^allowed-tools:' the-intern/email-skills/.pi/skills/himalaya/SKILL.md) \
     the-intern/email-skills/skills/himalaya/SKILL.md
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
