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

### Session 1 — 2026-08-10

Implemented T-152 by extracting the canonical vendor-neutral email-triage skill source, following T-151's approach for himalaya (same pattern, more files). Read the (empty) Work Log first, then read the current pi-shaped copy at `the-intern/email-skills/.pi/skills/email-triage/{SKILL.md,references/worklog.md,references/escalation.md,references/categories/*.md}` and T-151's completed task file for precedent on treating this as a pure-content-relocation TDD cycle.

Since this task has no Rust/unit-test surface, the task's own `## Verification` diff command was treated as the TDD "test," extended with analogous diff checks for the rest of the `references/` tree (AC-1 covers the whole tree including `categories/`, but the task's Verification section only shows the `SKILL.md` diff explicitly). Three red→green cycles, each committed separately: (1) `SKILL.md` — confirmed the diff failed with "No such file or directory" before the canonical file existed, created it via `grep -v '^allowed-tools:'` over the pi copy to drop the pi-specific frontmatter field, then confirmed a clean diff (`b4964ab`); (2) `references/worklog.md` and `references/escalation.md` — same red/green shape, straight `cp` for both since neither has frontmatter to strip (`e31b1a1`); (3) `references/categories/*.md` (all 7 files: `README.md`, `automated-notification.md`, `direct-request.md`, `meeting-scheduling.md`, `newsletter-bulk.md`, `self-escalation.md`, `suspected-spam.md`) — confirmed all 7 diffs failed, then a single `cp` of the whole category directory, confirmed all 7 diffs pass (`c7b05ec`). Grouped the reference files into two cycles (top-level references, then category workflows) rather than one commit per file, matching T-151's granularity of one commit per meaningfully distinct unit of content rather than a maximally fine-grained per-file commit series.

After all files existed, ran closing checks instead of adding more code: AC-2 (`grep -c '^allowed-tools:'` on the canonical `SKILL.md` returns 0), AC-3 (`git diff --stat dev-agent -- .pi/skills/email-triage/` is empty, confirming the pi copy was never touched), the task's exact `## Verification` command (exit 0, empty diff), and two extra cross-checks not required by any single AC but useful given the larger file count here: a `diff -rq` of both trees' file lists (identical) and a full `diff -r` of the entire `references/` directory (empty, byte-identical). All passed without further changes.

Nothing was tried and rejected — task scope and target layout were unambiguous from T-151's precedent, S-011 Phase 2, and the task description; no boundary or dependency issues surfaced. Nothing remains for T-152 itself; per AC-3 the `.pi/skills/email-triage/` copy is intentionally left in place, to be replaced by T-153's generated packaging output later, and the worklog-diary content inside `references/worklog.md` was moved as-is (not reduced) since that split is explicitly out of scope until T-154/T-155. Working tree is clean on `task/T-152-canonical-email-triage-skill-source` with three commits ahead of `dev-agent`.

Obstacles Encountered:
- This task has no Rust/unit-test surface (pure markdown content relocation), so — following the T-151 precedent — the task's own diff-based `## Verification` command was treated as the TDD "test," extended with the same diff pattern for each additional file AC-1 covers (the task's Verification section shows only the `SKILL.md` diff explicitly, but AC-1 also covers the `references/` tree including `categories/`).

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->
