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

`S-015` (`CR-014`, v0.6) narrows the entry format to `Done` alone and
requires `append` calls to pass only `--item`/`--done`.
`the-intern/bob-skills/skills/worklog/SKILL.md` and
`references/entry-format.md` currently teach the three-bullet
`Done`/`Left`/`Next` shape and the four-flag `append` call. Rewrite both to
the one-field shape: the entry-format reference describes a header line
plus a single `Done` bullet; `SKILL.md`'s "Recording an entry" guidance
calls `bob worklog append` with `--item`/`--done` only. Leave the rest of
the skill's content (location resolution, tool usage, the same-day-repeat
description, the "this skill owns no domain policy" framing) unchanged
except where it names the retired fields.

## Acceptance Criteria

AC-1: The system shall not describe a `Left` or `Next` field, bullet, or
flag anywhere in `SKILL.md` or `references/entry-format.md`.

AC-2: WHERE `references/entry-format.md` describes an entry's shape THE
SYSTEM SHALL describe a header line followed by exactly one `- Done: …`
bullet.

AC-3: WHERE `SKILL.md` instructs a run to call `bob worklog append` THE
SYSTEM SHALL show only `--item` and `--done` as arguments.

## Dependencies

- None

## Files to Touch

- `the-intern/bob-skills/skills/worklog/SKILL.md`
- `the-intern/bob-skills/skills/worklog/references/entry-format.md`

## Verification

```bash
grep -rn "Left\|Next\|--left\|--next" the-intern/bob-skills/skills/worklog/SKILL.md the-intern/bob-skills/skills/worklog/references/entry-format.md
# expect no output
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
