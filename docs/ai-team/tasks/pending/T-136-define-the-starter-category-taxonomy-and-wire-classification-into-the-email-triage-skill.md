---
id: T-136
title: Define the starter category taxonomy and wire classification into the
  email-triage skill
status: pending  # pending | in-progress | completed | blocked
priority: medium  # critical | high | medium | low
assigned-role: developer
created: '2026-08-01'
spec: S-010
---

# Define the starter category taxonomy and wire classification into the email-triage skill

## Description

S-010 Phase 3, first half: replace the core loop's single generic
act-or-escalate step with real classification against a starter taxonomy.

Two deliverables:
1. `references/categories/README.md` — the taxonomy index: the starter category
   names, the signals that indicate a match for each, the confidence rubric that
   decides autonomous action versus escalation, and how to add a category later.
2. An edit to the `email-triage` `SKILL.md` (created by T-135) so its per-message
   step consults the index, then follows the matched category's workflow file.

The starter categories are `newsletter-bulk`, `automated-notification`,
`suspected-spam`, `direct-request`, and `meeting-scheduling`. Their workflow
files are added by T-137 and T-138; this task only names them and defines
matching and confidence. S-010 states the taxonomy is an adjustable starter
sketch, not committed policy — keep the index editable and the rubric explicit.

The confidence rubric is the autonomy gate for the whole spec: autonomy is
decided per message by classification confidence, never by whether the action is
reversible or the sender is on an allowlist (both alternatives were rejected in
S-010). An ambiguous match between two categories is not confident.

## Acceptance Criteria

AC-1: The system shall name the starter categories — `newsletter-bulk`,
      `automated-notification`, `suspected-spam`, `direct-request`,
      `meeting-scheduling` — and, for each, the signals that indicate a match.
AC-2: The system shall define a confidence rubric an agent can apply per message
      to decide autonomous action versus escalation, under which an ambiguous
      match between two categories is not confident.
AC-3: WHEN a message is confidently classified THE SYSTEM SHALL follow the
      matched category's workflow file at `references/categories/<category>.md`.
AC-4: IF no category matches confidently THEN THE SYSTEM SHALL escalate per
      `references/escalation.md` rather than choosing the closest category.
AC-5: The system shall document that adding a category means adding one workflow
      file and one index entry, with no change to the `himalaya` skill.

## Dependencies

- `T-135` — `email-triage` SKILL.md, whose per-message step this task rewires

## Files to Touch

- `the-intern/email-skills/.pi/skills/email-triage/references/categories/README.md`
  — new: category list, matching signals, confidence rubric, extension note
- `the-intern/email-skills/.pi/skills/email-triage/SKILL.md` — modify: per-message
  step classifies against the index and follows the matched workflow

## Verification

```bash
# The index names all five categories, the rubric, and the extension rule.
rg -n "newsletter-bulk|automated-notification|suspected-spam|direct-request|meeting-scheduling|confiden" \
  the-intern/email-skills/.pi/skills/email-triage/references/categories/README.md

# SKILL.md now routes through the index instead of a generic action.
rg -n "categories/" the-intern/email-skills/.pi/skills/email-triage/SKILL.md

# Behavioural check (read-only — describe, do not execute): present three sample
# subject/sender pairs — an obvious newsletter, an ambiguous one straddling two
# categories, and a direct question. It must classify the first, escalate the
# ambiguous one, and name the matched workflow file for the third.
# Use the non-interactive invocation form T-131 recorded; pi's default mode is a
# TTY TUI.
cd /tmp/email-skills-probe && pi -p "For each of these three messages, give the category you would assign, your confidence, and the workflow file you would follow (or 'escalate'). Do not run any tool. 1) From: news@example.com Subject: Your weekly digest. 2) From: billing@example.com Subject: Action required on your invoice. 3) From: a.person@example.com Subject: Can you send me the Q3 numbers?"
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
