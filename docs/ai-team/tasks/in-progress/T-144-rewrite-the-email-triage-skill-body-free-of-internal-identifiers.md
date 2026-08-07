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

### Session 1 — 2026-08-07

Implemented T-144 as a documentation rewrite, treating the task's Verification
section grep commands as the test surface per the loop's instructions (no unit-test
framework applies to skill-text files).

Established red state first: ran all three verification greps from
`the-intern/email-skills`. AC-1 found 14 identifier occurrences (10x `S-004`,
4x `S-010`) across `SKILL.md` (13 lines) and `config/email-triage.example.toml`
(1 line), confirming the task's count.

Cycle 1 — `config/email-triage.example.toml`: removed the configuration-requirements
spec citation from the header comment and rewrapped the surrounding prose; left the
`manager_address` key documentation block untouched apart from that removal,
satisfying AC-4. Verified AC-1 (config-only) and AC-4 green, then committed.

Cycle 2 — `SKILL.md`: read `references/escalation.md` (T-143's output) first to
confirm its actual policy shape before rewriting delegating text, per the task's
AC-3 context note. Replaced every action-gate identifier with "the
action-authorization gate" / "denied by the action-authorization gate" and every
package-spec identifier with plain behavioural description (dropping the bracketed
spec-section pointers entirely, since skill consumers have no access to those
specs) — this covers the "Tool usage" section, the first-run reconciliation
open-block reference, the unseen-mail listing gate reference, and both places in
step 3 describing a denied tool call or a denied escalation send. Each of these
denial-outcome rules was preserved word-for-word in meaning: a denied action-gate
call is never substituted with another action and is recorded as an open worklog
item (step 3.2's bullet), and a denied escalation send is recorded as **blocked**,
never as **escalated** (step 3.3's closing paragraph and step 4's final paragraph)
— AC-2's grep for `denied|blocked|authorization gate` now matches 15 lines.

For AC-3, rewrote the paragraph that previously asserted "a blocked or unaddressable
escalation is a hard stop for that message, exactly as `references/escalation.md`
requires" — this was factually stale against T-143's actual policy, under which a
missing/malformed `manager_address` does *not* hard-stop the message; it degrades to
escalating to the mail account's own address (obtained via `himalaya template
write`'s `From:` header), only falling back to a worklog-only record when that
address is itself undeterminable. The new text simply states that
`references/escalation.md` defines the full policy — the email's required content,
the denied-send outcome, and the missing-configuration fallback path — and that this
file does not restate any of it, plus keeps the still-true invariant that this skill
never falls back to acting on the message autonomously regardless of which
escalation-path branch applies. No automated grep covers AC-3 in the task's
Verification section, so it was confirmed by re-reading `references/escalation.md`
against the new paragraph.

Cleaned up a few incidental line-wrap artifacts left by the string edits; re-ran all
three verification greps after cleanup to confirm nothing regressed. Confirmed via
`git show --stat` that only the two files listed in the task's "Files to Touch" were
modified across both commits, and checked both commit subject lines are within the
72-character limit (59 and 61 chars).

**Tried and rejected:** initially considered leaving the "escalate per
`references/escalation.md` — send exactly one escalation email to the configured
manager address" sentence in step 3.3 untouched since it wasn't the sentence the
task flagged as inaccurate; kept it as-is on the reasoning that it describes the
primary/typical flow and the fuller delegation sentence immediately after it already
covers the missing-configuration fallback in full, so there is no remaining
restatement conflict.

**Remaining:** none for this task — all four acceptance criteria are met and the
three grep-based verification commands pass cleanly (AC-1 empty, AC-2 and AC-4 both
find expected content).

Commits on `task/T-144-rewrite-skill-body`:

- `fb2b737` docs(email-triage): drop spec id from config header comment
- `e359d3a` docs(email-triage): scrub spec ids and delegate config policy

## Review
