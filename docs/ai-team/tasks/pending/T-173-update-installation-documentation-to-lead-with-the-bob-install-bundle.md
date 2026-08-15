---
id: T-173
title: Update installation documentation to lead with the bob install bundle
status: pending
priority: medium
assigned-role: unassigned
created: '2026-08-15'
---

# Update installation documentation to lead with the bob install bundle

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

Implement `docs/ai-team/specs/S-013-cross-platform-bob-install-bundle-release-packaging.md`
Component 5. The bob install-bundle zip (T-172) and `install.sh` (T-170) now exist and are
attached to every release, but the mdBook docs still describe the old manual path: the
quickstart's step 2 uses `curl` + `chmod` + `sudo mv bob /usr/local/bin/bob`, and its step 3
uses `mkdir` + `curl` + `tar -xzf` to place the extension by hand; the operator guide has an
equivalent manual "Install the bob extension" section with the same `cp .../bob.ts ...`
instructions.

Rewrite the quickstart's steps 2–3 to instead: download the install-bundle zip matching your
platform (`the-intern-bob-install-<tag>-linux-x86_64.zip` or `...-macos-arm64.zip`) from the
releases page, unzip it, and run `./install.sh` — removing the `sudo` requirement entirely.
Update the operator guide's manual-install section to present the same path as primary,
keeping the old manual steps only as a documented alternative for source builds where no
release zip exists. Add a short pointer in the extension-author guide noting the install
bundle is now the typical way `bob.ts` reaches its default path, without duplicating the
resolution-order detail that guide already documents correctly.

## Acceptance Criteria

AC-1: THE SYSTEM SHALL present downloading the platform-matching install-bundle zip and
      running `./install.sh` as the primary "get bob running" path in the quickstart,
      replacing the prior `sudo mv` and manual `tar -xzf` steps.
AC-2: THE SYSTEM SHALL update the operator guide's manual binary/extension placement section
      to present the install bundle as the recommended path, retaining the old manual steps
      only as an explicitly labeled alternative for source builds.
AC-3: THE SYSTEM SHALL add a pointer in the extension-author guide noting the install bundle
      as the typical way `bob.ts` reaches its default path.

## Dependencies

- `T-170` — `install.sh`'s actual behavior must be final before documenting it
- `T-172` — the release zip naming convention must be final before documenting it

## Files to Touch

- `the-intern/docs/src/quickstart/index.md` — rewrite steps 2–3
- `the-intern/docs/src/operator-guide/index.md` — update the manual-install section
- `the-intern/docs/src/extension-author-guide/index.md` — add the install-bundle pointer

## Verification

```bash
grep -n "bob-install-.*\.zip" the-intern/docs/src/quickstart/index.md
grep -n "install.sh" the-intern/docs/src/quickstart/index.md the-intern/docs/src/operator-guide/index.md
grep -qv "sudo mv bob" the-intern/docs/src/quickstart/index.md && echo "sudo mv removed from primary path"
```

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
