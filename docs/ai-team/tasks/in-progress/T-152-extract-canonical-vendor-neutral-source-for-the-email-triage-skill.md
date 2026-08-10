---
id: T-152
title: Extract canonical vendor-neutral source for the email-triage skill
status: pending
priority: medium
assigned-role: developer
created: '2026-08-09'
spec: S-011
---

# Extract canonical vendor-neutral source for the email-triage skill

## Description

S-011 Implementation Order Phase 2 — the email-triage half of the same
restructuring T-151 does for himalaya. Move
`the-intern/email-skills/.pi/skills/email-triage/{SKILL.md,references/*.md}`
to a new canonical location
`the-intern/email-skills/skills/email-triage/{SKILL.md,references/*.md}`,
removing the same pi-specific `allowed-tools` frontmatter field. This task
moves the skill as it exists today, including its current worklog-related
content — Phase 3 (T-154/T-155) is what actually extracts the diary
mechanics into a separate `worklog` skill and reduces this one to delegate to
it, so this task must not attempt that split. Leave
`the-intern/email-skills/.pi/skills/email-triage/` untouched until T-153
packages from the new canonical source.

## Acceptance Criteria

AC-1: The system shall provide
      `the-intern/email-skills/skills/email-triage/SKILL.md` and its
      `references/` tree (including `categories/`) as the canonical source,
      containing the same content as the current `.pi/skills/email-triage/`
      copy.
AC-2: The canonical `SKILL.md`'s frontmatter shall not contain the
      `allowed-tools` field.
AC-3: The system shall not modify any diary/worklog-specific content during
      this move — that reduction is out of scope until T-155.

## Dependencies

- None

## Files to Touch

- `the-intern/email-skills/skills/email-triage/SKILL.md` — new canonical
  source
- `the-intern/email-skills/skills/email-triage/references/*.md` — new
  canonical source (worklog.md, escalation.md, categories/*)

## Verification

```bash
diff <(grep -v '^allowed-tools:' the-intern/email-skills/.pi/skills/email-triage/SKILL.md) \
     the-intern/email-skills/skills/email-triage/SKILL.md
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
