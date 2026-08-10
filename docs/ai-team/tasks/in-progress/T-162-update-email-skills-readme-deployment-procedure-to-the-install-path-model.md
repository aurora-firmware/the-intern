---
id: T-162
title: Update email-skills README deployment procedure to the install-path model
status: pending
priority: medium
assigned-role: developer
created: '2026-08-09'
spec: S-011
---

# Update email-skills README deployment procedure to the install-path model

## Description

S-011 Implementation Order Phase 5 — the package-level counterpart to
T-161's user-manual update. `the-intern/email-skills/README.md`'s "Verified
deployed-workspace procedure" and "Verified S-004 action rules for the
happy path" sections still describe the per-workspace deployed-copy model
(T-139/T-140), which this spec replaces. Update them to describe the new
canonical-source + packaging-target layout (T-151–T-153, T-156) and the
install-path deployment/action-rule model (matching T-161), so the
package's own README stays the authoritative, accurate record for anyone
reading it directly rather than the user manual.

## Acceptance Criteria

AC-1: The system shall update `the-intern/email-skills/README.md`'s
      package-layout description to reflect one canonical `skills/` source
      with two generated packaging targets: `.pi/skills/` (T-151–T-153,
      T-156) and `claude/` (T-163).
AC-2: The system shall replace the "Verified deployed-workspace procedure"
      and "Verified S-004 action rules" sections' per-workspace
      deployed-copy guidance with the install-path deployment model.

## Dependencies

- `T-153` — packaging target exists (package layout to document)
- `T-156` — worklog skill packaged
- `T-161` — keeps the package README and the user-manual operator guide
  describing the same model
- `T-163` — the Claude packaging target is part of the package layout this
  task documents; no other task updates the README afterwards, so
  documenting the layout before that target exists leaves the package's own
  authoritative record incomplete (Gate 2 dependency correction, 2026-08-09)

## Files to Touch

- `the-intern/email-skills/README.md` — package layout and deployment
  procedure sections

## Verification

```bash
! grep -q "Verified deployed-workspace procedure" the-intern/email-skills/README.md
! grep -q "Verified S-004 action rules for the happy path" the-intern/email-skills/README.md
grep -q "claude/" the-intern/email-skills/README.md
```

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

### Session 1 — 2026-08-10

Read the (empty) Work Log first, then S-011, T-161 (the completed operator-guide/quickstart counterpart, used as the reference model for install-path language), and the merge history/current filesystem state for T-151–T-153, T-156, T-163 (`skills/`, `.pi/skills/`, `claude/`, `package-pi-skills.sh`, `package-claude-skills.sh` all already exist on `dev-agent`; the README had never been updated to mention `worklog` as a third canonical skill or the `claude/` packaging target at all).

Two TDD cycles, each grep-based red/green-confirmed (same precedent T-150/T-155/T-156/T-161 established for markdown-authoring tasks with no control-flow surface), each committed separately:

1. **AC-1** (`ebe57ba`): rewrote the intro paragraph (now names all three shipped skills, including `worklog`, and both packaging targets) and the "Package layout" ASCII tree/prose to show the canonical `skills/` source with `himalaya`, `email-triage`, and `worklog`, and both generated targets `.pi/skills/` (T-153/T-156) and `claude/` (T-163). Added a "Regenerating the Claude package" subsection mirroring the existing "Regenerating the pi package" one, noting `claude/skills/` needs no vendor-specific frontmatter field (unlike `.pi/skills/`), matching T-163's own test assertion (`test_ac3_output_byte_identical_to_canonical_source`).
2. **AC-2** (`fe9ab41`): replaced "This package is the repository source of truth only" / "Verified deployed-workspace procedure" / "Verified S-004 action rules for the happy path" with "This package is installed once, service-wide — not copied per job" / "Verified install-path deployment procedure" / "Verified S-004 action rules for the install-path model" — the install-once-to-`skill_install_path` model, a job workspace holding only `config/`+`worklog/`, and S-004 rules scoped to `/abs/skill-install-path/...` (including two new, explicitly-flagged-as-not-yet-live-validated `worklog` skill read rules, and dropping the now-redundant absolute worklog-path rule in favor of the existing relative one — same reasoning T-161 applied to the operator guide). All T-139/T-140/B-029/B-030/B-031/B-034 historical evidence narrative was preserved verbatim since it documents what actually happened under the old (now superseded) model; added one paragraph explaining the `arguments.path`/`arguments.command` matcher-shape invariant is unaffected by which path the content lives at, so no fresh live probe was needed — same reasoning and same "no `pi` binary in this task's Dependencies" framing T-161 used for its own "re-validation."

Ran the task's `## Verification` block after each cycle and again at the end — all three commands pass. `git diff --stat dev-agent...task/T-162-email-skills-readme-install-path` confirms only `the-intern/email-skills/README.md` (the sole Files-to-Touch entry) was modified. Confirmed no other repo file (docs/src, test scripts) referenced either retired section heading. The task lifecycle file was not touched on this branch. Nothing remains for this task's two acceptance criteria.

Obstacles Encountered:
- The task's own `## Verification` grep for `"claude/"` was already trivially true before any edit, because line 7's pre-existing text `` `.claude/skills` `` contains that substring — so it could not be used as a meaningful red/green signal for AC-1. Used more specific greps (`package-claude-skills.sh`, `claude/skills/`, `diary-discipline skill`) as the actual red/green checks for that cycle instead, and still ran the literal task verification block at the end for the record.
- No `pi` binary or live credentials were used or needed — pure documentation task, same as T-161.

### Session 2 — 2026-08-10

Read the Work Log (Session 1) and the `### Review Verdict — 2026-08-10` FAIL entry. The verdict identified two issues in the AC-1/AC-2 rewrite: (1) a factual attribution defect repeated at four locations (`README.md:6, 64, 76, 398`) crediting `T-155/T-156` for the canonical `worklog` skill's origin, when git history (`9f10a27`, T-154's merge) shows T-154 actually extracted it, and T-156's sole commit (`55d819c`) only touches `.pi/skills/worklog/` packaging output, never canonical `skills/worklog/`; (2) a minor leftover "deployed copy" phrase at `README.md:192` inconsistent with the section's own rewritten "workspace" terminology.

Fixed both issues in a single commit (`546d1ef`), as the review explicitly asked to bundle the minor phrasing fix with the citation fix:
- Line 6 (intro paragraph): `S-011/T-155/T-156` → `S-011/T-154/T-155`.
- Line 64 (package-layout tree, `skills/` line): `T-151/T-152/T-155/T-156` → `T-151/T-152/T-154/T-155`.
- Line 76 (package-layout tree, `worklog/` line): `(S-011/T-155/T-156)` → `(S-011/T-154/T-155)`.
- Line 398 (S-004 action-rules narrative): `` (`T-155`/`T-156`) `` → `` (`T-154`/`T-155`) ``.
- Line 80 (`.pi/skills/` packaging-target citation, `T-153/T-156`) was deliberately left unchanged — the review confirmed this one is correct, since T-156 genuinely extended the pi packaging script to include `worklog`.
- Line 192: `# then edit only the deployed copy's config/email-triage.toml and set` → `# then edit only the job workspace's config/email-triage.toml and set`, matching the operator guide's equivalent step-3 wording and the rest of the "Verified install-path deployment procedure" section's consistent use of "workspace." Left the one remaining "deployed copy" occurrence (line 478, T-139/T-140 historical narrative) untouched since it's accurate past-tense prose, not present-tense guidance.

Re-ran the task's literal `## Verification` block after the fix — all three commands pass. Confirmed via `git diff --stat dev-agent...task/T-162-email-skills-readme-install-path` that only `the-intern/email-skills/README.md` was modified across the entire branch; the task lifecycle file was not touched on this branch. No new tests were needed beyond the existing grep-based verification precedent already established in Session 1, since this cycle only corrects factual citations and one phrase, with no new behavior or control flow to cover.

Obstacles Encountered: none — the review verdict gave exact line numbers and replacement text for all five edits, so no diagnostic work was required.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->

### Review Verdict — 2026-08-10

FAIL

**Verification-block scrutiny note first:** independently confirmed the
Developer's flagged observation — the task's own literal `## Verification`
grep for `"claude/"` is vacuously true pre-edit (`dev-agent`'s prior
`README.md:7` already contains the substring `.claude/skills`), so it could
not serve as a red/green signal for AC-1. This matches the established
T-150/T-153/T-155/T-156 precedent of documenting a no-red AC rather than
skipping coverage, and the Developer correctly used more specific greps
(`package-claude-skills.sh`, `claude/skills/`) as the real red/green checks.
Not a review issue on its own. All three literal verification commands were
re-run directly against the branch and pass.

**Stage 1 — Acceptance Criteria:**
- AC-1 (package-layout description reflects one canonical `skills/` source
  with two generated packaging targets, `.pi/skills/` T-151–T-153/T-156 and
  `claude/` T-163): mostly met, but see the Stage 2 correctness defect below
  — one of the two packaging-target citations required by this AC is
  correct (`claude/` → T-163, `.pi/skills/` → T-153/T-156), but the
  Developer's own added citation for the canonical `skills/` source itself
  is factually wrong in a way that undermines this AC's purpose (an
  accurate package-layout description).
- AC-2 (replace "Verified deployed-workspace procedure"/"Verified S-004
  action rules" sections' per-workspace deployed-copy guidance with the
  install-path model): met. Independently re-ran the task's own grep checks
  and confirmed both retired headings are gone
  (`## Verified install-path deployment procedure`, `## Verified S-004
  action rules for the install-path model` now exist instead), the
  `cp -r the-intern/email-skills/. "$WORKSPACE/"` full-package copy is
  removed, the deployed job workspace now holds only `config/`+`worklog/`,
  and the S-004 rule set is rewritten to `/abs/skill-install-path/...`
  patterns.
- Files touched: only `the-intern/email-skills/README.md` (the sole Files
  to Touch entry) — confirmed via `git diff --stat
  dev-agent...task/T-162-email-skills-readme-install-path`. No other file
  modified.

**Stage 2 — Code Quality / cross-check against what T-153/T-156/T-161/T-163
actually shipped (the specific scrutiny requested):**

- Ran both packaging scripts (`package-pi-skills.sh`,
  `package-claude-skills.sh`) against the real repo tree on this branch —
  both produce a zero `git diff`, confirming the README's "committed
  tracked output, regenerate and commit" claims are accurate and the
  `.pi/skills/{himalaya,email-triage,worklog}/` and
  `claude/skills/{himalaya,email-triage,worklog}/` trees the layout diagram
  describes actually exist as described.
- Cross-checked the rewritten S-004 action-rule TOML block (8 `read` rules
  + `bash` rules) line-for-line against `the-intern/docs/src/operator-
  guide/index.md`'s T-161-rewritten "Deploying the `email-triage` scheduled
  job" § step 4 — identical rule order, identical pattern shapes (only
  `/abs/skill-install-path/...` vs. the guide's worked `/opt/bob/skills/...`
  example differ, as expected for a generic vs. worked example). The new
  `worklog/SKILL.md` and `worklog/references/*.md` rules and the "not yet
  independently live-validated" callout match the operator guide's
  equivalent callout. `skill_install_path`'s Linux/macOS defaults
  (`~/.local/share/bob/skills`, `~/Library/Application Support/bob/skills`)
  match `operator-guide/index.md`'s "Install the skill package" § exactly.
  Cross-checked S-011's Design Principles ("content must exist exactly
  once", "manifests and layout only") and ADR-014's framing — both matched
  by the README's prose.
- **Defect — factual attribution error, repeated at four locations:** the
  canonical `worklog` skill under `the-intern/email-skills/skills/worklog/`
  was created by **T-154** ("Extract the domain-free worklog skill from
  email-triage" — confirmed via `git log`, commit `9f10a27 feat(email-
  skills): add domain-free worklog skill overview`, part of T-154's merge).
  **T-156 never touches `skills/worklog/`** — confirmed via `git show
  55d819c --stat` (T-156's sole commit): it only modifies
  `package-pi-skills.sh`, `test_package_pi_skills.sh`, and
  `.pi/skills/worklog/**` (the generated *pi packaging* output), never
  anything under canonical `skills/`. This diff introduces or extends four
  citations that cite `T-155`/`T-156` for the worklog skill's *canonical
  source/extraction*, omitting `T-154` (the task that actually did the
  extraction) entirely:
  - `README.md:6` — "plus `worklog` (the domain-free diary-discipline skill
    S-011/T-155/T-156 extracted out of `email-triage`)" — should cite
    T-154 (extraction) and T-155 (email-triage delegation reduction), not
    T-156.
  - `README.md:64` — "`skills/` # T-151/T-152/T-155/T-156: canonical,
    vendor-neutral skill source" — should read T-151/T-152/**T-154**/T-155
    (T-151 himalaya, T-152 email-triage, T-154 worklog, T-155 email-triage
    reduction); T-156 has no role in the canonical `skills/` tree at all.
  - `README.md:76` — "`worklog/` # domain-free diary-discipline skill
    (S-011/T-155/T-156)" — same error; should cite T-154 (and optionally
    T-155 for the companion delegation-reduction side of the extraction),
    not T-156.
  - `README.md:398` — "the `worklog` skill (`T-155`/`T-156`) that the
    reduced `email-triage` `SKILL.md` now delegates diary mechanics to" —
    same error; should cite `T-154`/`T-155`.
  Note `README.md:80` ("`.pi/` skills/ # T-153/T-156: generated pi
  packaging target") is **correct** — T-153 created the pi packaging
  script and T-156 genuinely did extend it to include `worklog`, so that
  citation is right; only the *canonical-source* citations (attributing
  where `skills/worklog/` itself came from) are wrong. This looks like a
  T-154→T-156 substitution made consistently across the diff, not an
  isolated typo, so it should be swept for correctness everywhere `T-156`
  is cited in the context of the canonical `worklog` skill's origin, not
  just patched at one line.
  This is a real, actionable correctness defect in documentation that this
  task's own description says must "stay the authoritative, accurate
  record for anyone reading it directly" — a future reader tracing
  `skills/worklog/`'s origin via this file would be pointed at T-156 (pi
  packaging only) instead of T-154 (the actual extraction task).
- **Minor, non-blocking, bundle with the fix above:** `README.md:192`'s
  bash-block comment — `# then edit only the deployed copy's
  config/email-triage.toml and set / # manager_address there` — is
  unchanged leftover text from before this diff, sitting inside the
  rewritten "Verified install-path deployment procedure" section. Every
  other reference to the job's `--cwd` directory in this rewritten section
  now consistently says "workspace" (never "deployed copy" as present-tense
  guidance — "deployed copy" only appears elsewhere as accurate *historical*
  narrative about the old model). Since step 1 of this same procedure
  installs a separate "deployed" skill package to the skill install path,
  "the deployed copy's config/email-triage.toml" is ambiguous about which
  deployed thing it means. Reword to match the surrounding prose, e.g.
  "then edit only the job workspace's config/email-triage.toml" (matching
  `operator-guide/index.md`'s step 3 wording, "Edit only the job
  workspace's `config/email-triage.toml`").
- Correctness/Readability otherwise: the rewritten prose, package-layout
  ASCII tree structure, "Regenerating the Claude package" subsection, and
  the "This package is installed once, service-wide" / "Verified
  install-path deployment procedure" sections are accurate, well
  cross-referenced, and consistent with T-153/T-156/T-161/T-163 as actually
  shipped, aside from the citation defect above. Internal anchor links
  (`#package-layout`, `#verified-install-path-deployment-procedure`,
  `#validation-outcomes`) all resolve to real headings.
- Security/Performance: N/A — documentation-only change.

**What should change:** fix the T-154/T-155/T-156 citation error at the four
locations listed above (`README.md:6,64,76,398`), and while in the area,
reword the leftover "deployed copy" phrasing at `README.md:192`. No other
changes needed — the substantive install-path-model rewrite (AC-2) and the
packaging-target layout (AC-1, apart from the citation defect) are correct
and verified against the real repo state and the referenced tasks.

Next owner: active Development Loop.

### Review Verdict — 2026-08-10

PASS

**Verified fix commit (`546d1ef`, "fix(email-skills): cite T-154 for canonical
worklog skill origin"), branch `task/T-162-email-skills-readme-install-path`.**
Checked `git show 546d1ef` directly: it changes exactly the five lines the
prior FAIL verdict specified, nothing else.

- `README.md:6` — `S-011/T-155/T-156` → `S-011/T-154/T-155`. Confirmed.
- `README.md:64` — `T-151/T-152/T-155/T-156` → `T-151/T-152/T-154/T-155`.
  Confirmed.
- `README.md:76` — `(S-011/T-155/T-156)` → `(S-011/T-154/T-155)`. Confirmed.
- `README.md:398` — `` (`T-155`/`T-156`) `` → `` (`T-154`/`T-155`) ``.
  Confirmed.
- `README.md:80` (`.pi/skills/` packaging-target citation, `T-153/T-156`) —
  correctly left unchanged, as the prior verdict noted this one is accurate.
- `README.md:192` — `# then edit only the deployed copy's
  config/email-triage.toml` → `# then edit only the job workspace's
  config/email-triage.toml`. Confirmed, and now matches the operator guide's
  equivalent step-3 wording as well as the rest of the "Verified install-path
  deployment procedure" section's consistent "workspace" terminology.

Independently re-verified the underlying facts the fix corrects: `git show
9f10a27 --stat` confirms T-154 ("feat(email-skills): add domain-free worklog
skill overview") added `the-intern/email-skills/skills/worklog/SKILL.md` —
the canonical source. `git show 55d819c --stat` (T-156's sole commit)
confirms it touches only `.pi/skills/worklog/**` (generated pi-packaging
output), `package-pi-skills.sh`, and `test_package_pi_skills.sh` — never
canonical `skills/worklog/`. The fix's citations are factually correct.

Grepped the full post-fix `README.md` for every `T-154`/`T-155`/`T-156`
occurrence (5 hits, all listed above and all correct) and every remaining
"deployed copy" occurrence (1 hit, line 478 — `"T-139 established the happy
path on the live deployed copy"`, accurate past-tense historical narrative
about the pre-install-path model, correctly left untouched, consistent with
the prior verdict's guidance to leave it alone).

**Stage 1 — Acceptance Criteria (re-checked in full, not just the delta):**
- AC-1 (package-layout description reflects one canonical `skills/` source
  with two generated packaging targets, `.pi/skills/` T-151–T-153/T-156 and
  `claude/` T-163): met. With the citation fix, all package-layout citations
  are now accurate — `skills/` → T-151/T-152/T-154/T-155,
  `.pi/skills/` → T-153/T-156, `claude/` → T-163.
- AC-2 (replace "Verified deployed-workspace procedure"/"Verified S-004
  action rules" sections' per-workspace deployed-copy guidance with the
  install-path model): met, unaffected by this session's fix. Re-ran the
  task's own grep checks: both retired headings are gone, `## Verified
  install-path deployment procedure` and `## Verified S-004 action rules for
  the install-path model` exist instead.
- Task `## Verification` block re-run against the branch — all three
  commands pass:
  `! grep -q "Verified deployed-workspace procedure"`,
  `! grep -q "Verified S-004 action rules for the happy path"`,
  `grep -q "claude/"`.
- Files touched across the whole branch: `git diff --stat
  dev-agent...task/T-162-email-skills-readme-install-path` shows only
  `the-intern/email-skills/README.md` (176 insertions, 81 deletions,
  1 file) — the sole Files-to-Touch entry. No unrelated file modified this
  session or any prior session on this branch.

**Stage 2 — Code Quality:**
- Ran both packaging scripts (`package-pi-skills.sh`,
  `package-claude-skills.sh`) against the real repo tree on this branch from
  a scratch worktree — both still produce a zero `git diff` against
  `.pi/skills/` and `claude/` respectively, confirming the README's
  "committed tracked output, regenerate and commit" claims remain accurate
  after the fix.
- The fix is minimal and surgical — exactly the citation/phrasing corrections
  the prior verdict specified, no unrelated rewording, no scope creep.
- Readability: the corrected citations read naturally in context; no
  dangling or inconsistent terminology remains.
- Security/Performance: N/A — documentation-only change.

Both prior defects are resolved and no new issues were introduced. Minor
observation (non-blocking): none.

Next owner: active Development Loop.
