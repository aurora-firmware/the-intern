---
id: T-155
title: Reduce the email-triage skill to delegate diary mechanics to the worklog 
  skill
status: pending
priority: medium
assigned-role: developer
created: '2026-08-09'
spec: S-011
---

# Reduce the email-triage skill to delegate diary mechanics to the worklog skill

## Description

S-011 Implementation Order Phase 3, depends on T-154. Now that a standalone
`worklog` skill exists (T-154), remove the diary-mechanics instructions from
the canonical `email-triage` skill
(`the-intern/email-skills/skills/email-triage/SKILL.md` and its
`references/worklog.md`) and replace them with a delegation reference to the
`worklog` skill. `email-triage` keeps detection, classification, and the
act-or-escalate decision, plus its own retry of a carried-forward blocked
action (S-011 Responsibility Separation, `email-triage` row: "Delegates all
diary mechanics to `worklog`; retains retry of a carried-forward blocked
action"). This is a content reduction, not a rewrite of the triage policy
itself.

## Acceptance Criteria

AC-1: The system shall remove diary-mechanics instructions (entry format,
      first-run detection, reconciliation) from
      `the-intern/email-skills/skills/email-triage/SKILL.md` and its
      references, replacing them with an explicit pointer to the `worklog`
      skill.
AC-2: The system shall retain, in the canonical `email-triage` skill, the
      detection, classification, act-or-escalate decision, and
      carried-forward-blocked-action retry logic unchanged.
AC-3: WHEN the reduced `email-triage` skill is read together with the
      `worklog` skill THE SYSTEM SHALL contain the same complete diary
      discipline that existed before this reduction, with no instruction
      dropped.
AC-4: WHEN the canonical email-triage reduction lands THE SYSTEM SHALL
      regenerate the tracked `.pi/skills/email-triage/` output with T-153's
      packaging script and commit the result in the same change, so no
      committed generated file still carries diary content the canonical
      source no longer has.

## Dependencies

- `T-152` — canonical email-triage source (the files this task edits) must
  exist
- `T-154` — the `worklog` skill it delegates to must exist
- `T-153` — the pi packaging script must exist, because this task changes
  canonical content whose tracked generated `.pi/skills/email-triage/`
  output (T-153's decision: generated output stays committed) must be
  regenerated in the same change, or the repository carries two divergent
  copies of the skill content (Gate 2 dependency correction, 2026-08-09)
- `T-156` — `worklog` must already be in the pi package before the diary
  mechanics are removed from `email-triage`, so the committed package never
  ships without the diary discipline in either skill (Gate 2 dependency
  correction, 2026-08-09)

## Files to Touch

- `the-intern/email-skills/skills/email-triage/SKILL.md` — remove diary
  mechanics, add delegation pointer
- `the-intern/email-skills/skills/email-triage/references/worklog.md` —
  reduced to whatever email-triage-specific content (if any) remains, or
  removed if fully superseded by the `worklog` skill
- `the-intern/email-skills/.pi/skills/email-triage/SKILL.md` — regenerated
  (never hand-edited) to match the reduced canonical source
- `the-intern/email-skills/.pi/skills/email-triage/references/worklog.md` —
  regenerated (never hand-edited)

## Verification

```bash
grep -q "worklog" the-intern/email-skills/skills/email-triage/SKILL.md
cd the-intern/email-skills && ./package-pi-skills.sh && \
  git diff --exit-code HEAD -- .pi/skills
```

Run the second command after committing the regenerated output: it asserts
the *committed* `.pi/skills` tree matches the script's output, so an
uncommitted regeneration is a legitimate non-empty diff. It is meaningful
for a deleted reference file only because T-153 AC-4 requires the script to
regenerate each skill tree from scratch — if this task removes
`skills/email-triage/references/worklog.md`, the generated copy disappears
too and shows up as a deletion here.

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

### Session 1 — 2026-08-10

Implemented T-155 by reducing email-triage's own worklog content to delegate the diary mechanics to the canonical `worklog` skill (merged via T-154/T-156). This session was split by an API session-limit cutoff partway through; picked back up by first re-verifying the in-progress `references/worklog.md` reduction against RED/GREEN checks before committing it, then completed the remaining work.

Read the (empty) Work Log first, then the current canonical `skills/email-triage/{SKILL.md,references/worklog.md,references/escalation.md,references/categories/*.md}` and the merged `skills/worklog/{SKILL.md,references/entry-format.md,references/reconciliation.md}` to map exactly which generic diary mechanics already live in the `worklog` skill versus which pieces of the original `email-triage/references/worklog.md` are genuinely email-triage-specific (not restated generically anywhere else).

Followed the T-153/T-154-established local precedent for pure content-authoring tasks in this package: no dedicated `test_*.sh` file, since there is no control-flow surface to exercise; used the task's own `## Verification` commands as the primary red→green checks, extended with equivalent grep/diff assertions per acceptance criterion, run via Bash before and after each edit.

Three red→green cycles, each committed separately:
1. `references/worklog.md` (`d02a93f`) — reduced from 158 to 55 lines. RED: confirmed the file still contained the generic append heredoc (`mkdir -p worklog`, `cat >> worklog/$TODAY.md <<'EOF'`) and generic first-run-reconciliation walk-back logic, and did not yet name the `worklog` skill as delegate. GREEN: rewrote the file to point at the `worklog` skill for all generic mechanics (location, creation, entry format, first-run detection, reconciliation walk-back), retaining only what's genuinely email-triage-specific — the `<subject> (from <sender>)` item-identifier mapping, the `\Seen`-flag-side-effect rationale (mailbox state can't signal "still open"; this has no domain-neutral equivalent, since the generic `worklog` skill only speaks of "a side effect in that upstream system"), and a condensed "how an open item closes, for email triage" section enumerating the two causes (manager reply / action-authorization allow rule) with pointers to `references/escalation.md` and this skill's own retry step, rather than the previous fully-spelled-out mechanics.
2. `SKILL.md` (`cb95da0`) — RED: confirmed the file did not yet name the `worklog` skill and still described itself as the sole source of reconciliation walk-back and entry-format mechanics. GREEN: updated the frontmatter `description`, the intro paragraph, the "Tool usage" section (generalized the worklog bash/read call descriptions to point at the `worklog` skill's own `references/entry-format.md` and `references/reconciliation.md` rather than restating command examples like `mkdir -p`/`test -f`/`printf ... >>`), Step 1 ("Determine whether this is the day's first executed run, and reconcile" — now follows the `worklog` skill's mechanics, but keeps the domain-specific list of what gets carried forward, i.e. pending manager escalations and blocked actions, and explicitly keeps the retry-of-carried-forward-blocked-action rule), and Step 4 ("Record a worklog entry" — now follows the `worklog` skill's `entry-format.md` for the append mechanics and field definitions, but keeps the item-identifier domain detail and the "describe the actual outcome, not the intended one" guidance). Steps 2 ("List unseen mail") and 3 ("act on it or escalate it") are byte-for-byte unchanged — verified via `git diff` showing no hunks touching those sections, satisfying AC-2 ("detection, classification, act-or-escalate decision, and carried-forward-blocked-action retry logic unchanged").
3. `.pi/skills/email-triage/{SKILL.md,references/worklog.md}` (`cbe342c`) — ran `./package-pi-skills.sh` from `the-intern/email-skills/` to regenerate the pi packaging output from the reduced canonical source, then committed the two regenerated files (never hand-edited).

For AC-3 ("read together, no instruction dropped"), did a section-by-section audit of the original ~280 combined lines (old `SKILL.md` diary-related passages + old 158-line `references/worklog.md`) against the new combined set (reduced `SKILL.md` + reduced `references/worklog.md` + the already-merged `worklog` skill's `SKILL.md`/`references/entry-format.md`/`references/reconciliation.md`). Every generic mechanic (location, creation, exact append-command shape and its safety rationale, generic Done/Left/Next field semantics, first-run-detection logic, first-run-reconciliation walk-back algorithm and day-skip causes, generic carry-forward/no-automatic-expiry mechanics) has a home in the `worklog` skill. Every domain-specific instruction (item-identifier format, the `\Seen`-flag rationale, the two concrete closing causes, the retry timing) is retained in the reduced `references/worklog.md` or `SKILL.md` Step 1. One piece of purely rhetorical connective tissue was not carried forward verbatim — the original Step 1's aside that checking file-presence "avoids a skill-owned last-seen file... the same way this loop avoids a skill-owned last-seen file for detecting new mail (step 2 below)" — but the underlying mechanic it describes (reuse file-presence rather than a second marker file) is itself stated in the `worklog` skill's own `SKILL.md`, so no instruction was actually lost, only a same-skill cross-reference aside.

Considered and rejected: deleting `references/worklog.md` entirely (the task's Files-to-Touch list allows either "reduced" or "removed"). Rejected because six category files (`references/categories/*.md`) and `references/escalation.md` reference `references/worklog.md` by name for "the entry format" and "how an open item closes," and none of those files are in this task's Files-to-Touch list. Keeping a reduced (not deleted) `references/worklog.md` lets every one of those existing cross-references keep resolving to a real file whose claims remain substantively true (via one more hop to the `worklog` skill for the generic mechanics, and directly for the domain-specific closing-condition content) — avoiding a boundary violation that editing those out-of-scope files would have caused.

Ran the task's full `## Verification` block end to end after the third commit: `grep -q "worklog" .../SKILL.md` passes; `./package-pi-skills.sh && git diff --exit-code HEAD -- .pi/skills` is clean (run post-commit, per the task's own note). Also re-ran the pre-existing `test_package_pi_skills.sh` (T-153's packaging test suite) as a regression guard — all 4 tests still pass, confirming the packaging script itself and the other two packaged skills (`himalaya`, `worklog`) were undisturbed.

Nothing remains for T-155's four acceptance criteria. `git diff --stat dev-agent...HEAD` shows exactly the four files in "Files to Touch" and nothing else; the task lifecycle file was not touched on this branch.

Obstacles Encountered:
- This session was interrupted mid-cycle by an API session-limit error after the `references/worklog.md` reduction had been written but not yet verified or committed. Resumed by re-running RED/GREEN checks against the on-disk state before trusting and committing it — no rework needed, the pre-cutoff content was correct.
- No dedicated test framework applies to markdown skill-content authoring in this package; followed the T-153/T-154-established convention (task's own `## Verification` command as the primary red→green check, extended with per-AC grep/diff assertions) rather than adding a `test_*.sh` file.
- Six out-of-scope files (`references/categories/*.md`, `references/escalation.md`) reference `references/worklog.md`'s "entry format" claim, which is no longer directly defined there after reduction (it's now one hop further via the `worklog` skill). Judged this an acceptable indirection consistent with the rest of this reduction's delegation pattern, not a defect — did not edit those out-of-scope files.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->
