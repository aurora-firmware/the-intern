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

### Session 1 — 2026-08-07

Implemented T-146 in three cycles matching the task description's three distinct
changes, each committed separately on `task/T-146-rewrite-category-taxonomy`.

Before writing anything, read the three sibling files the task pointed to —
`references/escalation.md` (T-143), `SKILL.md` (T-144), and `references/worklog.md`
(T-145) — plus the `himalaya` skill's `command-reference.md`, since escalation.md's
missing-configuration fallback leans on `himalaya template write`'s `From:` header
to find the account's own address, and that mechanism needed to be the basis for the
new category's matching signals rather than inventing a separate detection method.

Cycle 1 (scrub identifiers, AC-1/AC-5): established the red baseline with the task's
own grep commands (12 identifier matches across the six files). Replaced each with
behavioural phrasing — "the action-authorization gate", "denied by the
action-authorization gate" for the block-handling headings and one prose reference,
and plain descriptive text (e.g. "exhaustive per-category business logic is
deliberately out of scope", "this skill's read-and-act scope") for the package-spec
mentions. Verified via `git diff` that no `Signals:` bullet or confidence-rubric
line was touched — only identifier-bearing sentences changed, satisfying AC-5.
Re-ran the AC-1 grep to confirm green, then committed.

Cycle 2 (delete "Adding a category", AC-2): removed the section. The forward-pointer
sentence in the intro paragraph that referenced it had already been removed in Cycle
1, since that sentence contained an identifier and was naturally cleaned up in the
same edit — considered keeping that pointer text until Cycle 2 for stricter cycle
boundaries, but since it was already bundled with an identifier removal in the same
paragraph, resolving both together was cleaner than reintroducing then re-removing
text. Re-ran AC-1 and AC-2 greps, both green, committed.

Cycle 3 (add terminal `self-escalation` category, AC-3/AC-4): the main design
decision was where the new category's matching signals come from and how confidently
they discriminate. Since escalation.md's missing-configuration fallback is the only
path that ever addresses an outgoing escalation to the account's own address, the
decisive signal is that the message is self-addressed (`From:` and `To:` both equal
the account's own configured address, obtained the same way that fallback obtains
it), reinforced by the literal `Escalation: ` subject prefix SKILL.md's
escalation-composition step always writes, and by the missing-config body text
escalation.md's fallback always adds.

Placed the new category in its own "## The skill's own escalation mail" section
after "## No confident match", rather than folding it into "## Starter categories
and their matching signals" as a sixth entry — that section's intro text ("Five
starter categories exist...adjustable sketch") describes the extensible, adjustable
business-logic categories the now-deleted "Adding a category" section covered, and
this new category is structurally different: it is fixed, terminal infrastructure
required for the escalation design to close its own loop, not a revisable sketch.
Keeping it in a separate section avoided having to touch or reinterpret the "Five
starter categories exist" sentence and kept AC-5's "behaviourally unchanged" scope
unambiguous (confirmed by `git diff` showing this cycle as a pure addition to
README.md plus one new file). The workflow file itself follows the same shape as the
five existing ones (intro boilerplate, a file-without-reply section, a
worklog-entry section, a blocked-move section) plus one new section, "Never escalate
this message", making the terminal behaviour explicit and covering the edge case of
the filing move itself being blocked — the naive failure mode of escalating instead
is called out and explicitly forbidden there.

**Tried and rejected:** nothing was rejected outright during the session; the one
judgment call (index-entry placement — sixth starter entry vs. separate section) was
decided in favour of the separate section for the reasons above.

**Remaining:** nothing outstanding against T-146's acceptance criteria; all three
Verification block commands pass in the final state. No files outside the task's
Files to Touch list were modified.

Commits on `task/T-146-rewrite-category-taxonomy`:

- `6d12bce` docs(email-triage): scrub identifiers from category taxonomy
- `165f3ee` docs(email-triage): drop the adding-a-category section
- `606e80f` docs(email-triage): add terminal self-escalation category

## Review
