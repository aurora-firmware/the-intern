---
id: T-084
title: Update repository README to point at user documentation and release docs
  archive
status: pending
priority: low
assigned-role: developer
created: '2026-05-25'
spec: S-007
---

# Update repository README to point at user documentation and release docs archive

## Description

Make the new user-facing documentation discoverable from the repository
README and clarify the split from the existing development-lifecycle
material under `project/docs/`.

Add or amend a short section in `README.md` that:
- Names `the-intern/docs/` as the location of the user manual.
- Describes how to build it locally — one command from inside
  `the-intern/docs/`, after installing `mdbook` and `mdbook-mermaid` via
  `cargo install`.
- States that the CLI reference is generated from the live `bob` binary
  at build time, names the `BOB_BIN` env var and the fallback paths
  introduced by T-082, and notes that the build fails loudly when no
  `bob` is available.
- States that every GitHub Release ships a rendered docs archive as a
  release asset (added by T-083), with a one-line pointer to the
  Releases page.
- Distinguishes `the-intern/docs/` (user manual, shipped) from
  `project/docs/` (internal development-lifecycle material, not shipped).

Do not relocate or rewrite the existing "Where to read more" section's
links to `project/docs/`; just amend the README so the user manual is
clearly the first stop for users.

## Acceptance Criteria

AC-1: The system shall include in `README.md` a section that points at
`the-intern/docs/` as the user manual and that distinguishes it from
`project/docs/`.

AC-2: The system shall document in `README.md` how to build the docs
locally with a single command, naming `mdbook` and `mdbook-mermaid` as
the required `cargo install` dependencies.

AC-3: The system shall mention in `README.md` that every GitHub Release
attaches a docs archive as an asset, with a link to the Releases page.

AC-4: The system shall name `BOB_BIN` and its documented fallback in
`README.md` so a first-time docs builder knows what to set.

## Dependencies

- `T-077` — the docs path being advertised must exist.
- `T-082` — the `BOB_BIN` contract referenced in the README is owned by
  this task.
- `T-083` — the release-asset claim in the README depends on the
  workflow change.

## Files to Touch

- `README.md` — add/amend a user-documentation section.

## Verification

```bash
grep -q "the-intern/docs" README.md
grep -q "mdbook" README.md
grep -q "BOB_BIN" README.md
grep -qi "release" README.md
grep -qi "docs archive\|documentation archive" README.md
```

## Work Log

## Review
