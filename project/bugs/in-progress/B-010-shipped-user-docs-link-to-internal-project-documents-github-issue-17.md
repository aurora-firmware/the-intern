---
id: B-010
title: 'Shipped user docs link to internal project documents (GitHub issue #17)'
severity: medium
status: in-progress
created: '2026-06-14'
---

# Shipped user docs link to internal project documents (GitHub issue #17)

## Summary

The shipped mdBook user documentation links to files under the repository's
internal `project/` development tree. Those files are not included in the
release documentation artifact, so the generated links resolve outside the
book and are broken for users. GitHub issue #17 reports the extension author
guide's "Pointers to ADRs" section, and the same problem also appears in the
architecture overview and operator guide.

## Reproduction Status

Status: confirmed

Confirmed by inspecting the mdBook source on `dev-agent`.

## Evidence

- GitHub issue: https://github.com/aurora-firmware/the-intern/issues/17
- `the-intern/docs/src/extension-author-guide/index.md` links to internal ADR
  files at lines 21, 143, 157, 173, 179, and 185.
- `the-intern/docs/src/architecture-overview/index.md` links to internal
  architecture files at lines 6 and 7.
- `the-intern/docs/src/operator-guide/index.md` links to an internal ADR at
  line 159.
- `rg -n 'project/(decisions|docs)' the-intern/docs/src` lists these links.

## Reproduction Steps

1. Build or open the release mdBook.
2. Open `extension-author-guide/index.html#pointers-to-adrs`.
3. Follow an ADR link and observe that it targets a `project/decisions/` file
   that is not part of the shipped book.

## Expected Behavior

The shipped user documentation is self-contained and does not link to internal
development documents under `project/`. Relevant design context is summarized
in user-facing prose instead.

## Actual Behavior

Several user-documentation pages link directly to `project/decisions/` and
`project/docs/`, producing broken links in the release documentation artifact.

## Environment

- OS / platform: all platforms
- Language / runtime version: mdBook user documentation
- Relevant dependencies: mdBook
- Branch / commit: `dev-agent` at `0c60f8e`

## Related

- GitHub issue: https://github.com/aurora-firmware/the-intern/issues/17

## Suspected Area

User documentation under `the-intern/docs/src/`, especially the extension
author guide, architecture overview, and operator guide. Add a documentation
rule or automated check preventing future links into `project/`.

## Fix Verification

```bash
! rg -n 'project/(decisions|docs)' the-intern/docs/src
mdbook build the-intern/docs
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

### Diagnosis 1 — 2026-06-14

Reproduction status:
Confirmed. Building the user docs from `the-intern/docs` and inspecting the
generated HTML shows shipped links that point outside the mdBook artifact into
`project/` paths that do not exist in the release docs bundle.

Evidence captured:
- `rg -n 'project/' the-intern/docs/src` found source links in the architecture
  overview, operator guide, and extension author guide.
- `cd the-intern/docs && mdbook build --dest-dir /tmp/b010-book` exited `0`.
- `rg -n 'project/(decisions|docs|specs)' /tmp/b010-book` showed the rendered
  shipped links in all three affected chapters.
- Representative rendered targets resolve outside the book and do not exist,
  including `/project/decisions/...`, `/project/docs/...`, and
  `/tmp/project/decisions/...`.
- The original spec and completed documentation tasks explicitly allowed or
  accepted these out-of-book links, so existing verification did not reject
  them.

Isolated fault:
The mdBook source chapters embed repository-relative Markdown links that escape
the docs tree:
- `the-intern/docs/src/architecture-overview/index.md:6-7`
- `the-intern/docs/src/operator-guide/index.md:159`
- `the-intern/docs/src/extension-author-guide/index.md:21,143,157,167,173,179,185`

Root cause or fault hypothesis:
This is a source-authoring and acceptance-criteria bug, not an mdBook rendering
bug. mdBook preserves the escaped relative paths while only shipping the built
book, and no existing verification check rejects out-of-tree links.

Planned fix:
Replace the `project/` links with self-contained prose and/or in-book
cross-links. Add a regression check that fails when `the-intern/docs/src`
contains links into `project/` paths.

Planned verification:
- `! rg -n 'project/(decisions|docs|specs)' the-intern/docs/src`
- `cd the-intern/docs && mdbook build`
- `! rg -n 'project/(decisions|docs|specs)' book`
- Manually inspect the affected rendered pages.

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

### Session 1 — 2026-06-14

Implemented the diagnosed B-010 fix without touching the lifecycle file on the
bug branch. First added `tests/test_user_docs_self_contained.sh` as the
regression check and ran it red; it failed on the existing `project/` links in
source, the rendered book, and the missing workflow guard. Then rewrote the
affected passages in the architecture overview, operator guide, and extension
author guide so the shipped book keeps the design context in prose and in-book
references instead of linking into internal ADR/spec/docs files. Also converted
the extension compatibility file mention to plain code text so that chapter no
longer escapes the shipped book.

Leaving the current links in place and only adding a build-time grep was
rejected because it would preserve broken links in already-shipped content.
Guarding every out-of-tree repository path in CI was also considered, but the
automated check remains scoped to internal project documents to match the
diagnosis contract while still removing the currently broken non-book link from
the author guide. Added a `build.yml` step that rejects
`project/(decisions|docs|specs)` links before the mdBook build, reran the
regression script to green, rebuilt the book, and confirmed the rendered output
no longer contains those internal-project links. No implementation work remains
on this bug branch.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that diagnosis, fix, verification, and code quality passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->

### Review Verdict — 2026-06-14

PASS

Diagnosis Log completeness, isolated-fault alignment, and the planned
verification chain all passed review. The implementation stays within the
diagnosed scope by removing the shipped `project/` links from the three
affected user-doc chapters and adding a practical regression guard in
[`tests/test_user_docs_self_contained.sh`](/home/daneel/projects/the-intern/tests/test_user_docs_self_contained.sh:1)
plus a pre-build CI check in
[`build.yml`](/home/daneel/projects/the-intern/.github/workflows/build.yml:94).

Stage 1 passed: the pre-fix state reproduced the documented source and rendered
book leaks, the fixed branch removes those links from the affected chapters, no
unrelated behavior was added, and the recorded Fix Verification steps hold when
rerun. Stage 2 passed: the regression script covers source, rendered output,
and workflow protection; the documentation edits are readable and minimal; no
security or performance concerns were introduced. Non-blocking observation: the
local `mdbook build` emits an `mdbook-mermaid`/`mdbook` version warning, but it
did not affect this bug fix or its verification results.
