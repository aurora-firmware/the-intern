---
id: T-144
title: Rewrite the email-triage skill body free of internal identifiers
status: pending
priority: high
assigned-role: developer
created: '2026-08-07'
---

# Rewrite the email-triage skill body free of internal identifiers

## Description

`email-triage/SKILL.md` carries 14 ai-team artifact identifiers and
`config/email-triage.example.toml` carries one.

Skill consumers have no access to this project's specifications, decision
records, tasks, or bugs, so skill text must be intelligible without them. Remove
every such identifier (`S-0NN`, `T-NNN`, `B-0NN`, `ADR-0NN`, `CR-0NNN`).

**This is a rewrite, not a deletion.** Most references to the action-gate
specification are behaviourally load-bearing: they carry the rule that a tool
call denied by policy is recorded and never worked around. Replace the
identifier with behavioural language — "the action-authorization gate", "denied
by policy" — and keep the surrounding rule intact.

`SKILL.md` is the densest case: its "Tool usage" section and step 3 both cite
the action-gate specification repeatedly while stating what the loop does when
a call is denied. Every one of those rules must survive the rewrite —
particularly that a denied call is never substituted with some other action,
and that a blocked escalation is recorded as blocked rather than as sent.

In the configuration template, remove the specification identifier from the
header comment without changing the documented key or its explanation.

**One alignment change.** Step 3's `manager_address` lookup currently describes
a hard stop when the configuration is missing or malformed. T-143 replaces that
policy in `references/escalation.md`. Update this file to delegate to the
reference rather than restating the rule — this skill should say that the
escalation policy, including the missing-configuration path, lives there.

## Acceptance Criteria

AC-1: The system shall contain no ai-team artifact identifier in
      `SKILL.md` or `config/email-triage.example.toml`.

AC-2: The system shall retain, in behavioural language, every rule describing
      what the loop does when a tool call is denied — including that no other
      action is substituted and that a blocked escalation is recorded as
      blocked, never as sent.

AC-3: The system shall delegate the missing-configuration escalation path to
      `references/escalation.md` rather than restating it.

AC-4: The system shall leave the configuration template's documented key and
      its explanation unchanged apart from the identifier removal.

## Dependencies

- `T-143` — defines the missing-configuration escalation policy in
  `references/escalation.md` that AC-3 delegates to.

## Files to Touch

- `the-intern/email-skills/.pi/skills/email-triage/SKILL.md` — identifier
  scrub, escalation delegation
- `the-intern/email-skills/config/email-triage.example.toml` — identifier
  removal from the header comment

## Verification

```bash
cd the-intern/email-skills

# AC-1 — expect no output:
grep -nE '\b(S-0[0-9]{2}|T-[0-9]{3}|B-0[0-9]{2}|ADR-0[0-9]{2}|CR-0[0-9]{3})\b' \
  .pi/skills/email-triage/SKILL.md config/email-triage.example.toml

# AC-2 — expect the denial rules to survive in behavioural form:
grep -niE 'denied|blocked|authorization gate' .pi/skills/email-triage/SKILL.md

# AC-4 — expect manager_address still documented:
grep -n 'manager_address' config/email-triage.example.toml
```

## Work Log

## Review
