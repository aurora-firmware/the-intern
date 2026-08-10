---
id: T-162
title: Update email-skills README deployment procedure to the install-path model
status: pending
priority: medium
assigned-role: developer
created: '2026-08-09'
spec: S-011
---

# Update email-skills README deployment procedure to the install-path model

## Description

S-011 Implementation Order Phase 5 — the package-level counterpart to
T-161's user-manual update. `the-intern/email-skills/README.md`'s "Verified
deployed-workspace procedure" and "Verified S-004 action rules for the
happy path" sections still describe the per-workspace deployed-copy model
(T-139/T-140), which this spec replaces. Update them to describe the new
canonical-source + packaging-target layout (T-151–T-153, T-156) and the
install-path deployment/action-rule model (matching T-161), so the
package's own README stays the authoritative, accurate record for anyone
reading it directly rather than the user manual.

## Acceptance Criteria

AC-1: The system shall update `the-intern/email-skills/README.md`'s
      package-layout description to reflect one canonical `skills/` source
      with two generated packaging targets: `.pi/skills/` (T-151–T-153,
      T-156) and `claude/` (T-163).
AC-2: The system shall replace the "Verified deployed-workspace procedure"
      and "Verified S-004 action rules" sections' per-workspace
      deployed-copy guidance with the install-path deployment model.

## Dependencies

- `T-153` — packaging target exists (package layout to document)
- `T-156` — worklog skill packaged
- `T-161` — keeps the package README and the user-manual operator guide
  describing the same model
- `T-163` — the Claude packaging target is part of the package layout this
  task documents; no other task updates the README afterwards, so
  documenting the layout before that target exists leaves the package's own
  authoritative record incomplete (Gate 2 dependency correction, 2026-08-09)

## Files to Touch

- `the-intern/email-skills/README.md` — package layout and deployment
  procedure sections

## Verification

```bash
! grep -q "Verified deployed-workspace procedure" the-intern/email-skills/README.md
! grep -q "Verified S-004 action rules for the happy path" the-intern/email-skills/README.md
grep -q "claude/" the-intern/email-skills/README.md
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
