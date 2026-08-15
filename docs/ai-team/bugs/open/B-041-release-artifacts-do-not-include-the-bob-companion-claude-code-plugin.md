---
id: B-041
title: Release artifacts do not include the bob-companion Claude Code plugin
severity: medium
status: open
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
