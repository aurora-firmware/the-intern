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

### Session 1 — 2026-08-07

Read the empty Work Log (first session) and the task file's Description, Acceptance
Criteria, and Verification block. Confirmed the file's 8 identifiers with a grep
before touching anything: five action-gate spec occurrences (in the `Done`/`Left`
bullets of the per-message entry format, the "open items" mailbox-flag rationale,
and twice in "How an open item closes"), plus one each of the scheduler ADR and two
further spec citations in the "First-run reconciliation" section's list of causes.

Checked the two already-merged sibling tasks (T-143 on `references/escalation.md`,
T-144 on `SKILL.md`) for established wording before writing anything, per the task's
explicit instruction to match them. Found the pattern consistently used there: "the
action-authorization gate" for verb-form usage ("denied by/blocked by the
action-authorization gate"), "a block from the action-authorization gate" for
noun-form usage (`SKILL.md`: "any open block from the action-authorization gate"),
and the literal phrase "denied by policy" plus "denied by the action-authorization
gate" from `escalation.md`/`SKILL.md`. Reused these exact phrases rather than
inventing new terminology (specifically rejected a hyphenated
"action-authorization-gate block" label, since no sibling file uses that compound
form).

Made five targeted substitutions: (1) the `Done` bullet's "blocked by <spec>" →
"blocked by the action-authorization gate"; (2) the `Left` bullet's example string
"blocked by <spec> — no admitting allow rule" → "blocked by the
action-authorization gate — no admitting allow rule"; (3) the reconciliation-causes
list — dropped the three parenthetical citations while keeping all three causal
clauses (service stopped across a tick, missing per-entry `cwd` at fire time,
`max_processes` exhaustion) as full prose, satisfying AC-2 explicitly; (4) "hitting
an <spec> block" → "hitting a block from the action-authorization gate" in the
mailbox-flag-state rationale; (5) the closing-condition bullet's label "**<spec>
block.**" → "**Denied by the action-authorization gate.**" and its trailing "is no
longer denied." → "is no longer denied by policy.", plus the parallel "for an
<spec> block" reference later in the same section → "for a block from the
action-authorization gate".

Two paragraphs needed re-wrapping because the replacement phrases are longer than
the identifiers they replaced, pushing lines past the file's existing ~79-character
wrap width: the "Open items live in the worklog" paragraph and the carry-forward
paragraph in "How an open item closes". Used Python `textwrap` at width 79 to reflow
only those two paragraphs, matching the rest of the file's wrap convention, rather
than leaving ragged short lines. Caught and fixed one duplicated-line mistake made
mid-edit during that rewrap before it was committed.

Verified AC-1 (`grep` for the identifier pattern returns no output), AC-2 (manual
review confirms all three causes remain as prose), and AC-3 (`git diff` shows only
identifier-bearing lines and their forced wrap neighbours changed — no other
section, rule, or piece of prose was touched). `git diff --stat` confirms only
`worklog.md` was modified, matching the task's Files to Touch. Committed as a single
cycle: `docs(email-triage): scrub identifiers from worklog reference` (60 chars,
within the 72-char subject limit) on `task/T-145-rewrite-worklog-reference`.

Nothing remains outstanding for this task's scope. No behavioural change was made or
intended — this was purely a wording substitution.

Commits on `task/T-145-rewrite-worklog-reference`:

- `5cdc6f4` docs(email-triage): scrub identifiers from worklog reference

## Review

### Review Verdict — 2026-08-07

PASS

**Stage 1 — Acceptance Criteria**

- AC-1 (no ai-team artifact identifiers in `references/worklog.md`): met.
  `grep -nE '\b(S-0[0-9]{2}|T-[0-9]{3}|B-0[0-9]{2}|ADR-0[0-9]{2}|CR-0[0-9]{3})\b'`
  against the committed blob on `task/T-145-rewrite-worklog-reference`
  returns no matches. All 8 identifiers cited in Session 1 (five
  action-gate spec occurrences, the scheduler ADR, and two further spec
  citations in "First-run reconciliation") are gone.
- AC-2 (all three causes of a vanished day's runs survive as prose): met.
  "First-run reconciliation" still lists, as full causal clauses: bob
  stopped across a scheduled tick, the per-entry `cwd` missing at fire
  time, and `max_processes` exhaustion. Only the three parenthetical
  citations (`ADR-006`, `S-009`, `S-002`) were removed; the walk-back
  rationale sentence immediately after is untouched.
- AC-3 (no behavioural change): met. Reviewed the full diff
  (`git diff dev-agent...task/T-145-rewrite-worklog-reference -- worklog.md`,
  26 insertions / 23 deletions) hunk by hunk. Every changed line is either
  (a) a direct identifier→behavioural-language substitution (`S-004` →
  "the action-authorization gate" / "a block from the action-authorization
  gate" / "Denied by the action-authorization gate"; `ADR-006`, `S-009`,
  `S-002` → dropped) or (b) a forced rewrap consequence of a substitution
  making a line exceed the file's ~79-char wrap width. Confirmed the two
  reflowed paragraphs ("Open items live in the worklog only..." and the
  carry-forward paragraph in "How an open item closes") contain no wording
  change beyond the substitutions themselves — checked word-for-word
  against the pre-change blob on `dev-agent`. New max line length is 78
  chars (was 77), consistent with the existing wrap convention. Diary
  location, entry format (`Done`/`Left`/`Next`), first-run detection ("File
  does not exist yet" logic lives in `SKILL.md`, untouched here), the
  reconciliation walk-back rule, and both open-item closing rules
  (escalation reply / action-gate block) are word-for-word identical
  apart from the identifier substitutions. Scanned the committed file for
  duplicated-line artifacts (adjacent identical lines, adjacent duplicate
  words across the reflowed paragraphs) — none found; the one
  `reconciliation`/`Reconciliation` adjacency is a legitimate
  header-to-body transition, not a duplication bug. `git diff --stat`
  confirms only `worklog.md` was touched, matching "Files to Touch."
- No unspecified behaviour or functionality was added; no cross-references
  to project artifacts were substituted in place of the removed
  identifiers, per the task's explicit instruction.

**Consistency check** — `worklog.md` now uses "the action-authorization
gate" (verb-form), "a block from the action-authorization gate" (noun-form,
matching `SKILL.md`'s "any open block from the action-authorization gate"),
and "denied by policy" (matching `references/escalation.md`'s "A call denied
by policy is recorded and never worked around"). No new terminology was
invented; wording is consistent with the already-merged T-143/T-144 files.

**Stage 2 — Code Quality**

This is a prose-only reference-doc edit; no code, tests, or external input
are involved, so most Stage 2 checks are not applicable. Readability: the
rewrapped paragraphs read naturally and match the file's existing wrap
convention.

**Commit hygiene** — single commit `5cdc6f4`, subject
`docs(email-triage): scrub identifiers from worklog reference` measures 60
characters, within the git-conventions 72-char subject limit. Type/scope
(`docs(email-triage)`) is valid and does not repeat the task ID.

No blocking issues found.
