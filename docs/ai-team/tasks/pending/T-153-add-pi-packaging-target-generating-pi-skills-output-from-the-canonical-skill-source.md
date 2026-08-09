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

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->
