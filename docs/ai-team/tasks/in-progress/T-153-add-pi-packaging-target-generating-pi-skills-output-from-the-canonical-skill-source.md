---
id: T-153
title: Add pi packaging target generating .pi/skills output from the canonical 
  skill source
status: pending
priority: medium
assigned-role: developer
created: '2026-08-09'
spec: S-011
---

# Add pi packaging target generating .pi/skills output from the canonical skill source

## Description

S-011 Implementation Order Phase 2, completing the restructuring started in
T-151/T-152. Add a packaging mechanism that generates
`the-intern/email-skills/.pi/skills/{himalaya,email-triage}/SKILL.md`
(+ `references/`) from the canonical source at
`the-intern/email-skills/skills/{himalaya,email-triage}/`, adding back only
the pi-specific `allowed-tools` frontmatter field, with no independent copy
of the body content (S-011 Design Principles: per-vendor packaging must carry
manifests and layout only, never a second copy of the content). Once this
exists, regenerate `.pi/skills/{himalaya,email-triage}/` from the canonical
source instead of hand-maintaining it, so the pi package becomes generated
output, not a second authored copy. A simple script under
`the-intern/email-skills/` that copies canonical files and re-adds the
frontmatter field is sufficient — this does not need a general-purpose build
system.

**Tracked-vs-generated decision:** the generated `.pi/skills/` output stays
tracked in version control, consistent with the root `.gitignore`'s existing
treatment of `the-intern/email-skills/.pi/` as deliberately committed
package content (this package has no build step in CI or at install time
that could regenerate it on demand, and it must remain available to a plain
`git clone` without running a script first). S-011's "content must exist
exactly once" principle is satisfied in the authoring sense — the generated
tree carries no independently-authored content, only a mechanical copy plus
the one frontmatter field — not in the literal on-disk-bytes sense.

## Acceptance Criteria

AC-1: The system shall provide a packaging script that generates
      `.pi/skills/himalaya/SKILL.md` and `.pi/skills/email-triage/SKILL.md`
      (with their `references/` trees) from the canonical source under
      `the-intern/email-skills/skills/`.
AC-2: WHEN the packaging script runs THE SYSTEM SHALL produce generated
      `.pi/skills/*/SKILL.md` files whose body content is byte-for-byte
      identical to the canonical source and whose frontmatter additionally
      contains `allowed-tools: Read Bash`.
AC-3: The system shall commit the regenerated `.pi/skills/{himalaya,email-triage}/`
      output to version control (unchanged tracked status from today), with
      its content no longer hand-authored but produced solely by running the
      packaging script against the canonical source.
AC-4: WHEN the packaging script runs THE SYSTEM SHALL regenerate each
      packaged skill's `.pi/skills/<name>/` tree from scratch, so a file
      deleted from the canonical source does not survive as stale generated
      output. Without this, T-155's regenerate-and-diff check silently passes
      when it deletes a canonical reference file, leaving diary content
      shipping in the committed package (Gate 2 correction, 2026-08-09).

## Dependencies

- `T-151` — canonical himalaya source must exist
- `T-152` — canonical email-triage source must exist

## Files to Touch

- `the-intern/email-skills/package-pi-skills.sh` (or equivalent) — new
  packaging script
- `the-intern/email-skills/.pi/skills/himalaya/SKILL.md` — regenerated (was
  hand-maintained)
- `the-intern/email-skills/.pi/skills/email-triage/SKILL.md` — regenerated
  (was hand-maintained)
- `the-intern/email-skills/README.md` — note the package layout now includes
  a generated `.pi/` output alongside canonical `skills/`

## Verification

```bash
cd the-intern/email-skills && ./package-pi-skills.sh && git diff --exit-code HEAD -- .pi/skills
```

Run this after committing the regenerated output. The check asserts the
*committed* `.pi/skills` tree is exactly what the script produces, so an
uncommitted regeneration is a legitimate non-empty diff, not a failure to
fix by editing generated files.

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

### Session 1 — 2026-08-10

Implemented the pi packaging target for T-153. T-151/T-152 had already landed the canonical vendor-neutral skill source under the-intern/email-skills/skills/{himalaya,email-triage}/; the tracked the-intern/email-skills/.pi/skills/{himalaya,email-triage}/ trees were still hand-maintained copies of that content plus one added frontmatter field (allowed-tools: Read Bash). This session replaced that hand maintenance with a generator.

Wrote the-intern/email-skills/package-pi-skills.sh across three TDD cycles, each covering one acceptance criterion: (1) copy each canonical skill directory (SKILL.md + references/) into .pi/skills/<name>/, proving AC-1; (2) insert allowed-tools: Read Bash as the last frontmatter field of the generated SKILL.md via a small awk pass that counts `---` delimiter lines, leaving every other byte identical to the canonical source, proving AC-2 (tested by stripping that one line back out of the generated file and diffing against canonical); (3) rm -rf each destination directory before re-copying, so a file removed from the canonical source can't survive a re-run as stale generated output, proving AC-4 (tested by planting a stray reference file in the generated tree and asserting it's gone after a re-run). A fourth test was added for AC-3, but it isn't a script behavior — it's a regression guard confirming the generated .pi/skills output stays git-tracked and outside .gitignore's root-anchored /.pi rule, which the task description already established as true today; documented this explicitly rather than staging an artificial red step for it.

Ran the finished script against the real repository tree: the output was byte-for-byte identical to what was already committed, so no content changes were needed there — the hand-maintained copies had stayed in sync with the canonical source by coincidence of careful prior editing, and the script now guarantees that going forward. Updated README.md's package layout section to show both the canonical skills/ tree and the generated .pi/skills/ tree, name the script, and give the regenerate-and-commit procedure (this doubles as the operator note requested in Files to Touch). Ran the task's own Verification command (./package-pi-skills.sh && git diff --exit-code HEAD -- .pi/skills) after each commit that touched generated output; it passed cleanly throughout since there was never a diff to commit.

Rejected approaches: considered a Python or Node script instead of bash, but the existing scripts/*.sh and tests/*.sh conventions in this repo are plain bash with set -euo pipefail, and the task explicitly says a simple script is sufficient — no general-purpose build system needed. Considered doing the frontmatter insertion with sed instead of awk; awk's delimiter counter reads more clearly than a sed line-number lookup that would need a separate `grep -n` pass first.

Confirmed pre-existing, unrelated failures in tests/test_coding_guidelines.sh, tests/test_roadmap.sh, tests/test_the_intern_structure.sh, and tests/test_workflows.sh are identical before and after this session's changes (checked via git stash), so nothing here introduced new breakage; out of this task's scope to fix.

Nothing remains for T-153's acceptance criteria. Files touched: package-pi-skills.sh (new), test_package_pi_skills.sh (new, beyond the task's listed Files to Touch — added to satisfy the tdd skill's test requirement; noted here as the justification), .pi/skills/{himalaya,email-triage}/SKILL.md (regenerated, no content change), README.md (package layout section updated).

Obstacles Encountered:
- The task's `Files to Touch` list does not mention a test file, but the tdd skill requires tests for every acceptance criterion. Added `the-intern/email-skills/test_package_pi_skills.sh` as a justified addition beyond the listed files.
- AC-3 has no script-level behavior to drive a genuine red→green cycle (the task itself states tracked status is "unchanged... from today"). Added a regression-guard test instead of forcing an artificial failing step, and documented that choice explicitly rather than silently skipping the TDD procedure for that criterion.
- Regenerating the real `.pi/skills` tree produced a zero-diff result (the previously hand-maintained content already matched what the script now produces byte-for-byte), so there was no separate "fix the drift" commit needed.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->
