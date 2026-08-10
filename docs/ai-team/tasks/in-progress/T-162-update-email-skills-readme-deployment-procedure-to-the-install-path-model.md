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

### Session 1 — 2026-08-10

Read the (empty) Work Log first, then S-011, T-161 (the completed operator-guide/quickstart counterpart, used as the reference model for install-path language), and the merge history/current filesystem state for T-151–T-153, T-156, T-163 (`skills/`, `.pi/skills/`, `claude/`, `package-pi-skills.sh`, `package-claude-skills.sh` all already exist on `dev-agent`; the README had never been updated to mention `worklog` as a third canonical skill or the `claude/` packaging target at all).

Two TDD cycles, each grep-based red/green-confirmed (same precedent T-150/T-155/T-156/T-161 established for markdown-authoring tasks with no control-flow surface), each committed separately:

1. **AC-1** (`ebe57ba`): rewrote the intro paragraph (now names all three shipped skills, including `worklog`, and both packaging targets) and the "Package layout" ASCII tree/prose to show the canonical `skills/` source with `himalaya`, `email-triage`, and `worklog`, and both generated targets `.pi/skills/` (T-153/T-156) and `claude/` (T-163). Added a "Regenerating the Claude package" subsection mirroring the existing "Regenerating the pi package" one, noting `claude/skills/` needs no vendor-specific frontmatter field (unlike `.pi/skills/`), matching T-163's own test assertion (`test_ac3_output_byte_identical_to_canonical_source`).
2. **AC-2** (`fe9ab41`): replaced "This package is the repository source of truth only" / "Verified deployed-workspace procedure" / "Verified S-004 action rules for the happy path" with "This package is installed once, service-wide — not copied per job" / "Verified install-path deployment procedure" / "Verified S-004 action rules for the install-path model" — the install-once-to-`skill_install_path` model, a job workspace holding only `config/`+`worklog/`, and S-004 rules scoped to `/abs/skill-install-path/...` (including two new, explicitly-flagged-as-not-yet-live-validated `worklog` skill read rules, and dropping the now-redundant absolute worklog-path rule in favor of the existing relative one — same reasoning T-161 applied to the operator guide). All T-139/T-140/B-029/B-030/B-031/B-034 historical evidence narrative was preserved verbatim since it documents what actually happened under the old (now superseded) model; added one paragraph explaining the `arguments.path`/`arguments.command` matcher-shape invariant is unaffected by which path the content lives at, so no fresh live probe was needed — same reasoning and same "no `pi` binary in this task's Dependencies" framing T-161 used for its own "re-validation."

Ran the task's `## Verification` block after each cycle and again at the end — all three commands pass. `git diff --stat dev-agent...task/T-162-email-skills-readme-install-path` confirms only `the-intern/email-skills/README.md` (the sole Files-to-Touch entry) was modified. Confirmed no other repo file (docs/src, test scripts) referenced either retired section heading. The task lifecycle file was not touched on this branch. Nothing remains for this task's two acceptance criteria.

Obstacles Encountered:
- The task's own `## Verification` grep for `"claude/"` was already trivially true before any edit, because line 7's pre-existing text `` `.claude/skills` `` contains that substring — so it could not be used as a meaningful red/green signal for AC-1. Used more specific greps (`package-claude-skills.sh`, `claude/skills/`, `diary-discipline skill`) as the actual red/green checks for that cycle instead, and still ran the literal task verification block at the end for the record.
- No `pi` binary or live credentials were used or needed — pure documentation task, same as T-161.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->
