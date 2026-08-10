---
id: T-163
title: Add Claude packaging target generating a Claude-shaped skill package from
  the canonical source
status: pending
priority: medium
assigned-role: developer
created: '2026-08-09'
spec: S-011
---

# Add Claude packaging target generating a Claude-shaped skill package from the canonical source

## Description

S-011 Implementation Order Phase 2/3. S-011's Purpose and System Diagram
require per-vendor packaging targets so "the same skill content is loadable
by both supported vendors from one source tree" — today only a pi target
exists (T-153/T-156). Add a second packaging target that generates a
Claude Code-shaped skill package from the canonical source under
`the-intern/email-skills/skills/{himalaya,email-triage,worklog}/`, with no
independent copy of body content. This is a **new, separate** packaging
target under `the-intern/email-skills/` (e.g.
`the-intern/email-skills/claude/`) — S-011's Exclusions explicitly state it
must not modify or absorb `the-intern/bob-companion/claude` (different
audience/release cadence). Use the frontmatter and layout conventions
already visible in `the-intern/bob-companion/claude/skills/*/SKILL.md` as
the reference shape for what a Claude Code skill file looks like (a
different concern — bob operator tooling — but the same vendor's file
format), and confirm the exact conventions against Claude Code's own skill
documentation rather than assuming this repo's example is exhaustive.

## Acceptance Criteria

AC-1: The system shall provide a packaging script that generates a Claude
      Code-shaped skill package (one `SKILL.md` per skill, following Claude
      Code's skill frontmatter/layout conventions) from the canonical
      source under `the-intern/email-skills/skills/`.
AC-2: The generated package shall live under a new location within
      `the-intern/email-skills/` (e.g. `the-intern/email-skills/claude/`)
      and the system shall not modify any file under
      `the-intern/bob-companion/claude/`.
AC-3: WHEN the Claude packaging script runs THE SYSTEM SHALL produce output
      for all three canonical skills (`himalaya`, `email-triage`, `worklog`)
      — including each skill's full `references/` tree (e.g.
      `email-triage/references/categories/*`) — whose content is
      byte-for-byte identical to the canonical source.
AC-4: The system shall provide a Claude Code plugin manifest at
      `the-intern/email-skills/claude/.claude-plugin/plugin.json`, mirroring
      the shape of `the-intern/bob-companion/claude/.claude-plugin/plugin.json`
      with this package's own name and description, carrying no skill body
      content (manifest and layout only, per S-011's Design Principles).

## Dependencies

- `T-151` — canonical himalaya source must exist
- `T-152` — canonical email-triage source must exist
- `T-154` — canonical worklog source must exist
- `T-155` — the last task that changes canonical content; generating this
  target before the email-triage reduction lands would commit a Claude
  package carrying pre-reduction diary content that no later task
  regenerates (Gate 2 dependency correction, 2026-08-09)

## Files to Touch

- `the-intern/email-skills/package-claude-skills.sh` (or equivalent) — new
  packaging script
- `the-intern/email-skills/claude/skills/himalaya/SKILL.md` — new generated
  output
- `the-intern/email-skills/claude/skills/email-triage/SKILL.md` — new
  generated output
- `the-intern/email-skills/claude/skills/worklog/SKILL.md` — new generated
  output
- `the-intern/email-skills/claude/skills/*/references/**` — new generated
  output (full reference trees for all three skills)
- `the-intern/email-skills/claude/.claude-plugin/plugin.json` — new manifest

## Verification

```bash
cd the-intern/email-skills && ./package-claude-skills.sh && \
  test -f claude/.claude-plugin/plugin.json && \
  test -f claude/skills/himalaya/SKILL.md && \
  test -f claude/skills/email-triage/SKILL.md && \
  test -f claude/skills/worklog/SKILL.md && \
  diff -r skills/himalaya/references claude/skills/himalaya/references && \
  diff -r skills/email-triage/references claude/skills/email-triage/references && \
  diff -r skills/worklog/references claude/skills/worklog/references
```

The reference trees are compared with `diff -r` against the canonical source
rather than asserted as named files, because T-155 (a dependency of this
task) may delete `skills/email-triage/references/worklog.md` — a named
`test -f claude/skills/email-triage/references/worklog.md` would then fail a
correct implementation. `diff -r` stays correct either way, and additionally
proves AC-3's byte-for-byte identity and catches stale files in the
generated tree (Gate 2 verification correction, 2026-08-09).

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
