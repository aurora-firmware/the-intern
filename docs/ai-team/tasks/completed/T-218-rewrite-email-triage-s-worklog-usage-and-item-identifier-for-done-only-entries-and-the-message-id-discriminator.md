---
id: T-218
title: Rewrite email-triage's worklog usage and item-identifier for Done-only 
  entries and the Message-ID discriminator
status: completed
priority: high
assigned-role: developer
created: '2026-09-21'
---

# Rewrite email-triage's worklog usage and item-identifier for Done-only entries and the Message-ID discriminator

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

Two changes from `S-010` (`CR-014`, v0.4), both touching the same files so
kept as one task. (1) `SKILL.md` steps 1, 3, and 4, and
`references/worklog.md`, currently describe `bob worklog append` calls and
their `Done`/`Left`/`Next` fields (for example step 1's "`Done` naming the
task closed... and `Left`: nothing", step 4's field-by-field guidance) —
rewrite every one to the `Done`-only shape. (2) `references/worklog.md`'s
item-identifier convention (`<subject> (from <sender>)`) is not unique
across messages, and `SKILL.md` restates that same bare convention inline
in two places (step 1's blocked-task-retry note — "the same item-identifier
convention step 4 below uses (`<subject> (from <sender>)` of the message
the task named)" — and step 4's entry-identifier note — "the entry's item
identifier is the message's `<subject> (from <sender>)`"). Add a
discriminator derived from the message's `Message-ID` header (fetched via
`himalaya message read -H Message-ID <id>`) to the identifier everywhere it
is named — `references/worklog.md`'s own definition and both inline
restatements in `SKILL.md` — for every message, and update
`references/worklog.md`'s "How an open item closes" section to match. This
task and `T-214` (the matching Rust `Done`-only narrowing) close
the same gap together — do not treat either as safe to ship without the
other, since the old identifier convention against `Done`-only suppression
can silently drop entries for two distinct messages sharing a subject and
sender.

## Acceptance Criteria

AC-1: The system shall not describe a `Left` or `Next` field, bullet, or
flag anywhere in `SKILL.md` or `references/worklog.md`.

AC-2: WHERE `SKILL.md` instructs a run to call `bob worklog append` THE
SYSTEM SHALL show only `--item` and `--done` as arguments.

AC-3: WHERE `SKILL.md` or `references/worklog.md` states the
item-identifier convention THE SYSTEM SHALL state that it includes a
discriminator derived from the message's `Message-ID` header, alongside
the human-readable `<subject> (from <sender>)` label — covering
`references/worklog.md`'s own definition and both of `SKILL.md`'s inline
restatements (step 1 and step 4), not only one of the three.

AC-4: The system shall state that two distinct messages never share an
item-identifier, and that one message's item-identifier stays the same
across days.

## Dependencies

- None

## Files to Touch

- `the-intern/bob-skills/skills/email-triage/SKILL.md`
- `the-intern/bob-skills/skills/email-triage/references/worklog.md`

## Verification

```bash
grep -rn "Left\|Next\|--left\|--next" the-intern/bob-skills/skills/email-triage/SKILL.md the-intern/bob-skills/skills/email-triage/references/worklog.md
# expect no output
grep -n "Message-ID" the-intern/bob-skills/skills/email-triage/SKILL.md the-intern/bob-skills/skills/email-triage/references/worklog.md
# expect at least one match in each file
```

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

### Session 1 — 2026-09-21

Implemented T-218's two combined changes across `the-intern/bob-skills/skills/email-triage/SKILL.md` and `the-intern/bob-skills/skills/email-triage/references/worklog.md`, following the tdd skill's per-file red→green→refactor pattern (confirmed the task's own verification grep still matched stale content before each file's edit, then edited until that file's slice was clean), using T-217's already-merged `worklog` skill rewrite as a precedent for the Done-only shape.

`SKILL.md` had eight `Left`/`Next` occurrences: the step-1 blocked-task retry bullet ("and `Left`: nothing"), the step-3.2 blocked-action note (`Left`/`Next` parenthetical), the step-3.3 blocked-escalation note (same shape), and step 4's "Record a worklog entry" section (the `Done`/`Left`/`Next` fields description, the `Done`/`Left` bullet for filed tasks, and the final blocked-escalation paragraph's `Done`/`Left`/`Next` triple). All eight were rewritten to name only `Done`, folding what the removed `Left`/`Next` content conveyed into prose ("the retry happens the next time step 1 lists this job's own board" instead of a `Next` field) so no information was silently dropped, only its field-shaped framing. Confirmed via `grep -ni "left\|next"` that only unrelated prose (e.g., "left to write," "the next time") remains.

For the Message-ID discriminator (AC-3/AC-4), added it to all three places the task named: `references/worklog.md`'s own "Item identifier" section (now defines the identifier as `<subject> (from <sender>)` plus a discriminator fetched via `himalaya message read -H Message-ID <id>`, explains why the bare label alone isn't unique under the worklog skill's same-day suppression, and states explicitly that two distinct messages never share an identifier and one message's identifier is stable across days), and both `SKILL.md` inline restatements (step 1's retry bullet and step 4's entry-identifier note), each pointing back to `references/worklog.md` as the canonical definition rather than re-deriving it. Also updated `references/worklog.md`'s "How an open item closes" section, per the task's explicit instruction, to note that an escalation's closing worklog entry is filed under the *reply* message's own distinct `Message-ID`-discriminated identifier, not the originally escalated message's — a nuance the discriminator makes crisp (previously two messages with matching "look-alike" subjects and senders could theoretically have collided under the bare convention).

Two commits, one per file (both touched by both changes, since the changes were textually interleaved within the same sentences in several spots): `170bc93` for `SKILL.md`, `73524b7` for `references/worklog.md`. Ran the task's exact Verification block after both commits: the `Left|Next` grep is clean, and `Message-ID` matches in both files. `git diff --stat dev-agent...HEAD` confirms only the two Files-to-Touch were modified. Working tree is clean; nothing was accidentally written to `the-intern/bob-skills/.pi/skills/email-triage/` (that packaged copy is now stale relative to canonical source, same as `worklog`'s was after T-217 — already covered by `B-054`/`T-221`, no new bug filed). Nothing remains for T-218 itself; all four acceptance criteria are met and the task's verification command is clean.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->

### Review Verdict — 2026-09-21

PASS

Reviewed branch `task/T-218-rewrite-email-triage-s-worklog-usage-and-item-identifier-for-done-only-entries-and-the-message-id-discriminator` against the canonical task file. `git diff --stat dev-agent...task/T-218-...` confirms only the two Files to Touch were modified (`SKILL.md` +43/-24 lines, `references/worklog.md` +32/-15 lines) and the packaged `.pi/skills/email-triage/` copy is untouched (correctly left stale per the already-open `B-054`/`T-221`, not this task's scope).

**Stage 1 — Acceptance criteria** (checked by reading both files' full final content on the task branch, not the Developer's report):

- AC-1 (no `Left`/`Next` field/bullet/flag anywhere): checked out both files from the task branch and ran the task's exact verification grep — `grep -rn "Left\|Next\|--left\|--next" SKILL.md references/worklog.md` — zero matches. Confirmed by reading: all 8 pre-existing `Left`/`Next` occurrences in `SKILL.md` (step 1's blocked-task-retry bullet, step 3.2's blocked-action note, step 3.3's blocked-escalation note, and step 4's three spots) are rewritten to name only `Done`, with the retry/still-open information folded into prose instead of dropped. `references/worklog.md` had no `Left`/`Next` occurrences before or after (the task description's framing was imprecise on this point; the Developer's diff correctly reflects what was actually there).
- AC-2 (`bob worklog append` calls show only `--item`/`--done`): `SKILL.md` never shows literal CLI flag syntax for `bob worklog append` in either the before or after version (it delegates that mechanic to the canonical `worklog` skill, consistent with this doc's own "do not restate that here" pattern, and with the family precedent in the merged `worklog` skill which is the one place that shows `--item <item-identifier> --done <...>` literally). Post-change, every place `SKILL.md` instructs calling `bob worklog append` now describes carrying only the item-identifier and the `Done` field — no `Left`/`Next` argument is described anywhere, satisfying the AC's substance.
- AC-3 (Message-ID discriminator stated in all three places): confirmed by reading all three locations — `references/worklog.md`'s "Item identifier" section (new discriminator definition, `himalaya message read -H Message-ID <id>`, and the collision rationale), `SKILL.md` step 1's blocked-task-retry bullet (line ~116-119, "plus the discriminator derived from that message's `Message-ID` header"), and `SKILL.md` step 4's entry-identifier note (line ~230-234, same phrasing, pointing back to `references/worklog.md` as canonical). Also ran `grep -n "Message-ID" SKILL.md references/worklog.md` per the task's Verification block — matches in both files as required.
- AC-4 (two distinct messages never share an identifier; one message's identifier is stable across days): confirmed in `references/worklog.md`'s "Item identifier" section, stated explicitly and unambiguously.
- No unspecified behavior added; no unexpected files touched (confirmed above).

**Stage 2 — Code quality** (markdown/skill-content correctness and readability, no compiler/tests applicable): content is internally consistent — the `SKILL.md` step 1 and step 4 restatements correctly point back to `references/worklog.md` as the canonical definition rather than re-deriving it; the "How an open item closes" section update correctly ties the escalation-reply nuance to the new discriminator; no dead prose or dangling cross-references found; commit messages (`170bc93`, `73524b7`) follow `docs(email-triage): ...` convention, imperative, under 72 chars. Confirmed T-214 (the paired Rust `Done`-only narrowing this task's description says must not ship alone) is already in `completed/`, so the two-task pairing concern is resolved.

Minor non-blocking observation: the task file's own frontmatter `status:` field still reads `pending` while the file sits in `tasks/in-progress/`; directory is canonical per project convention so this doesn't affect the verdict, but it's a stale-frontmatter data-hygiene point worth fixing when the file next moves.
