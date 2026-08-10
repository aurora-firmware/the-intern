---
id: T-154
title: Extract the domain-free worklog skill from email-triage
status: pending
priority: medium
assigned-role: developer
created: '2026-08-09'
spec: S-011
---

# Extract the domain-free worklog skill from email-triage

## Description

S-011 Implementation Order Phase 3, depends on Phase 2 (T-152). S-011
Component 4 requires a new `worklog` skill owning the entire diary
discipline — location, entry format, creation, first-run detection,
skip-tolerant reconciliation, and how an open item closes — with no
reference to email or any other domain, extracted from the diary-mechanics
content currently embedded in the canonical `email-triage` skill's
`references/worklog.md` (moved to canonical form by T-152). Create
`the-intern/email-skills/skills/worklog/{SKILL.md,references/}` as a new,
independent canonical skill carrying that discipline in domain-free
language. This task only creates the new `worklog` skill; it does not yet
remove the diary content from `email-triage` (that's T-155) or add
`worklog` to the pi packaging output (that's T-156).

## Acceptance Criteria

AC-1: The system shall provide `the-intern/email-skills/skills/worklog/SKILL.md`
      describing the diary discipline (location, entry format, first-run
      detection, reconciliation, closing an open item) without referencing
      email, himalaya, or any other domain.
AC-2: The system shall carry the diary-format and reconciliation reference
      content currently in
      `the-intern/email-skills/skills/email-triage/references/worklog.md`
      into the new `worklog` skill's own references.
AC-3: WHILE T-155 has not yet run THE SYSTEM SHALL leave the canonical
      `email-triage` skill's own worklog content unchanged, so no consumer
      of the canonical source loses diary instructions before the
      delegation reduction lands.

## Dependencies

- `T-152` — canonical email-triage source (containing the worklog reference
  content to extract from) must exist

## Files to Touch

- `the-intern/email-skills/skills/worklog/SKILL.md` — new
- `the-intern/email-skills/skills/worklog/references/*.md` — new (diary
  format, reconciliation rules)

## Verification

```bash
test -f the-intern/email-skills/skills/worklog/SKILL.md && \
  ! grep -qi "email\|himalaya" the-intern/email-skills/skills/worklog/SKILL.md
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
