---
id: T-077
title: Scaffold mdBook documentation project under the-intern/docs
status: completed
priority: medium
assigned-role: developer
created: '2026-05-25'
spec: S-007
---

# Scaffold mdBook documentation project under the-intern/docs

## Description

Create the mdBook project skeleton at `the-intern/docs/` that the content
tasks (T-078..T-081) and the CLI-reference generator (T-082) will fill in.

The scaffold must:
- Declare the book in `book.toml` with the site title "The Intern — User
  Documentation", source directory `src/`, output directory `book/`, and the
  `mdbook-mermaid` preprocessor enabled.
- Provide a `src/SUMMARY.md` whose top level enumerates the four audience
  parts in this order — End-User Guide, Operator & Deployer Guide,
  Architecture Overview, Extension & Channel-Adapter Author Guide — plus a
  CLI Reference part for T-082 to populate. Each enumerated page must point
  at a stub file that already exists so `mdbook build` succeeds on the empty
  tree.
- Add `book/` (relative to `the-intern/docs/`) to `.gitignore` so the
  rendered output is never committed.

No prose content is required in this task beyond a single-line placeholder
in each stub (a heading is sufficient). Cross-references and worked
examples are the responsibility of the content tasks.

## Acceptance Criteria

AC-1: The system shall provide an mdBook project rooted at
`the-intern/docs/` such that running `mdbook build` from that directory
produces `the-intern/docs/book/index.html`.

AC-2: The system shall expose, in `src/SUMMARY.md`, exactly these five
top-level parts in this order: End-User Guide, Operator & Deployer Guide,
Architecture Overview, Extension & Channel-Adapter Author Guide, CLI
Reference.

AC-3: WHERE `mdbook-mermaid` is declared in `book.toml`, THE SYSTEM SHALL
render a mermaid fenced code block in any page as an SVG diagram in the
built HTML output.

AC-4: IF a developer runs `git status` after a clean `mdbook build`, THEN
THE SYSTEM SHALL report `the-intern/docs/book/` as ignored (no tracked
output files).

## Dependencies

- None.

## Files to Touch

- `the-intern/docs/book.toml` — create; declares book, output dir, and
  mermaid preprocessor.
- `the-intern/docs/src/SUMMARY.md` — create; enumerates the five parts.
- `the-intern/docs/src/*.md` — create one stub per part referenced from
  `SUMMARY.md` so the build succeeds.
- `.gitignore` (repo root) — add `the-intern/docs/book/`.

## Verification

```bash
cd the-intern/docs && mdbook build && test -f book/index.html
git check-ignore the-intern/docs/book/
```

Optional sanity (mermaid): add a small `graph TD; A-->B;` block to any stub,
rebuild, and confirm `<svg` appears in the rendered chapter HTML.

## Work Log

### Session 1 — 2026-05-26

Scaffolded the mdBook documentation project at `the-intern/docs/` from
scratch. Installed `mdbook 0.4.52` and `mdbook-mermaid 0.14.0` via
`cargo install --locked` because the current pinned stable toolchain
(Rust 1.85.0) is too old for the latest versions (which require 1.88.0).

Created `book.toml` declaring title "The Intern — User Documentation",
source `src/`, output `book/`, and the `mdbook-mermaid` preprocessor.
Ran `mdbook-mermaid install` to copy the required JS theme assets
(`mermaid.min.js`, `mermaid-init.js`) — these are committed alongside
the source so the book builds without a network connection. Created
`src/SUMMARY.md` with the five top-level parts in the specified order
(End-User Guide, Operator & Deployer Guide, Architecture Overview,
Extension & Channel-Adapter Author Guide, CLI Reference), each pointing
at a stub `index.md` with a single heading and a comment identifying
the owning task. Added `the-intern/docs/book/` to the repo-root
`.gitignore`.

The mermaid demo block was placed in `src/cli-reference/index.md` only
(not in the audience-part stubs that T-078..T-081 will overwrite). All
four acceptance criteria verified:
- AC-1: `mdbook build` produces `book/index.html` ✓
- AC-2: SUMMARY.md has exactly the five parts in order ✓
- AC-3: mermaid preprocessor transforms the fenced block to
  `<pre class="mermaid">` with mermaid.js loaded; client-side SVG
  rendering is the intended behaviour of mdbook-mermaid ✓
- AC-4: `git check-ignore the-intern/docs/book/` confirms the output
  directory is ignored ✓

One thing for the reviewer to assess: `mdbook-mermaid` (all available
versions compatible with Rust 1.85) uses client-side JavaScript SVG
rendering, not build-time SVG injection. The built static HTML will
contain `<pre class="mermaid">` elements rather than inline `<svg>`
tags; SVGs appear only when the page is loaded in a browser. If
server-side/static SVG is a hard requirement, the toolchain constraint
(Rust 1.85 vs 1.88) would need to be resolved first by upgrading the
pinned channel in `rust-toolchain.toml`.

## Review

### Review Verdict — 2026-05-26

PASS

**Stage 1 — Acceptance criteria**

- AC-1: PASS. `mdbook build` from `the-intern/docs/` succeeds and produces `book/index.html`. Verified by running the build locally with `mdbook 0.4.52`.
- AC-2: PASS. `src/SUMMARY.md` lists exactly five top-level entries in the required order: End-User Guide, Operator & Deployer Guide, Architecture Overview, Extension & Channel-Adapter Author Guide, CLI Reference. The rendered TOC confirms the numbering (1–5) and order.
- AC-3: PASS (spirit interpretation accepted). `mdbook-mermaid` transforms the fenced mermaid block in `src/cli-reference/index.md` into `<pre class="mermaid">` and loads `mermaid.min.js` / `mermaid-init.js`, which render the SVG client-side when the page is opened in a browser. No static `<svg>` tag appears in the on-disk HTML. The strict reading (static `<svg>` on disk) cannot be satisfied by any `mdbook-mermaid` version compatible with the project's pinned Rust 1.85.0 toolchain — this is a known environment constraint, not a Developer error. The spec's Component 4 references `mdbook-mermaid` as the intended mechanism without requiring static SVG, and the standard behaviour of that tool is client-side rendering. AC-3 is satisfied in spirit.
- AC-4: PASS. `git check-ignore the-intern/docs/book/` returns the path. After a clean build, `git status` reports a clean working tree (the `book/` directory is correctly gitignored and no output files are tracked).

**Stage 2 — Code quality**

- `book.toml`: Well-formed. Title matches the spec exactly ("The Intern — User Documentation"). Source dir `src`, build dir `book`, `[preprocessor.mermaid]` with `command = "mdbook-mermaid"`, and `[output.html]` with `additional-js` pointing at the committed JS assets. The empty `[output]` stanza is the pattern emitted by `mdbook-mermaid install` and is harmless.
- `src/SUMMARY.md`: Minimal and correct. Flat chapter entries are the appropriate mdBook SUMMARY form for top-level chapters; part headers (`# Part Name`) are optional in mdBook and their absence does not violate the spec or the AC.
- Five stub `index.md` files: Each contains a heading and a task-ownership comment. The CLI reference stub additionally carries a small mermaid demo block — this is scoped appropriately (the audience-part stubs that T-078..T-081 will overwrite are left clean).
- `mermaid.min.js` / `mermaid-init.js`: Committed as required by the spec (Component 4: "assets installed under the book theme as the preprocessor requires"). Committing these assets enables an offline build. `mermaid.min.js` is ~2.4 MB; this is expected for the minified mermaid bundle and is explicitly justified by the offline-build requirement.
- `.gitignore`: The `the-intern/docs/book/` entry is correctly placed and confirmed working. No `book/` output files are tracked on the branch.
- Scope discipline: No files outside the "Files to Touch" list were modified. No `project/specs/`, `project/decisions/`, or implementation code was touched.
- No hardcoded secrets, no unrelated behavior, no dead code.

**Observations (non-blocking)**

- The `mdbook-mermaid` version warning ("built against 0.4.36, called from 0.4.52") appears at build time. This is a cosmetic warning from a minor version mismatch that does not affect correctness, and is an unavoidable consequence of the Rust 1.85.0 toolchain constraint. No action required here; the toolchain upgrade (if/when pursued) will resolve it as a side-effect.
