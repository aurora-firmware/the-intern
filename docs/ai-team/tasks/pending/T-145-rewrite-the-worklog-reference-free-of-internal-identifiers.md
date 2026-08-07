---
id: T-145
title: Rewrite the worklog reference free of internal identifiers
status: pending
priority: high
assigned-role: developer
created: '2026-08-07'
---

# Rewrite the worklog reference free of internal identifiers

## Description

`references/worklog.md` in the email-triage skill carries 8 ai-team artifact
identifiers.

Skill consumers have no access to this project's specifications, decision
records, tasks, or bugs, so skill text must be intelligible without them. Remove
every such identifier (`S-0NN`, `T-NNN`, `B-0NN`, `ADR-0NN`, `CR-0NNN`).

**This is a rewrite, not a deletion.** Most references to the action-gate
specification are behaviourally load-bearing: they carry the rule that a tool
call denied by policy is recorded and never worked around. Replace the
identifier with behavioural language — "the action-authorization gate", "denied
by policy" — and keep the surrounding rule intact. Deleting the sentence
because it names a spec would remove the single most safety-relevant behaviour
in this package.

Do not add cross-references to project artifacts in their place. Where a
reference only served to justify a design choice to an internal reader, drop
the justification and keep the instruction.

This file's identifiers are concentrated in its "First-run reconciliation"
section, where they cite the reasons a day's runs can vanish without trace —
the service being stopped across a scheduled tick, a missing working directory
at fire time, and process-limit exhaustion. Those *causes* are real and must
survive as prose, because they are why reconciliation walks back to the most
recent file with open items instead of assuming the previous run was yesterday.
Only the artifact identifiers go.

Make no behavioural change: the diary location, entry format, creation rules,
first-run detection, reconciliation walk-back, and open-item closing rules all
stay exactly as they are.

## Acceptance Criteria

AC-1: The system shall contain no ai-team artifact identifier in
      `references/worklog.md`.

AC-2: The system shall retain, as prose, every stated cause of a skipped run
      that justifies walking back to the most recent worklog file containing
      open items.

AC-3: The system shall leave the diary location, entry format, first-run
      detection, reconciliation, and open-item closing rules behaviourally
      unchanged.

## Dependencies

- None.

## Files to Touch

- `the-intern/email-skills/.pi/skills/email-triage/references/worklog.md` —
  identifier scrub only

## Verification

```bash
cd the-intern/email-skills/.pi/skills/email-triage/references

# AC-1 — expect no output:
grep -nE '\b(S-0[0-9]{2}|T-[0-9]{3}|B-0[0-9]{2}|ADR-0[0-9]{2}|CR-0[0-9]{3})\b' worklog.md

# AC-3 — expect only identifier-bearing lines to differ:
git diff -- worklog.md
```

## Work Log

## Review
