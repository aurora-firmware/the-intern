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

### Session 1 — 2026-08-02

Read the Work Log first (empty — first session on this task). Read T-136 in full, then T-135's `SKILL.md` to find the exact placeholder text this task replaces (step 3.1's parenthetical: "A category taxonomy and per-category reference workflows live under `references/categories/` once added on top of this loop — when that taxonomy exists, classify against it and follow the matched category's workflow; until then, use your own judgment"), plus T-131's package README (layout, `-p -a` invocation form), T-134's `escalation.md` and `worklog.md` (referenced but not restated), and S-010 in full (Purpose, Exclusions — especially "the starter taxonomy... is an initial, adjustable sketch, not committed final policy", Design Principles — the confidence-gated autonomy rule, never reversibility/allowlist), plus the pending T-137/T-138 task files to confirm the exact five workflow-file names (`newsletter-bulk.md`, `automated-notification.md`, `suspected-spam.md`, `direct-request.md`, `meeting-scheduling.md`) this index and `SKILL.md` needed to name correctly ahead of those tasks existing. Also re-read T-134/T-135's own Work Log and Review sections to confirm the established methodology for this docs-only package (per-AC `rg` red→green cycles, plus a final `pi -p -a` behavioral probe against a scratch copy) and carried it forward rather than inventing a new one.

Wrote `references/categories/README.md` in four red→green cycles, each confirmed absent (`rg`, file-not-found or pattern-not-found) before writing and present after, committed individually: (1) AC-1 — the five category headers with an intro/index-purpose paragraph and per-category matching-signal lists (sender shape, subject/body patterns, headers); (2) AC-2 — the confidence rubric itself (confident/not-confident conditions, explicitly naming ambiguous-two-category-match as not confident by definition, and a conservative "when in doubt, escalate" closing note); (3) part of AC-4 — a dedicated "No confident match" section stating explicitly that a non-confident message escalates rather than being filed under whichever category scored closest; (4) AC-5 — the "Adding a category" section stating the exact two-addition rule (one workflow file, one index entry) and that neither `SKILL.md` nor the `himalaya` skill needs to change.

Rewired `email-triage/SKILL.md` step 3 in two more red→green cycles: (5) AC-3 — replaced the T-135 placeholder's classification sub-step with real wiring (classify against `references/categories/README.md`'s signals and rubric) and its "high confidence" sub-step with "follow the matched category's own workflow file, `references/categories/<category>.md`"; (6) AC-4 (SKILL.md side) — renamed the "low confidence" branch to "no confident match" (including the ambiguous-match case by cross-reference to the index), and added the explicit "never fall back to choosing the closest category... 'closest' is not 'confident'" rule, cross-referencing the index's own "No confident match" section rather than restating it. Confirmed after each cycle that no himalaya CLI syntax leaked into either file (`rg` for literal `himalaya envelope|message|template|flag|attachment` commands stayed at zero matches throughout, matching T-135's own check).

Ran the task's full Verification block as the acceptance-level check: structural `rg` on both files matched as specified. The literal bare `pi -p "..."` behavioral-check command reproduced the same known non-skill-sourced-answer discrepancy T-131/T-132/T-134/T-135 already recorded (recorded as an Obstacle rather than re-litigated). Cross-checked with `-p -a` plus explicit `read`-tool permission (T-135's own review-isolated pitfall around "do not run any tool" blocking pi's on-demand skill reads): the first pass correctly classified the obvious newsletter and the direct question, naming the right workflow files, but classified the intended-to-be-ambiguous billing/invoice message ("Action required on your invoice") as a confident `automated-notification` match rather than escalating it — the `suspected-spam` signal list wasn't specific enough to put that category in contention for this exact phrasing. Treated this as a genuine red→green cycle: strengthened the `suspected-spam` signals (added "action required" urgency wording and a billing/invoice-without-verifiable-detail signal) and added a worked example to the confidence rubric naming this exact ambiguity, then re-ran the probe and confirmed it now correctly reports "no confident category: ambiguous `automated-notification` vs `suspected-spam` — escalate." Committed that refinement as its own cycle (seventh commit). Ran two more targeted probes beyond the literal block, mirroring T-134/T-135's precedent: a personal-but-ask-free message correctly returned "no confident match... escalate" rather than being forced into `direct-request` (confirms the "weak/no match" rubric branch, not just the ambiguous-match branch); an "adding a category" probe correctly described the two-addition rule and confirmed no `himalaya`-skill change, without prompting. Removed the scratch copy afterward.

After the initial seven commits, checked commit-subject length against the `git-conventions` ≤72-char rule and found six of seven over the limit (up to 83 chars) — worse than the "minor, non-blocking" precedent T-133/T-135 recorded for one or two long subjects. Since none of these commits had any remote/upstream, rewrote local history (cherry-pick each commit onto a fresh copy of the branch at its pre-task base, amending each message immediately after its cherry-pick rather than using an interactive rebase) to bring every subject under 72 characters, verified the rewritten tree was byte-identical to the original via an empty `git diff` against a temporary backup branch, then deleted the backup branch. Final branch: seven commits, same order, same diffs, all `docs(email-triage): ...`, all within the length convention.

Nothing remains for this task as scoped: both `Files to Touch` entries exist, all five acceptance criteria have supporting `rg` and behavioral-probe evidence above, and the working tree is clean with seven commits on the task branch, none touching the canonical task file (`git diff dev-agent...HEAD -- docs/ai-team/tasks/in-progress/T-136-...md` is empty). The two workflow-file groups this index and `SKILL.md` now name by path (`newsletter-bulk.md`/`automated-notification.md`/`suspected-spam.md` for T-137, `direct-request.md`/`meeting-scheduling.md` for T-138) do not exist yet — that is explicitly those two tasks' own scope, not this one's; this session did not invent placeholder content for them.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->

### Review Verdict — 2026-08-02

PASS

**Stage 1 — Acceptance criteria.** All five criteria met, checked directly
against `references/categories/README.md` and `SKILL.md` on the task branch
(`61e4ec5`), diffed against `dev-agent`:

- AC-1: all five categories (`newsletter-bulk`, `automated-notification`,
  `suspected-spam`, `direct-request`, `meeting-scheduling`) present with
  concrete matching signals (sender shape, subject/body patterns, headers).
- AC-2: "Confidence rubric" section states confident/not-confident
  conditions and explicitly names ambiguous two-category match as not
  confident by definition, not an edge case.
- AC-3: `SKILL.md` step 3.2 ("Confident match") follows
  `references/categories/<category>.md` for the matched category, replacing
  T-135's placeholder judgment step.
- AC-4: both the index's "No confident match" section and `SKILL.md` step
  3.3 escalate per `references/escalation.md` rather than choosing the
  closest category; "closest is not confident" is stated explicitly in
  both files.
- AC-5: "Adding a category" section states the two-addition rule (one
  workflow file, one index entry) and confirms no `himalaya`-skill change;
  confirmed independently — `git diff dev-agent..task/T-136-...` touches
  only `SKILL.md` and `references/categories/README.md`, nothing under
  `.pi/skills/himalaya/`.

Only the two `Files to Touch` entries were modified; no unspecified
behavior or functionality was added; `rg` checks from the task's
Verification block reproduced as specified (23 taxonomy/confidence hits in
the index, 5 `categories/` references in `SKILL.md`, zero leaked raw
`himalaya <subcommand>` CLI syntax in either file).

**Stage 2 — Code quality.** Readable, focused sections; cross-references
route to the single source of truth (index for rubric detail, escalation.md
for escalation policy, per-category workflow files for action detail)
without restating them, consistent with S-010's Design Principles. No dead
text or unresolved placeholders. N/A: security, performance (docs-only
change).

**Independent verification of the two flagged items:**

1. **Ambiguity-escalation behavior, reproduced independently.** Built two
   scratch copies of the full package (task branch tip, `pi 0.80.3`, `-p -a`
   per the package README's verified invocation form) — one with the
   pre-fix `suspected-spam` signals (`git show 61e4ec5^:...README.md`), one
   with the current, fixed signals — and ran the task's own Verification
   probe (three-message classification prompt) against both, independent of
   the Developer's transcript. Pre-fix copy: message 2 (`billing@example.com`
   / "Action required on your invoice") returned `automated-notification`,
   confidence Medium, no escalation. Post-fix copy: same message returned
   "No confident category: ambiguous `automated-notification` vs
   `suspected-spam`", confidence Low, action `escalate`. Messages 1 and 3
   classified confidently and correctly in both copies. This independently
   reproduces the Work Log's claim exactly (both the pre-fix failure and the
   post-fix escalation), confirming the confidence rubric's ambiguous-match
   rule actually functions as S-010's confidence-gated autonomy model
   requires, not just as asserted narrative.

2. **Rewritten commit history, verified without the deleted backup branch.**
   The pre-rewrite commit chain was still recoverable from the local reflog
   (`git reflog show --all`) and unreachable-but-ungarbage-collected objects
   (`git fsck --unreachable`) — the backup branch's deletion did not remove
   the underlying commits yet. Located the pre-rewrite tip (`58ec792`,
   "sharpen spam-vs-notification ambiguity signals and example") and its
   6 ancestors back to the same base commit as the current branch
   (`7a14dbb`, "move T-136 to in-progress"; confirmed via `git merge-base`).
   `git diff 58ec792 61e4ec5` is empty — the rewritten tree is byte-identical
   to the pre-rewrite tree, independently confirming the Developer's claim.
   Commit count (7), order, and base match between the two chains. All 7
   final subjects are ≤72 chars (max 67), type `docs`, scope `email-triage`,
   imperative/lowercase/no period — compliant with `git-conventions`. The
   task branch has no remote tracking ref and was never pushed
   (`git ls-remote --heads origin` has no `T-136` ref), so amending local
   commits does not violate the "no amending pushed commits" hard rule.

No blocking issues found.
