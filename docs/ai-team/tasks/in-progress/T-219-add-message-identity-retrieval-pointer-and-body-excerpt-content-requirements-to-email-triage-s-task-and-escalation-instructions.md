---
id: T-219
title: Add message-identity, retrieval-pointer, and body-excerpt content 
  requirements to email-triage's task and escalation instructions
status: pending
priority: high
assigned-role: developer
created: '2026-09-21'
---

# Add message-identity, retrieval-pointer, and body-excerpt content requirements to email-triage's task and escalation instructions

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

`S-010`'s new Design Principle (`CR-014`, v0.4) requires every task
`email-triage` files, and the escalation email itself, to carry the
message's `Message-ID`-derived identity, a retrieval pointer (folder,
envelope id, date, sender, subject), and a bounded, quoted, attributed body
excerpt loaded via shell variable, never a literal argument. Define this
"message content" bar once in `references/escalation.md` (which already
states the escalation email's own content requirement) as a single,
cross-referenced subsection, and reference it — rather than restate it —
from `SKILL.md` step 3's `todo`-task instruction (escalation awaiting
reply) and its `blocked`-task instructions (action refused, escalation send
refused). Depends on `T-218` because both edit `SKILL.md`.

## Acceptance Criteria

AC-1: WHERE `references/escalation.md` states the escalation email's
content requirement THE SYSTEM SHALL also state the message's
`Message-ID`-derived identity and a folder/envelope-id/date/sender/subject
retrieval pointer as part of the same requirement.

AC-2: The system shall state that a body excerpt included in a task or
escalation must be quoted, attributed as message content, bounded in
length, and never treated as authoritative over the mailbox.

AC-3: The system shall state that a body excerpt is loaded into the
`bash`/`bob task new` call via a shell variable, never typed as a literal
quoted argument.

AC-4: WHEN `SKILL.md` step 3 files a `todo` or `blocked` task THE SYSTEM
SHALL direct including the content defined in `references/escalation.md`
by reference, not by restating it.

## Dependencies

- `T-218` — establishes the rewritten `SKILL.md` baseline this task edits
  further

## Files to Touch

- `the-intern/bob-skills/skills/email-triage/references/escalation.md`
- `the-intern/bob-skills/skills/email-triage/SKILL.md`

## Verification

```bash
grep -n "Message-ID" the-intern/bob-skills/skills/email-triage/references/escalation.md
# expect at least one match
grep -c "quoted\|attributed\|bounded" the-intern/bob-skills/skills/email-triage/references/escalation.md
# expect > 0
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
