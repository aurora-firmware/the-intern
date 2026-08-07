---
id: T-146
title: Rewrite the category taxonomy free of internal identifiers and add the self-escalation category
status: pending
priority: high
assigned-role: developer
created: '2026-08-07'
---

# Rewrite the category taxonomy free of internal identifiers and add the self-escalation category

## Description

The category taxonomy directory carries 13 ai-team artifact identifiers spread
across its index and five workflow files, presents an extension point that
should not exist, and lacks a category that a new escalation behaviour requires.

Skill consumers have no access to this project's specifications, decision
records, tasks, or bugs, so skill text must be intelligible without them. Remove
every such identifier (`S-0NN`, `T-NNN`, `B-0NN`, `ADR-0NN`, `CR-0NNN`).

**This is a rewrite, not a deletion.** Most references to the action-gate
specification are behaviourally load-bearing: they carry the rule that a tool
call denied by policy is recorded and never worked around. Replace the
identifier with behavioural language — "the action-authorization gate", "denied
by policy" — and keep the surrounding rule intact.

Three changes:

1. **Scrub the 13 identifiers** across `README.md` and the five category
   workflow files.
2. **Delete the "Adding a category" section** from `README.md`. Skill content
   ships with releases, so a user's local edits would be overwritten on
   upgrade; inviting them is misleading. Categories change through releases
   only. Remove the section without replacing it with a "do not edit" notice.
3. **Add a terminal category for the skill's own escalation mail.** Escalations
   sent to the account's own address arrive back in the same mailbox as unseen
   mail and re-enter triage. Without this, a message that does not classify
   confidently escalates to itself indefinitely. The new category must file
   such a message and never escalate it again. Add one workflow file and one
   index entry naming its matching signals.

## Acceptance Criteria

AC-1: The system shall contain no ai-team artifact identifier anywhere under
      `references/categories/`.

AC-2: The system shall present no procedure, invitation, or guidance for adding
      a category.

AC-3: WHEN a message is recognised as the skill's own escalation mail THE
      SYSTEM SHALL file it and take no escalation action on it.

AC-4: The system shall list the new category in the taxonomy index with its
      matching signals, in the same shape as the existing entries.

AC-5: The system shall leave the confidence rubric and the five existing
      categories' matching signals behaviourally unchanged.

## Dependencies

- None. `SKILL.md` consults this index by name and enumerates no categories
  itself, so adding one requires no change to T-144's files.

## Files to Touch

- `the-intern/email-skills/.pi/skills/email-triage/references/categories/README.md`
  — identifier scrub, remove "Adding a category", add the new index entry
- `the-intern/email-skills/.pi/skills/email-triage/references/categories/`
  (five existing workflow files) — identifier scrub only
- `the-intern/email-skills/.pi/skills/email-triage/references/categories/`
  (one new workflow file) — the terminal self-escalation category

## Verification

```bash
cd the-intern/email-skills/.pi/skills/email-triage/references/categories

# AC-1 — expect no output:
grep -rnE '\b(S-0[0-9]{2}|T-[0-9]{3}|B-0[0-9]{2}|ADR-0[0-9]{2}|CR-0[0-9]{3})\b' .

# AC-2 — expect no output:
grep -rniE 'adding a category|add a category|extend the list' .

# AC-3/AC-4 — expect the new workflow file and its index entry:
ls *.md && grep -niE 'escalation mail|own escalation' README.md
```

## Work Log

## Review
