---
id: CR-009
title: bob init scaffolds a task board directory in a fresh workspace
status: applied
created: '2026-08-23'
---

# bob init scaffolds a task board directory in a fresh workspace

## Desired Changes

Extend `bob init` so it creates a task board directory in the workspace it
scaffolds, alongside the `worklog/` directory it already creates, with the same
owner-only protection S-012 requires of every directory it makes.

Scope and constraints:

- The board directory is created empty. `bob init` writes no task files, no
  placeholder task, and no index of any kind.
- The board directory is subject to S-012's existing non-destructive rules: an
  existing directory at that path is skipped and named in the warnings, and
  `--force` does not remove or replace board content, because task files are
  operator and agent work product rather than files this command owns.
- The scaffolding is a convenience only. The `bob task` command specified in
  S-014 must continue to work in any directory, including one `bob init` has
  never touched, and must not acquire a dependency on `bob init` having run.
- No configuration key is added. `bob init` does not record the board location
  in the generated live configuration, because S-014 resolves the board from
  the working directory rather than from configuration.

Additionally, `bob init` installs the S-014 `tasks` skill alongside the three
skill trees it already materializes at the shared install path. S-014 delivers
that skill to pi sessions only through the S-011/ADR-014 install path, and
`bob init` is what puts content there, so without this the skill ships in the
package and never reaches a session. The installation is subject to the same
non-destructive and `--force` semantics as the existing trees; nothing else
about the shared-skill installer changes.

## Context

S-014 specifies a `bob task` subcommand that keeps a markdown task board in a
`tasks/` directory, resolved by walking upward from the working directory to the
nearest ancestor board. A workspace scaffolded by `bob init` today contains no
such directory, so the first task filed from a session running inside that
workspace creates the board wherever that session's working directory happened
to resolve — which for a scheduled job is its per-entry working directory, not
the workspace root. The result is a board in a plausible-looking but arbitrary
location, and potentially a second board later when a session runs from a
different subdirectory.

Creating the directory during scaffolding fixes the resolution point once, at
the moment the workspace is defined, so every session spawned with a working
directory inside that workspace attaches to the same board by construction.

S-012 is approved, and this changes the set of files it specifies `bob init`
creates, so the change goes through this change-request rather than an edit to
the approved specification.

The skill-installation half has the same shape. S-012 enumerates the embedded
trees the shared install path receives by name, so a fourth tree is a change to
that enumeration and not something a later specification may assume silently.
An architecture consistency review of the S-014 draft raised it: S-014 relies on
`bob init` to install the skill, while S-012 states exactly which skills it
installs, and the two would otherwise disagree.

## Potential Impact

- **S-012 §Files created** gains one directory and one installed skill tree. Its
  acceptance criteria and any task-level tests asserting the exact set of
  created workspace entries or installed skill trees need updating; a test that
  asserts either set exhaustively will fail until it is.
- **`bob init --force` semantics** are unaffected in substance but gain an
  explicit statement: the board directory is created if absent and never
  cleared, so `--force` cannot destroy task files. Without that statement the
  existing "may overwrite only files owned by this command" rule is ambiguous
  about board content.
- **Hand-written documentation goes stale in two products.** The bob-companion
  plugin names the workspace layout and the installed skill package in its CLI
  command reference and its setup skill; the shipped mdBook manual names them
  again in its quickstart and operator guide. All of it becomes inaccurate the
  moment this change lands, so the documentation update is part of the change
  rather than follow-up work. The manual's CLI reference is exempt — S-007
  derives it from `--help` at build time.
- **The fresh-machine flow** in S-012's Purpose gains no new step. The operator
  does nothing differently; the workspace simply has a board when the first
  session starts.
- **No risk to existing installations.** An already-initialised workspace is
  unaffected until `bob init` is re-run against it, and `bob task` creates the
  board on first write regardless, so nothing breaks if this change is never
  applied.
- **Sequencing.** S-014 Phase 5 depends on this change-request being approved.
  The rest of S-014 does not.

## Possible Spec Amendments

- **S-012** — amend the "Files created" list under Configuration Requirements to
  include the workspace task board directory at mode `0700`, amend the
  Workspace materializer row in the Responsibilities table to name it, and state
  that `--force` never removes or replaces board content.
- **S-012** — amend the same list so the shared install path receives the
  `tasks` pi-package tree alongside `himalaya`, `email-triage`, and `worklog`.
- **S-011** — amend its System Diagram and Responsibility Separation table so the
  canonical skill set enumerates `tasks` as a fourth skill. No S-011 principle,
  packaging target, or delivery path changes; only the enumeration is stale.
