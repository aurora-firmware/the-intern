---
id: T-220
title: Add a worked Message-ID retrieval example to the himalaya skill's command
  reference
status: pending
priority: medium
assigned-role: developer
created: '2026-09-21'
---

# Add a worked Message-ID retrieval example to the himalaya skill's command reference

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

`himalaya message read`'s `-H, --header <NAME>` option is already
documented as verified, but no worked example shows retrieving a
`Message-ID` header — needed now that `email-triage` (`T-218`) depends on
it for its item-identifier discriminator. Add a worked example retrieving
the identity headers a triage run needs in one call (`-H From -H Subject
-H Date -H Message-ID`), and note `--preview` semantics for a read that
must not set `\Seen`, consistent with existing guidance in the file.

## Acceptance Criteria

AC-1: The system shall include a worked example of `himalaya message read`
with `-H Message-ID` among its headers.

AC-2: The example shall retrieve `From`, `Subject`, `Date`, and
`Message-ID` in a single command.

AC-3: WHERE the example applies to a read that must not mark the message
`\Seen` THE SYSTEM SHALL note the `--preview` flag.

## Dependencies

- None

## Files to Touch

- `the-intern/bob-skills/skills/himalaya/references/command-reference.md`

## Verification

```bash
grep -n "Message-ID" the-intern/bob-skills/skills/himalaya/references/command-reference.md
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
