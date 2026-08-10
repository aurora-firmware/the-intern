---
id: T-151
title: Extract canonical vendor-neutral source for the himalaya skill
status: completed
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

### Session 1 — 2026-08-10

Implemented T-151 by extracting the canonical vendor-neutral himalaya skill source. Read the (empty) Work Log first, then read the existing pi-shaped copy at `the-intern/email-skills/.pi/skills/himalaya/{SKILL.md,references/command-reference.md}` and S-011 (Purpose, Architecture, Responsibility Separation, and Implementation Order Phase 2) to confirm the target layout `the-intern/email-skills/skills/himalaya/`.

Since this task is pure content relocation with no Rust/unit-test surface, the task's own `## Verification` diff command was treated as the TDD "test," extended with the same diff-based check for `references/command-reference.md` (AC-1 covers both files, but the task's Verification section only showed the SKILL.md diff explicitly). Two red→green cycles: (1) `SKILL.md` — confirmed the diff failed with "No such file" before the canonical file existed, then created it via `grep -v '^allowed-tools:'` over the pi copy so the pi-specific frontmatter field is dropped, then confirmed a clean (empty) diff; (2) `references/command-reference.md` — same red/green shape, but a straight `cp` since no frontmatter field needed removing there. Committed each cycle separately (`dac6b41`, `d7bc0df`).

After both files existed, ran three closing checks rather than adding more code: AC-2 (`grep -c '^allowed-tools:'` on the canonical `SKILL.md` returns 0), AC-3 (`git diff --stat dev-agent -- the-intern/email-skills/.pi/skills/himalaya/` is empty, confirming the pi copy was never touched), and the task's exact `## Verification` command (exit 0, no diff). All three passed without further changes, so no additional commit was needed for them.

Nothing was tried and rejected — the task's scope and target layout were unambiguous from S-011 and the task description, and no boundary or dependency issues surfaced. Nothing remains for T-151 itself; the `.pi/skills/himalaya/` copy is intentionally left in place per AC-3, to be replaced by T-153's generated packaging output later. Working tree is clean on `task/T-151-canonical-himalaya-skill-source` with two commits ahead of `dev-agent`.

Obstacles Encountered:
- This task has no Rust/unit-test surface (pure markdown content relocation), so the TDD red/green cycle used the task's own diff-based verification command (extended with an analogous diff for `references/command-reference.md`, since AC-1 covers both files but the task's Verification section only shows the SKILL.md diff explicitly) as the "test" instead of a code test file.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->

### Review Verdict — 2026-08-10

PASS

**Stage 1 — Acceptance Criteria:**
- AC-1 (canonical `SKILL.md` and `references/command-reference.md` exist with the same operational content as the `.pi/skills/himalaya/` copy): met. Diffed both files' content in the branch (`task/T-151-canonical-himalaya-skill-source`, commits `dac6b41`, `d7bc0df`) against the untouched `.pi/skills/himalaya/` copy in a scratch worktree — `SKILL.md` differs only by the removed `allowed-tools` line, and `references/command-reference.md` is byte-identical.
- AC-2 (canonical `SKILL.md` frontmatter has no `allowed-tools` field): met. `grep -c '^allowed-tools:' the-intern/email-skills/skills/himalaya/SKILL.md` returns 0.
- AC-3 (`.pi/skills/himalaya/` left unchanged): met. `git diff dev-agent..task/T-151-canonical-himalaya-skill-source --stat -- the-intern/email-skills/.pi/skills/himalaya/` is empty; the branch's full file list touches only the two new canonical files plus the task file's own Work Log.
- No unspecified behavior or files outside the task's declared scope were touched.

**Stage 2 — Code Quality:**
- Correctness: content relocation is exact (verified via diff, not by inspection alone); the one frontmatter field removed is precisely the pi-specific one named in the task description.
- Tests: this task has no code/unit-test surface. The task's own `## Verification` diff command was run directly against the branch and passes with exit 0 and an empty diff; the analogous check for `references/command-reference.md` also passes. Treating the verification command as the test here is appropriate for a pure-content-relocation task.
- Security: N/A (markdown content only, no secrets, no external input).
- Readability: N/A (content moved verbatim; no restructuring).
- Performance: N/A.
- Commits (`dac6b41`, `d7bc0df`) follow `git-conventions` (type `feat`, scope `email-skills`, imperative, no task ID repeated, ≤72 chars).

No blocking issues found.
