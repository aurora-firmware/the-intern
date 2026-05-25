---
id: T-077
title: Scaffold mdBook documentation project under the-intern/docs
status: pending
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
