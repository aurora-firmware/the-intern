---
title: User-facing documentation site (mdBook)
version: '0.1'
status: approved  # draft | review | approved | superseded
created: '2026-05-25'
author: planner
id: S-007
---

# User-facing documentation site (mdBook)

## Purpose

The first version of the-intern has been released, but everything currently
written about it lives either in source-level `cargo doc` output, in the
README, or in `project/docs/` — material aimed at people building the system,
not at people using it. Operators trying to install and run `bob`, end users
driving it through the CLI, architecture readers who want a conceptual
understanding without reading Rust, and authors writing channel adapters or
JS extensions have no single, navigable, user-facing manual today.

This spec introduces an mdBook-based user documentation site that, when
complete, gives each of those four audiences a coherent reading path,
produces a self-contained static HTML site by running a single build command
locally, and stays accurate over time by deriving the CLI reference from the
actual `bob` binary at build time. On every tagged release, the same build
runs in GitHub CI and the rendered site is attached to the GitHub Release as
a downloadable asset alongside the `bob` binary, so each release ships with
the documentation that matches its build.

## Exclusions

What this specification explicitly does NOT cover:

- **PDF or epub output.** Only HTML is produced. Print/offline formats are
  out of scope; the user confirmed HTML is sufficient for v1.
- **Live hosted site.** No GitHub Pages workflow, Read the Docs
  configuration, or other always-on hosted site. The docs are consumed
  either by running the local build or by downloading the archive attached
  to a GitHub Release (see Implementation Order). Building the book in CI
  and attaching it to releases **is** in scope; serving it from a URL is not.
- **Internationalization.** English only. No translation infrastructure.
- **Multi-version docs.** Single-version site with no version selector.
  Local-only hosting makes a version dropdown meaningless in v1.
- **Migration of `project/docs/`.** The existing development-lifecycle
  material (`system_overview.md`, `the-intern-architecture.md`, `roadmap.md`,
  coding guidelines, ADRs, specs) stays where it is. The book may link to
  selected pieces but does not absorb or replace them.
- **Doc-tests beyond mdBook's defaults.** No new test infrastructure is added
  to verify code samples; mdBook's built-in Rust code-block handling is the
  ceiling.
- **Documentation tooling alternatives.** Material for MkDocs, Docusaurus,
  VitePress, and Starlight were considered during brainstorm. They were
  rejected because the user's "stay in Rust toolchain" constraint excludes
  Node/Python runtimes, and (separately) Material for MkDocs has been in
  maintenance mode since November 2025.

## Architecture

### Design Principles

- **One toolchain.** Building the docs must not require any runtime beyond
  the existing Rust toolchain. New tooling must install via `cargo install`.
- **Single-command build.** A reader who has cloned the repo and built `bob`
  must be able to produce the entire HTML site with one invocation, from
  inside `the-intern/docs/`.
- **Audience-first structure.** The top-level table of contents is organized
  by reader role, not by internal module layout. A reader self-selects their
  part and finds everything for their role under it.
- **Reference accuracy by construction.** The CLI reference must be derived
  from the live `bob` binary at build time so it cannot silently drift from
  the implementation. Hand-written user-guide pages live alongside the
  generated reference and explain *when and why* to use commands, not just
  *what* they accept.
- **Source repo, build artefact out.** All markdown sources are committed
  under `the-intern/docs/src/`. The generated `book/` output directory is not
  committed; it is reproducible from sources.
- **No silent failure of generated content.** If the prerequisite for
  generating the CLI reference is missing (no `bob` binary on the expected
  path), the build must fail loudly with a clear remediation message rather
  than ship an empty or stale reference.

### System Diagram

```
                +-----------------------------+
                |   the-intern/docs/src/      |
                |   (hand-written markdown,   |
                |    SUMMARY.md, assets)      |
                +--------------+--------------+
                               |
                               |  read by
                               v
   +-----------+      +--------+---------+      +-------------------+
   |  bob      |----->|  mdbook build    |<-----| mdbook-mermaid    |
   |  binary   | help |  (with preproc.) |      | preprocessor      |
   +-----------+ feed +--------+---------+      +-------------------+
        ^                      |
        |                      |  emits
        |                      v
        |             +--------+---------+
        |             |  the-intern/     |
        |             |  docs/book/      |
        |             |  (static HTML,   |
        |             |  gitignored)     |
        |             +------------------+
        |
        | (CLI-reference preprocessor invokes `bob <cmd> --help`
        |  at build time and inlines the captured help text into
        |  the reference chapter)
        +----------------------------------------------------------+
```

### Responsibility Separation

| Component | Responsibility | Notes |
|---|---|---|
| Docs sources (`the-intern/docs/src/`) | Hand-written markdown for all four audience parts, plus `SUMMARY.md` defining the table of contents and any static assets (images, diagrams as code). | Committed to the repository. |
| Book configuration (`the-intern/docs/book.toml`) | Declares the site title, source/output paths, theme settings, enabled preprocessors (mermaid, CLI-reference generator) and their order. | Committed. Concrete schema is mdBook's; structure is decided in task breakdown. |
| CLI-reference preprocessor | At build time, invokes the local `bob` binary to capture `--help` output for `bob` and every subcommand, formats it into the reference pages of the CLI part, and inserts it into the rendered book. Fails the build with a clear error if `bob` is not available. | New component, lives in-repo under `the-intern/docs/`. Implementation form (mdBook preprocessor binary vs. pre-build script that writes generated markdown) is a task-level decision. |
| Mermaid preprocessor (`mdbook-mermaid`) | Renders mermaid-fenced diagrams in the Architecture and Extension parts. | Off-the-shelf; installed via `cargo install`. |
| Build output (`the-intern/docs/book/`) | The rendered static HTML site, self-contained and viewable by opening `index.html` directly. | Gitignored. |
| Build entry point | The contract that a reader runs from `the-intern/docs/` to produce the site. Must be a single command. | Concrete command name decided in task breakdown; the contract is single-command and Rust-only. |
| Release workflow integration | Extends `.github/workflows/deploy.yml` so each tagged release builds the book in CI and attaches an archive of the rendered HTML to the GitHub Release alongside the `bob` binary. | Reuses the existing `bob` build step in the same job so the CLI reference is generated against the binary that ships in the release. |

## Components

### Component 1: Book scaffold and configuration

**Purpose:** Establish the mdBook project under `the-intern/docs/`, with
`book.toml`, `src/SUMMARY.md`, the four top-level parts, and theme/preprocessor
configuration. Ensures `mdbook build` succeeds on an empty content tree.
**Estimated size:** Small.
**Interfaces:** Consumes mdBook + `mdbook-mermaid`. Exposes the
`the-intern/docs/` project root and the `book/` output path. `.gitignore` for
the output directory is part of this component.

### Component 2: Audience parts (hand-written content)

**Purpose:** Provide the narrative content for the four audience parts —
End-user guide for the `bob` CLI (with worked examples per command),
Operator/deployer guide (installation, runtime layout, sockets, configuration,
audit log, policy basics, shutdown), Architecture overview for
non-implementers (system shape, request lifecycle, supervision, channel
adapters, policy gate, monitoring), and Extension & channel-adapter author
guide (JS extension protocol, channel-adapter contract, pi-agent
compatibility, public surfaces).
**Estimated size:** Large; the content itself is the bulk of the work.
**Interfaces:** Pure markdown under `the-intern/docs/src/`. May link out to
`project/docs/` for deep dives, but must not require those links to be
followed to make sense.

### Component 3: CLI reference generator

**Purpose:** Capture `bob <command> --help` output for every CLI subcommand
at build time and produce the per-subcommand reference pages in the CLI part.
Fails the build with an actionable error when `bob` cannot be located.
**Estimated size:** Medium.
**Interfaces:** Consumes the local `bob` binary (path discovery rules decided
in task breakdown). Produces markdown that mdBook renders. Integrates with
the single-command build so the reader does not run a separate step.

### Component 4: Diagrams via mermaid

**Purpose:** Enable mermaid-fenced diagrams across the Architecture and
Extension parts so flow/sequence/state diagrams can live as text in the
sources.
**Estimated size:** Small.
**Interfaces:** `mdbook-mermaid` preprocessor wired into `book.toml`; assets
installed under the book theme as the preprocessor requires.

### Component 5: Release workflow integration

**Purpose:** Extend the existing tag-triggered release workflow
(`.github/workflows/deploy.yml`) so that, on every tag push, the same job
that builds `bob` also installs the docs toolchain (`mdbook`,
`mdbook-mermaid`), runs the single-command book build against the freshly
built `bob` binary, archives `the-intern/docs/book/` into a single artefact,
and includes that artefact in the `files:` list of the GitHub Release
created by `softprops/action-gh-release`. The archive must be
self-contained: extracting it and opening `index.html` works offline. Build
failures in this step must fail the release job (no partial releases that
ship a binary without docs, or vice versa).
**Estimated size:** Small.
**Interfaces:** Edits `.github/workflows/deploy.yml`. Consumes the
already-built `bob` binary from the prior step in the same job. Produces a
release asset whose naming convention is decided in task breakdown (the
contract is: one archive per release, name includes the tag).

### Component 6: Discoverability glue

**Purpose:** Make the new docs site discoverable without confusing it with
the development-lifecycle docs. Update the repository README to point at
`the-intern/docs/` with a one-line description and the single build command,
and to mention that each GitHub Release ships a docs archive as an asset.
Clarify in the README that `project/docs/` remains development material and
`the-intern/docs/` is the user manual.
**Estimated size:** Small.
**Interfaces:** Edits to the existing `README.md` only; no new top-level
files.

## Workflow

End-to-end author and reader flows:

```
Author flow
-----------
Write/edit markdown in the-intern/docs/src/
  ↓
Run the single-command build from the-intern/docs/
  ↓
Preprocessors run:
  - CLI-reference generator captures `bob <cmd> --help`
  - mdbook-mermaid renders diagrams
  ↓
HTML emitted to the-intern/docs/book/ (gitignored)
  ↓
Open book/index.html locally to review

Reader flow
-----------
Clone repo and build bob (existing project setup)
  ↓
Run the single-command build under the-intern/docs/
  ↓
Open book/index.html
  ↓
Pick audience part (User / Operator / Architecture / Extension author)
  ↓
Follow audience-specific reading path; CLI reference pages reflect
the bob binary that was on PATH at build time
```

There are no human gates inside the build itself. Gate 1 (spec approval)
and the normal task review gates apply to the work that produces the book.

## Configuration Requirements

- **`bob` binary discoverability at build time.**
  - *What:* The CLI-reference generator must locate a runnable `bob` binary
    when the docs build runs.
  - *Why:* The reference is generated from `--help` output; without `bob` the
    reference cannot be produced.
  - *Where:* Discovery rule is decided in task breakdown (likely a documented
    environment variable plus a sensible default such as the workspace
    `target/` path). Whatever the rule, it must be documented in the
    Operator/deployer part.
  - *Constraints:* Must accept either a debug or release build. Must not
    require a system-wide install.
  - *Default behavior when missing:* Build fails with a clear error message
    that names the variable / expected path and explains how to satisfy it.
    The build must not silently skip or stub the reference.

- **Output directory.**
  - *Contract:* Generated HTML lives under `the-intern/docs/book/` and is
    excluded from version control via `.gitignore`. This path is part of the
    repository contract because tooling and documentation reference it.

- **Toolchain dependencies.**
  - *What:* `mdbook` and `mdbook-mermaid` must be installable via
    `cargo install`. No Node, Python, or other runtime is permitted.
  - *Why:* Matches the project's stated constraint of staying Rust-only.
  - *Default behavior when missing:* Installation instructions appear in the
    Operator part and in a short note in the repository README. The build
    command itself is allowed to fail with mdBook's native error when the
    tool is absent.

- **CI runner requirements.**
  - *What:* The self-hosted runner used by `deploy.yml` must be able to run
    the docs build — i.e. it must have `cargo` available (already required
    by the existing release job) and either pre-installed `mdbook` and
    `mdbook-mermaid` binaries or sufficient network access to install them
    during the job.
  - *Why:* The CI step that attaches the docs archive to the release runs
    on the same runner that already builds `bob`. The docs build must
    succeed there for releases to ship.
  - *Default behavior when missing:* The release job fails fast with the
    same clear error contract used by the local build. No partial release
    is created; the tag may be re-run after the runner is fixed.

- **Release asset contract.**
  - *Contract:* On every tag push handled by `deploy.yml`, the resulting
    GitHub Release must include exactly one docs archive whose contents,
    when extracted, expose an `index.html` that opens the rendered book.
    The archive is produced from the same build that generated the CLI
    reference against the `bob` binary attached to that same release.

## Implementation Order

| Phase | What | Depends On |
|---|---|---|
| 1 | Scaffold the mdBook project under `the-intern/docs/`: `book.toml`, empty `SUMMARY.md` with the four parts, `.gitignore` for `book/`, `mdbook-mermaid` wired in. `mdbook build` succeeds on the empty tree. | Nothing |
| 2 | Hand-written content for the four audience parts (User CLI guide with examples, Operator/deployer guide, Architecture overview, Extension/channel-adapter author guide). Cross-links between parts where natural; outward links to `project/docs/` where deep dives exist. | Phase 1 |
| 3 | CLI-reference generator integrated into the single-command build, with the failure-mode contract from Configuration Requirements. CLI reference pages populated from the live `bob` binary. | Phase 1; usable in parallel with Phase 2 but reference pages depend on it |
| 4 | Release workflow integration: extend `.github/workflows/deploy.yml` to install the docs toolchain, run the single-command build against the just-built `bob`, archive `the-intern/docs/book/`, and add the archive to the `files:` of the existing `softprops/action-gh-release` step. Release job fails if the docs build fails. | Phases 1 and 3 |
| 5 | Discoverability glue: README update pointing at `the-intern/docs/`, clarifying the split from `project/docs/`, and noting that each GitHub Release ships a docs archive. | Phase 1 (content) and Phase 4 (release-asset claim) |

## Amendment Log

| Date | What changed | Why | Affected tasks |
|------|-------------|-----|----------------|
| 2026-05-25 | Added CI integration: docs built in `deploy.yml` on tagged releases and attached as a release asset alongside the `bob` binary. Narrowed the "no hosted deployment" exclusion to "no live hosted site"; added Component 5 (release workflow integration), CI runner and release-asset configuration requirements, and Phase 4 in the implementation order. | Human requested that each GitHub Release ship the rendered docs as a downloadable asset so consumers get docs matched to the binary version. | Spec still in `review`; no tasks created yet. |
