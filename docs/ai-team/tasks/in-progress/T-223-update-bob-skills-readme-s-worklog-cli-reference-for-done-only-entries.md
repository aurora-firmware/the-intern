---
id: T-223
title: Update bob-skills README's worklog CLI reference for Done-only entries
status: pending
priority: medium
assigned-role: developer
created: '2026-09-21'
---

# Update bob-skills README's worklog CLI reference for Done-only entries

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

`the-intern/bob-skills/README.md`'s worklog action-rule passage (the
`bob worklog*` matcher's stability explanation, ~line 366) enumerates the
command's flags in free text as `--item`/`--done`/`--left`/`--next` —
`T-214` narrows the CLI to `--item`/`--done` only. Rewrite that
enumeration to the two-flag shape; the action-rule matcher itself is
unaffected. **Do not touch the
[Validation outcomes](#validation-outcomes) section** (the T-139/T-140/
T-164 live-run history, ~line 476) — it quotes a fixture worklog entry's
`Next` line as historical record of what that live run actually observed,
and `S-015` Component 5 requires historical validation-outcome records to
stay exactly as written, even where they quote a since-retired field name.

## Acceptance Criteria

AC-1: The system shall not state that a `bob worklog append` call carries
a `--left` or `--next` value anywhere outside the Validation outcomes
section.

AC-2: The system shall leave the Validation outcomes section's historical
quotations, including its `Next` line, unchanged.

## Dependencies

- `T-214` — documents the CLI's actual final flag/output shape

## Files to Touch

- `the-intern/bob-skills/README.md`

## Verification

```bash
sed '/^## Validation outcomes$/,$d' the-intern/bob-skills/README.md \
  | grep -nE -- '--left|--next|Left:|Next:'
# expect no output
```

Also inspect the diff to confirm that no content at or below the
`## Validation outcomes` heading changed.

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

### Session 2 — 2026-09-21

Following Architect guidance, narrowed the stale-term check to content before
`## Validation outcomes`, preserving the historical record below that heading.
Updated the worklog matcher explanation to list only `--item` and `--done`.
The scoped check was red before the edit and passed afterward; the one-line
diff is entirely above the protected section. The original whole-file check
was rejected because it contradicted the required historical `Next` quotation.
No deployed service was contacted. Ready for review.

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

Stage 1 passed. AC-1 is met: the source-branch scoped verification emitted no
matches for `--left`, `--next`, `Left:`, or `Next:` before `## Validation
outcomes`; the updated matcher explanation lists only `--item` and `--done`.
AC-2 is met: the implementation diff is a single line above that heading, with
no changes in the protected historical section, including its `Next` quotation.

Stage 2 passed. The one-line documentation correction is precise, readable,
and introduces no unrelated behavior. No automated tests apply to this
documentation-only change; the task's prescribed scoped verification passed.

Next owner: active Development Loop for integration.
