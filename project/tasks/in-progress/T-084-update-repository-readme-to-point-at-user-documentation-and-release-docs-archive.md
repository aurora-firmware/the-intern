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

### Session 1 — 2026-05-28

Implemented T-084 in a single TDD cycle. The Work Log was empty on
pickup (first session).

Wrote a failing test script (`tests/test_readme_docs_pointers.sh`)
with four independent checks covering all acceptance criteria before
touching the README. Confirmed all four tests failed, then added a new
"User documentation" section to `README.md` immediately before the
existing "Where to read more" section.

The new section:
- Names `the-intern/docs/` as the user-facing manual and distinguishes
  it from `project/docs/` (internal lifecycle material, not shipped).
- Documents the two-step local build:
  `cargo install mdbook mdbook-mermaid` followed by `mdbook build`
  from inside `the-intern/docs/`.
- Documents the `BOB_BIN` env var and the two fallback paths
  (`target/release/bob`, `target/debug/bob`), noting the build fails
  loudly when none is found.
- States that every GitHub Release attaches a rendered documentation
  archive as a release asset and includes a link to the Releases page.

As a minor refactor within the same file, the repository structure
listing was updated to include `the-intern/docs/` — it was already
there on disk (from T-077) but absent from the listing, which was
misleading.

The existing "Where to read more" section and all its links to
`project/docs/` were left untouched.

All five task verification `grep` commands pass. All four new tests
pass.

## Review

### Review Verdict — 2026-05-28

PASS

**Stage 1 — Spec compliance**

- AC-1: Met. README.md contains a dedicated "User documentation" section that names `the-intern/docs/` as the user-facing manual and includes an explicit `the-intern/docs/ vs project/docs/` contrast paragraph. The existing "Where to read more" section and all its `project/docs/` links are untouched.
- AC-2: Met. `cargo install mdbook mdbook-mermaid` and `mdbook build` are both present as a code block, satisfying the single-command build and the named dependency requirement.
- AC-3: Met. "Every GitHub Release attaches a rendered documentation archive as a release asset" is present verbatim, and a Markdown link to `https://github.com/jose-moreno/the-intern/releases` follows immediately.
- AC-4: Met. `BOB_BIN` is named and both fallback paths (`target/release/bob`, `target/debug/bob`) are enumerated with priority order; the loud-failure note is included.

All five task verification `grep` commands confirmed passing.

Out-of-scope files noted and evaluated:
- `tests/test_readme_docs_pointers.sh` — not listed in Files to Touch. Justified: the Developer wrote the test before touching the README (TDD), and the script tests exactly the four acceptance criteria. Adding test coverage does not introduce unspecified behavior and the Work Log documents the rationale. No objection.
- Repository structure listing update inside `README.md` — a two-line change that corrects an already-wrong listing (the `docs/` directory existed on disk from T-077 but was missing from the listing). Within scope of touching `README.md`; corrects a factual inaccuracy rather than adding new content. No objection.

**Stage 2 — Code quality**

- Correctness: Each `grep` check in the test script uses `|| ok=1` to accumulate failures without aborting early; `set -euo pipefail` applies to the outer script but each function is self-contained. Logic is correct.
- Tests: Four independent test functions, one per AC, covering all success paths. The test functions capture grep exit codes rather than relying on side effects; there is no shared mutable state between them. A failure path (all-fail initial run) was confirmed before writing the README, per the Work Log.
- Security: No credentials, no external input, no queries.
- Readability: Function names are descriptive and map 1:1 to acceptance criteria. The `run_test` helper is focused. No dead code.
- Performance: No loops over large data, no blocking calls.
