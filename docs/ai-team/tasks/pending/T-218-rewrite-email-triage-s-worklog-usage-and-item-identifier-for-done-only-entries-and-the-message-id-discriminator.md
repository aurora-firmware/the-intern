---
id: T-218
title: Rewrite email-triage's worklog usage and item-identifier for Done-only 
  entries and the Message-ID discriminator
status: pending
priority: high
assigned-role: developer
created: '2026-09-21'
---

# Rewrite email-triage's worklog usage and item-identifier for Done-only entries and the Message-ID discriminator

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

Two changes from `S-010` (`CR-014`, v0.4), both touching the same files so
kept as one task. (1) `SKILL.md` steps 1, 3, and 4, and
`references/worklog.md`, currently describe `bob worklog append` calls and
their `Done`/`Left`/`Next` fields (for example step 1's "`Done` naming the
task closed... and `Left`: nothing", step 4's field-by-field guidance) —
rewrite every one to the `Done`-only shape. (2) `references/worklog.md`'s
item-identifier convention (`<subject> (from <sender>)`) is not unique
across messages, and `SKILL.md` restates that same bare convention inline
in two places (step 1's blocked-task-retry note — "the same item-identifier
convention step 4 below uses (`<subject> (from <sender>)` of the message
the task named)" — and step 4's entry-identifier note — "the entry's item
identifier is the message's `<subject> (from <sender>)`"). Add a
discriminator derived from the message's `Message-ID` header (fetched via
`himalaya message read -H Message-ID <id>`) to the identifier everywhere it
is named — `references/worklog.md`'s own definition and both inline
restatements in `SKILL.md` — for every message, and update
`references/worklog.md`'s "How an open item closes" section to match. This
task and `T-214` (the matching Rust `Done`-only narrowing) close
the same gap together — do not treat either as safe to ship without the
other, since the old identifier convention against `Done`-only suppression
can silently drop entries for two distinct messages sharing a subject and
sender.

## Acceptance Criteria

AC-1: The system shall not describe a `Left` or `Next` field, bullet, or
flag anywhere in `SKILL.md` or `references/worklog.md`.

AC-2: WHERE `SKILL.md` instructs a run to call `bob worklog append` THE
SYSTEM SHALL show only `--item` and `--done` as arguments.

AC-3: WHERE `SKILL.md` or `references/worklog.md` states the
item-identifier convention THE SYSTEM SHALL state that it includes a
discriminator derived from the message's `Message-ID` header, alongside
the human-readable `<subject> (from <sender>)` label — covering
`references/worklog.md`'s own definition and both of `SKILL.md`'s inline
restatements (step 1 and step 4), not only one of the three.

AC-4: The system shall state that two distinct messages never share an
item-identifier, and that one message's item-identifier stays the same
across days.

## Dependencies

- None

## Files to Touch

- `the-intern/bob-skills/skills/email-triage/SKILL.md`
- `the-intern/bob-skills/skills/email-triage/references/worklog.md`

## Verification

```bash
grep -rn "Left\|Next\|--left\|--next" the-intern/bob-skills/skills/email-triage/SKILL.md the-intern/bob-skills/skills/email-triage/references/worklog.md
# expect no output
grep -n "Message-ID" the-intern/bob-skills/skills/email-triage/SKILL.md the-intern/bob-skills/skills/email-triage/references/worklog.md
# expect at least one match in each file
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
