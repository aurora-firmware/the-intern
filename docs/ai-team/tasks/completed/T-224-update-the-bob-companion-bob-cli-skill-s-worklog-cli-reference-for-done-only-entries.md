---
id: T-224
title: Update the bob-companion bob-cli skill's worklog CLI reference for 
  Done-only entries
status: completed
priority: medium
assigned-role: developer
created: '2026-09-21'
---

# Update the bob-companion bob-cli skill's worklog CLI reference for Done-only entries

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

`the-intern/bob-companion/claude/skills/bob-cli/references/command-
reference.md`'s `## bob worklog [append|list]` section documents the
four-flag shape and `Done`/`Left`/`Next` output — `T-214` narrows the CLI
to `--item`/`--done` only. Rewrite the section's `append` subsection to
the one-field output shape (text and JSON), matching `T-213`'s precedent
for the equivalent earlier correction. The `list` subsection, cwd-strict/
ADR-015 paragraph, and file/permission behavior are unaffected.

## Acceptance Criteria

AC-1: The system shall not state that `bob worklog append` takes a
`--left` or `--next` flag.

AC-2: WHERE `bob worklog append` output is documented THE SYSTEM SHALL
show only a `Done`/`done` value, with no `Left`/`Next` field in either
text or JSON.

## Dependencies

- `T-214` — documents the CLI's actual final output shape

## Files to Touch

- `the-intern/bob-companion/claude/skills/bob-cli/references/command-reference.md`

## Verification

```bash
grep -n "\-\-left\|\-\-next\|Left:\|Next:\|\"left\"\|\"next\"" the-intern/bob-companion/claude/skills/bob-cli/references/command-reference.md
# expect no output
```

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

### Session 1 — 2026-09-21

Updated the owned command-reference section to the Done-only contract: append
requires only `--item` and `--done`, its text and JSON output describe only
Done, and same-day duplicate suppression compares Done alone. The specified
forbidden-term check was red before the edit and emitted no output afterward;
the diff is limited to the append material, leaving list, cwd, and permission
content unchanged. No deployed service was contacted. Ready for review.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->

### Review Verdict — 2026-09-21

PASS

Stage 1 passed. AC-1: the append signature and required-flags text name only
`--item` and `--done`; the required forbidden-term check against the task
branch emitted no output. AC-2: the append documentation retains only the
Done/`done` work description; no `Left`/`Next` value or JSON field is
documented. The `list` subsection, cwd-strict/ADR-015 content, and
file/permission behavior are unchanged. The branch diff contains only the
listed command-reference file.

Stage 2 passed. The focused documentation change matches the local
implementation: append accepts `item` and `done`, persists a single `Done`
value, and its status JSON remains `item`, `path`, `written`, and `warnings`.
No runtime behavior, service connection, security, performance, or test
isolation changes were introduced.

Next owner: active Development Loop.
