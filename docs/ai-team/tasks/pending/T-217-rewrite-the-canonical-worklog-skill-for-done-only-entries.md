---
id: T-217
title: Rewrite the canonical worklog skill for Done-only entries
status: pending
priority: high
assigned-role: developer
created: '2026-09-21'
---

# Rewrite the canonical worklog skill for Done-only entries

<!--
Task Quality Rules (see the new-task skill for full details):
  - Atomic — one clear outcome.
  - One-shottable — ≤ 3–4 files touched, ≤ 5 ACs, Description ≈ 20 lines.
  - Verifiable — concrete Verification command or explicit manual steps.
  - Self-contained — Description is enough to start without follow-up questions.
  - EARS — every AC matches one of the five EARS patterns below.
  - Dependency-honest — list every prior task this one reads from or modifies.
-->

## Description

`S-015` (`CR-014`, v0.6) narrows the entry format to `Done` alone, requires
`append` calls to pass only `--item`/`--done`, and narrows same-day
duplicate suppression to compare `Done` alone.
`the-intern/bob-skills/skills/worklog/SKILL.md`,
`references/entry-format.md`, and `references/reconciliation.md` (the
canonical description of the same-day duplicate check — `CR-013` repurposed
this file's content without renaming it, so it reads as retired but is
live, shipped, and linked from `SKILL.md`) all still teach the three-bullet
`Done`/`Left`/`Next` shape, the four-flag `append` call, or a three-field
comparison. Rewrite all three to the one-field shape. Separately, per
`CR-014`'s Architecture Consistency Review (finding C), this skill's
generic item-identifier convention (`SKILL.md`'s "Recording an entry"
section) must state that distinct items get distinct identifiers, not only
that one item's identifier stays stable across recurrences — today it
states only the latter. Leave the rest of the skill's content (location
resolution, tool usage, the "this skill owns no domain policy" framing)
unchanged.

## Acceptance Criteria

AC-1: The system shall not describe a `Left` or `Next` field, bullet, or
flag, or a comparison of more than one field, anywhere in `SKILL.md`,
`references/entry-format.md`, or `references/reconciliation.md`.

AC-2: WHERE `references/entry-format.md` describes an entry's shape THE
SYSTEM SHALL describe a header line followed by exactly one `- Done: …`
bullet.

AC-3: WHERE `SKILL.md` instructs a run to call `bob worklog append` THE
SYSTEM SHALL show only `--item` and `--done` as arguments.

AC-4: WHERE `references/reconciliation.md` describes the same-day
duplicate check THE SYSTEM SHALL describe a comparison of `Done` alone,
not of three fields.

AC-5: WHERE `SKILL.md`'s item-identifier guidance exists THE SYSTEM SHALL
state that distinct items must get distinct identifiers, alongside the
existing requirement that one item's identifier stays the same across
recurrences.

## Dependencies

- None

## Files to Touch

- `the-intern/bob-skills/skills/worklog/SKILL.md` — narrow the `append`
  call shape; add the distinct-identifiers requirement to "Recording an
  entry"
- `the-intern/bob-skills/skills/worklog/references/entry-format.md` —
  narrow the entry shape to `Done` only
- `the-intern/bob-skills/skills/worklog/references/reconciliation.md` —
  narrow the duplicate-check description to compare `Done` alone

## Verification

```bash
grep -rn "Left\|Next\|--left\|--next\|three field" the-intern/bob-skills/skills/worklog/SKILL.md the-intern/bob-skills/skills/worklog/references/entry-format.md the-intern/bob-skills/skills/worklog/references/reconciliation.md
# expect no output
grep -n "distinct" the-intern/bob-skills/skills/worklog/SKILL.md
# expect at least one match
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
