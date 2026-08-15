---
id: B-041
title: Release artifacts do not include the bob-companion Claude Code plugin
severity: medium
status: in-progress
created: '2026-08-15'
---

# Release artifacts do not include the bob-companion Claude Code plugin

## Summary

The tag-triggered release workflow (`.github/workflows/deploy.yml`) attaches
three artifacts to every GitHub Release: the `bob` binary, the rendered
mdBook docs archive, and the `bob.ts` pi-agent extension archive. It does
not package `the-intern/bob-companion/claude` — the Claude Code plugin that
teaches Claude how to drive `bob` correctly. Today the only way to get the
plugin is a full source checkout plus `/plugin install
the-intern/bob-companion/claude` from a Claude Code session with repository
access; there is no standalone downloadable artifact, unlike the docs and
the extension, which both ship this way specifically so a user doesn't need
a full source checkout.

## Reproduction Status

Status: confirmed

Evidence-backed status notes. Confirmed by reading `.github/workflows/deploy.yml`
in full and enumerating its `files:` list under the "Create GitHub Release"
step, plus a repo search for any other workflow or script that packages
`bob-companion`.

## Evidence

- Logs / stack traces / failing assertions: n/a (missing packaging step, not a runtime failure)
- Screenshots or recordings: n/a
- Failing command or test: `grep -n "bob-companion" .github/workflows/deploy.yml` returns no results
- First diagnostic step if not yet reproduced: n/a — already reproduced above

## Reproduction Steps

1. Read `.github/workflows/deploy.yml` — the "Archive docs" and "Archive bob
   extension" steps package `the-intern/docs` (via `mdbook build`) and
   `the-intern/pi-extension` respectively; there is no equivalent step for
   `the-intern/bob-companion/claude`.
2. Check the `files:` list passed to `softprops/action-gh-release@v2`: only
   `${{ env.SERVICE_DIR }}/target/release/bob`,
   `the-intern-docs-${{ github.ref_name }}.tar.gz`, and
   `the-intern-bob-extension-${{ github.ref_name }}.tar.gz` are attached.
3. `grep -rn "bob-companion" .github/workflows/` — zero matches anywhere in
   the workflows directory.

## Expected Behavior

Every tagged release should also attach a downloadable archive of
`the-intern/bob-companion/claude` (the `.claude-plugin/plugin.json`,
`README.md`, and `skills/` tree), following the same tar-and-attach pattern
already used for the docs and extension archives, so the plugin can be
installed from a release download the same way the extension and docs
already can — without a full source checkout.

## Actual Behavior

`bob-companion/claude` is entirely absent from `deploy.yml` and from every
GitHub Release's asset list.

## Environment

- OS / platform: n/a (CI workflow / release packaging)
- Language / runtime version: n/a
- Relevant dependencies: n/a
- Branch / commit: dev-agent @ 997de6c

## Related

- Task: none (no prior task introduced `bob-companion`'s release packaging — it was never added)
- Specification: none — S-007 governs the docs archive addition to `deploy.yml` and S-010 explicitly excludes `bob-companion` from its own scope ("This package ships separately"); no spec currently owns bob-companion's release packaging.

## Suspected Area

`.github/workflows/deploy.yml`.

## Fix Verification

```bash
grep -n "bob-companion" .github/workflows/deploy.yml

# Local smoke test mirroring the new CI archive step (does not require a tag push):
tar -czf /tmp/the-intern-bob-companion-smoke.tar.gz -C the-intern/bob-companion claude
tar -tzf /tmp/the-intern-bob-companion-smoke.tar.gz | grep -q "claude/.claude-plugin/plugin.json"
tar -tzf /tmp/the-intern-bob-companion-smoke.tar.gz | grep -q "claude/README.md"
tar -tzf /tmp/the-intern-bob-companion-smoke.tar.gz | grep -q "claude/skills/bob-setup/SKILL.md"
```

## Diagnosis Log

<!-- Mandatory before implementation. Append one entry before changing production code. Format:
### Diagnosis N — YYYY-MM-DD
Reproduction status:
Evidence captured:
Isolated fault:
Root cause or fault hypothesis:
Planned verification:
-->

### Diagnosis 1 — 2026-08-15

Reproduction status: Confirmed. `.github/workflows/deploy.yml` was read in full
(78 lines) and contains no reference to `bob-companion` anywhere.

Evidence captured:
- `grep -n "bob-companion" .github/workflows/deploy.yml` -> no output, exit 1.
- `grep -rn "bob-companion" .github/workflows/` -> no output, exit 1 (zero
  matches in the entire workflows directory).
- Full read of `.github/workflows/deploy.yml`: the `files:` list passed to
  `softprops/action-gh-release@v2` (lines 74-77) contains exactly three
  entries — `${{ env.SERVICE_DIR }}/target/release/bob`,
  `the-intern-docs-${{ github.ref_name }}.tar.gz`, and
  `the-intern-bob-extension-${{ github.ref_name }}.tar.gz` — produced by the
  "Archive docs" (lines 58-61: `tar -czf the-intern-docs-<tag>.tar.gz -C
  ${{ env.DOCS_DIR }} book`) and "Archive bob extension" (lines 63-67:
  `tar -czf the-intern-bob-extension-<tag>.tar.gz -C
  ${{ env.EXTENSIONS_DIR }} bob.ts README.md package.json
  package-lock.json`) steps. No equivalent step exists for
  `the-intern/bob-companion/claude`.
- `find the-intern/bob-companion/claude -maxdepth 3 -type f`: confirms the
  plugin's real shape — `.claude-plugin/plugin.json`, `README.md`, and four
  `skills/*/SKILL.md` files (plus two `references/` subfiles).
- Local smoke test mirroring the "Archive docs" subdirectory-tar pattern:
  `tar -czf <scratch>/the-intern-bob-companion-smoke.tar.gz -C
  the-intern/bob-companion claude` followed by `tar -tzf ...` — produced a
  correctly rooted archive (`claude/.claude-plugin/plugin.json`,
  `claude/README.md`, `claude/skills/bob-setup/SKILL.md`, etc.); all three
  Fix Verification grep checks from the bug file passed.
- Spec cross-check: `docs/ai-team/specs/S-010-...md` lines 46-50 explicitly
  exclude `the-intern/bob-companion/claude` from its own scope ("This
  package ships separately"). `docs/ai-team/specs/S-007-...md` Component 5
  (lines 172-187) is the precedent that added the "Archive docs" step and
  its `files:` entry to `deploy.yml` for exactly this kind of standalone
  release asset — it is the pattern to mirror, and no spec currently owns
  bob-companion's release packaging (matches the bug's "Related" claim).
- `git status --short` / `git diff --stat` after all diagnostic commands:
  empty — no production code or lifecycle files were modified during
  diagnosis.

Isolated fault: `.github/workflows/deploy.yml`, "Create GitHub Release" step
(lines 69-77) and the absence of any archive step for
`the-intern/bob-companion/claude` between the existing "Archive bob
extension" step (lines 63-67) and the "Create GitHub Release" step. There is
no bug in application/service code — this is a missing CI packaging step.

Root cause: `deploy.yml` was extended twice (per S-007 for docs, and an
earlier ad hoc addition for the pi-extension) to attach standalone release
archives, but no task or spec ever added an equivalent step for
`the-intern/bob-companion/claude` — S-010 explicitly disclaimed ownership of
it ("ships separately") without any other spec picking it up, so the
packaging step was simply never written. This is a genuine gap, not a
regression from a recent change.

Planned fix (concrete shape, mirroring "Archive docs" — a whole-subdirectory
tar via `-C <parent> <subdir>`, the closer pattern match since
`bob-companion/claude` is a subdirectory like `book` under `DOCS_DIR`, not a
flat file list like `EXTENSIONS_DIR`):
1. Add a new env var alongside `DOCS_DIR`/`EXTENSIONS_DIR`:
   `BOB_COMPANION_DIR: the-intern/bob-companion`.
2. Add a new step "Archive bob-companion plugin" immediately after "Archive
   bob extension" (before "Create GitHub Release"):
   ```yaml
   - name: Archive bob-companion plugin
     run: |
       tar -czf the-intern-bob-companion-claude-${{ github.ref_name }}.tar.gz \
         -C ${{ env.BOB_COMPANION_DIR }} \
         claude
   ```
   Asset filename convention: `the-intern-bob-companion-claude-<tag>.tar.gz`
   — follows the existing `the-intern-<thing>-<tag>.tar.gz` pattern, and
   `-claude` names the specific companion flavor packaged (the tar'd
   subdirectory), leaving room for a sibling companion target later without
   an asset-name collision.
3. Add `the-intern-bob-companion-claude-${{ github.ref_name }}.tar.gz` as a
   fourth line in the `files:` block of the existing "Create GitHub Release"
   step (lines 74-77), after the bob-extension entry.

No other files need to change; this is additive-only to `deploy.yml`.

Planned verification:
- `grep -n "bob-companion" .github/workflows/deploy.yml` returns matches
  (the fix-verification command from the bug file).
- The bug's existing local smoke test block (tar -czf ... -C
  the-intern/bob-companion claude; tar -tzf checks for plugin.json,
  README.md, bob-setup/SKILL.md) already passed against the real tree in
  this diagnosis session, confirming the tar invocation shape is correct
  independent of CI.
- Manual review of the new `files:` block confirms four entries (binary,
  docs, bob-extension, bob-companion-claude), each produced by a preceding
  archive step, matching the existing three-entry pattern exactly.
- No workspace test suite coverage applies (this is a GitHub Actions YAML
  change with no unit tests); verification is grep + local tar smoke test +
  manual structural review of the workflow diff, consistent with how S-007's
  Component 5 addition was itself verified.

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
- For PASS: brief confirmation that diagnosis, fix, verification, and code quality passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->
