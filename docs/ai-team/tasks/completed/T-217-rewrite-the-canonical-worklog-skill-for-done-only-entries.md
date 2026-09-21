---
id: T-217
title: Rewrite the canonical worklog skill for Done-only entries
status: completed
priority: high
assigned-role: developer
created: '2026-09-21'
---

# Rewrite the canonical worklog skill for Done-only entries

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

`S-015` (`CR-014`, v0.6) narrows the entry format to `Done` alone, requires
`append` calls to pass only `--item`/`--done`, and narrows same-day
duplicate suppression to compare `Done` alone.
`the-intern/bob-skills/skills/worklog/SKILL.md`,
`references/entry-format.md`, and `references/reconciliation.md` (the
canonical description of the same-day duplicate check — `CR-013` repurposed
this file's content without renaming it, so it reads as retired but is
live, shipped, and linked from `SKILL.md`) all still teach the three-bullet
`Done`/`Left`/`Next` shape, the four-flag `append` call, or a three-field
comparison. Rewrite all three to the one-field shape. Separately, per
`CR-014`'s Architecture Consistency Review (finding C), this skill's
generic item-identifier convention (`SKILL.md`'s "Recording an entry"
section) must state that distinct items get distinct identifiers, not only
that one item's identifier stays stable across recurrences — today it
states only the latter. Leave the rest of the skill's content (location
resolution, tool usage, the "this skill owns no domain policy" framing)
unchanged.

## Acceptance Criteria

AC-1: The system shall not describe a `Left` or `Next` field, bullet, or
flag, or a comparison of more than one field, anywhere in `SKILL.md`,
`references/entry-format.md`, or `references/reconciliation.md`.

AC-2: WHERE `references/entry-format.md` describes an entry's shape THE
SYSTEM SHALL describe a header line followed by exactly one `- Done: …`
bullet.

AC-3: WHERE `SKILL.md` instructs a run to call `bob worklog append` THE
SYSTEM SHALL show only `--item` and `--done` as arguments.

AC-4: WHERE `references/reconciliation.md` describes the same-day
duplicate check THE SYSTEM SHALL describe a comparison of `Done` alone,
not of three fields.

AC-5: WHERE `SKILL.md`'s item-identifier guidance exists THE SYSTEM SHALL
state that distinct items must get distinct identifiers, alongside the
existing requirement that one item's identifier stays the same across
recurrences.

## Dependencies

- None

## Files to Touch

- `the-intern/bob-skills/skills/worklog/SKILL.md` — narrow the `append`
  call shape; add the distinct-identifiers requirement to "Recording an
  entry"
- `the-intern/bob-skills/skills/worklog/references/entry-format.md` —
  narrow the entry shape to `Done` only
- `the-intern/bob-skills/skills/worklog/references/reconciliation.md` —
  narrow the duplicate-check description to compare `Done` alone

## Verification

```bash
grep -rn "Left\|Next\|--left\|--next\|three field" the-intern/bob-skills/skills/worklog/SKILL.md the-intern/bob-skills/skills/worklog/references/entry-format.md the-intern/bob-skills/skills/worklog/references/reconciliation.md
# expect no output
grep -n "distinct" the-intern/bob-skills/skills/worklog/SKILL.md
# expect at least one match
```

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

### Session 1 — 2026-09-21

Rewrote all three canonical worklog skill files to the Done-only shape required by S-015 (CR-014, v0.6), using the tdd skill's red→green→refactor cycle one file at a time: confirmed the stale `Left`/`Next` language was present via the task's own verification grep before each edit, then edited until that file's slice of the grep was clean. `references/entry-format.md` lost the `--left`/`--next` flags from its example `append` call and the `Left`/`Next` bullets from the entry-shape description, leaving a header line, blank line, and exactly one `Done` bullet. `references/reconciliation.md` had its three separate descriptions of the same-day duplicate check (the automatic check itself, the "safe to call twice" note, and the "only the most recent entry is consulted" note) each narrowed from a three-field `Done`/`Left`/`Next` comparison to a `Done`-alone comparison. `SKILL.md`'s "Recording an entry" section had its `append` call description narrowed to show only `--item <item-identifier>` and `--done <...>`, and its item-identifier paragraph gained an explicit "distinct items must get distinct identifiers" requirement alongside the pre-existing "same identifier across recurrences" one (finding C from CR-014's Architecture Consistency Review). Left the rest of the skill's content — location resolution, tool usage, the "this skill owns no domain policy" framing, and the open/closed-item tracking section — untouched, as instructed. Each of the three file edits was its own commit (`ed319dd`, `f85fdb2`, `8056f13`) on the task branch. Final verification: the task's exact grep commands both pass (no `Left`/`Next`/`--left`/`--next`/"three field" matches; at least one `distinct` match in `SKILL.md`).

While reading around `SKILL.md` and `references/`, found that `the-intern/bob-skills/.pi/skills/worklog/` is a separate, git-tracked packaging copy of the canonical `skills/worklog/` source, generated by `the-intern/bob-skills/package-pi-skills.sh` and normally regenerated by a dedicated commit when the canonical source changes (e.g. `cf01d24`). That packaged copy is what `pi` actually reads at runtime (cwd-relative skill discovery), and it still has the old `Left`/`Next`/four-flag content after this task's edits, since regenerating it was outside T-217's Files to Touch/Verification scope. Rather than silently expanding scope to touch a file the task didn't list, filed `B-054` directly on `dev-agent` describing the gap and the fix (re-run `package-pi-skills.sh` and commit the regenerated tree), with fix-verification steps; the loop coordinator subsequently annotated B-054 as expected to be resolved by `T-221` (already queued in this same run) rather than needing independent bug-fix work. Nothing remains for T-217 itself — all five acceptance criteria are met and the task's verification command is clean.

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

**Stage 1 — Acceptance Criteria** (checked against `task/T-217-rewrite-the-canonical-worklog-skill-for-done-only-entries`, files read in full, not just the diff):

- AC-1: `grep -rn "Left\|Next\|--left\|--next\|three field"` over `SKILL.md`, `references/entry-format.md`, `references/reconciliation.md` produced no output (exit 1). Also ran a broader case-insensitive `left\|next` sweep as a sanity check; the only remaining hits in `SKILL.md` are unrelated prose ("next item", "left to write", "day to the next") — `entry-format.md` and `reconciliation.md` have zero matches of any kind. Met.
- AC-2: `references/entry-format.md` lines 25-32 show a header line, a blank line, then exactly one `- Done: …` bullet; the removed `Left`/`Next` bullets and their explanatory paragraphs are gone entirely, not just reworded. Met.
- AC-3: `SKILL.md` line 106-107 narrows the `bob worklog append` call description to `--item <item-identifier>` and `--done <...>` only. Met.
- AC-4: `references/reconciliation.md` narrows all three of its prior three-field comparison descriptions (the automatic check, the "safe to call twice" note, the "only the most recent entry" note) to a single `Done`-value comparison. Met.
- AC-5: `SKILL.md`'s item-identifier paragraph (lines 118-126) now states "Distinct items must get distinct identifiers" alongside the pre-existing "same item keeps the same identifier every time it recurs" requirement. Met.
- `git diff --stat dev-agent...task/T-217-...` touches exactly the three files listed under "Files to Touch" — `SKILL.md`, `references/entry-format.md`, `references/reconciliation.md` — nothing else. No files under `the-intern/bob-skills/.pi/skills/` are touched by this branch's diff, confirmed by the same stat output. Location resolution, tool usage, and the "this skill owns no domain policy" sections of `SKILL.md` are untouched in the diff, as instructed.
- No unspecified behavior added: the one elaboration beyond the literal AC-5 wording ("without conflating two different items that happen to share a label") is directly explanatory of the same distinct-identifiers requirement, not new functionality.
- `B-054` exists at `docs/ai-team/bugs/open/B-054-the-pi-skills-worklog-packaged-copy-is-stale-after-done-only-narrowing.md`, correctly describes the `.pi/skills/worklog` staleness this task's diff intentionally left untouched, and carries the coordinator's note that it will be resolved as a side effect of `T-221`. No action needed on it from this review.

**Stage 2 — Code Quality:**

- Correctness: all three files are internally consistent post-edit — `SKILL.md`'s narrated `append` call, `entry-format.md`'s example call and entry shape, and `reconciliation.md`'s duplicate-check description all agree on the single-field `Done` shape.
- Tests: N/A (markdown skill content, no compiler/test runner); the task's own grep-based Verification section is the applicable check and was run verbatim by this review, not just trusted from the Work Log.
- Security: N/A, no external input or secrets in these files.
- Readability: prose style is consistent with the rest of the skill's existing conventions; no dead/commented-out content left behind from the removed `Left`/`Next` material.
- Performance: N/A.
- Commit hygiene: three commits (`ed319dd`, `f85fdb2`, `8056f13`) on the task branch, each `docs(worklog): …`, imperative, lowercase, no period, longest subject exactly 72 chars — compliant with `git-conventions`.

Both stages pass. No blocking issues found.
