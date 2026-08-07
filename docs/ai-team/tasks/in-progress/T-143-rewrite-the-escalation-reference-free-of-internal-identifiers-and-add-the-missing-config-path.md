---
id: T-143
title: Rewrite the escalation reference free of internal identifiers and add the missing-config path
status: pending
priority: high
assigned-role: developer
created: '2026-08-07'
---

# Rewrite the escalation reference free of internal identifiers and add the missing-config path

## Description

`references/escalation.md` in the email-triage skill carries 13 ai-team
artifact identifiers and one paragraph of repository-packaging detail, and its
missing-configuration path hard-stops where it should degrade.

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

Three changes to this one file:

1. **Scrub the 13 identifiers** per the rule above.
2. **Delete the repository-packaging paragraph** (currently the one stating
   which configuration file is committed versus templated and where the real
   file lives). The consuming agent cannot act on it; it belongs in the package
   README.
3. **Replace the "missing or malformed `manager_address`" hard stop.** The run
   must still escalate, addressed to the mail account's own configured address,
   which is obtained from the `From:` header on the first line of
   `himalaya template write` invoked with no arguments (documented in the
   `himalaya` skill's command reference). The escalation email must also state
   that the configuration file was missing and the directory where it was
   expected. If the account's own address cannot be determined either, record
   that in the worklog and take no further action on that message this run — do
   not hard-stop the run, do not guess an address, and do not fall back to
   acting on the message autonomously.

Do not state a worklog requirement for this case beyond the above: the worklog
skill's general journaling discipline covers it.

## Acceptance Criteria

AC-1: The system shall contain no ai-team artifact identifier in
      `references/escalation.md`.

AC-2: The system shall retain, in behavioural language, the rule that a tool
      call denied by the action-authorization gate is recorded and never
      worked around.

AC-3: The system shall omit any description of which configuration files are
      committed, templated, or excluded from the repository.

AC-4: IF the skill-local configuration file is missing, or its address is
      absent or malformed, THEN THE SYSTEM SHALL escalate to the account's own
      address obtained from `himalaya template write`, stating in the email
      that the configuration was missing and where it was expected.

AC-5: IF the account's own address cannot be determined THEN THE SYSTEM SHALL
      record that in the worklog and take no further action on that message,
      without hard-stopping the run or guessing an address.

## Dependencies

- None.

## Files to Touch

- `the-intern/email-skills/.pi/skills/email-triage/references/escalation.md` —
  identifier scrub, packaging-paragraph removal, missing-config escalation path

## Verification

```bash
cd the-intern/email-skills/.pi/skills/email-triage/references

# AC-1 — expect no output:
grep -nE '\b(S-0[0-9]{2}|T-[0-9]{3}|B-0[0-9]{2}|ADR-0[0-9]{2}|CR-0[0-9]{3})\b' escalation.md

# AC-2 — expect the denial rule to survive in behavioural form:
grep -niE 'denied|blocked|authorization gate' escalation.md

# AC-4/AC-5 — expect the degraded path and the undeterminable-address fallback:
grep -niE "template write|account's own|worklog" escalation.md
```

## Work Log

## Review
