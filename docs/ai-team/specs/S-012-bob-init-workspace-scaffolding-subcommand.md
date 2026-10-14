---
title: bob init workspace-scaffolding subcommand
version: '0.4'
status: approved
created: '2026-08-09'
author: planner
id: S-012
---

# bob init workspace-scaffolding subcommand

## Purpose

`bob init <path>` makes a new pi-agent workspace and the live bob
configuration needed for a useful first session. It creates only the mutable,
workspace-local state that S-010 requires: trusted context placeholders, a
real `config/email-triage.toml` seeded from the shipped example, and a
`worklog/` directory, and an empty `tasks/` board directory for the S-014 task
board. It installs the shipped pi skill package once at bob's
shared S-011/ADR-014 install path, rather than copying skills into the
workspace. It then writes a deliberately permissive first-run policy profile
so the shipped skills work without manual TOML rule authoring.

The intended fresh-machine flow is: install the released `bob` binary, ensure
`pi` and a himalaya account exist, run `bob init <workspace>`, set
`manager_address` in the generated workspace configuration when desired, then
run `bob serve` and `bob chat` or schedule a job with `--cwd <workspace>`.
`bob init` is filesystem-only and never contacts a running service.

A second mode, `bob init --skills-only`, refreshes only the shared skill
package — independent of any workspace and of the live config — so an
operator upgrading bob (by any route: the release bundle, `mise`, a source
build) can pick up a skill a newer release adds without re-scaffolding
anything or accepting `--force`'s workspace/config-file replacement.

## Exclusions

- Merging generated policy with an existing `config.toml`; without `--force`
  the command refuses the existing live config, and with it replaces only that
  file wholesale.
- Installing pi, configuring himalaya credentials, or discovering the manager
  address.
- Per-workspace skill deployment. Skills are installed once at the shared
  install path and supplied by the extension under ADR-014.
- Reloading live configuration or contacting an admin socket.
- Treating the generated policy as a sandbox or least-privilege profile.

## Architecture

### Principles

- The canonical skills source remains `the-intern/bob-skills/skills`; the
  released binary embeds the generated pi package only as a delivery asset and
  materializes it once into the shared install path. The embedded set has five
  skills. One of them, `the-intern-docs` (S-011), sources its reference pages
  from the user manual under `the-intern/docs/src/` at build time — never from
  a tracked copy. A clean build from a fresh checkout either embeds those
  pages or fails with a clear error; it never silently embeds a skill index
  that points at missing pages.
- The shared install path is the same XDG-data default `BobConfig` resolves
  for S-011, and generated `config.toml` explicitly selects it so the first
  run is deterministic.
- The workspace contains no `.pi/skills` tree. Its context files, local
  configuration, and worklog remain trusted inputs and must be owner-only.
- `--force` may overwrite only files owned by this command. It never follows,
  removes, or modifies a target `.git` directory.
- The CR-007 bootstrap profile has four explicit no-matcher action rules:
  `bash`, `read`, `write`, and `edit`. Other tools remain default-denied. The
  command warns that each named tool is permitted for any arguments the bob
  process can access and asks the operator to review and narrow it.

### Responsibilities

| Component | Responsibility |
|---|---|
| Embedded pi-package assets | Compile two inputs into the binary and expose their fixed files to installation code: the generated `bob-skills/.pi/skills` output, and the user manual pages copied from `the-intern/docs/src/` into the `the-intern-docs` skill at build time (excluding the CLI-reference stub page and the book's table of contents). The page copy is never written into a tracked directory; a change to the manual changes the binary, and a test fails if the embedded pages drift from the manual source. |
| Shared-skill installer | Materialize the assets at the resolved shared install path, with owner-only permissions and non-destructive/force semantics. |
| Workspace materializer | Create `AGENTS.md`, `CLAUDE.md`, `config/email-triage.toml`, `worklog/`, and `tasks/`; all are owner-only. |
| Config generator | Write the complete live config at the same path used by bob's loader, including its shared install path and CR-007 policy profile. |
| `bob init` command | Parse path/`--force`/`--skills-only`, resolve paths, run the filesystem steps, report conflicts, warnings, and next steps. |

## Workflow

```
bob init <workspace> [--force]
  → resolve workspace and shared XDG paths to absolute paths
  → install the embedded pi skill package once at the shared install path
  → create/layer workspace context files, local email configuration, worklog/
  → create or replace live XDG config.toml (guarded by --force)
  → print broad-policy warning and next steps

bob init --skills-only [--force]
  → resolve the default skill install path from the environment alone
    (config.toml is never read; a skill_install_path override is not followed)
  → install the embedded pi skill package once at that path
  → print the installed/refreshed/skipped skill file report
```

Existing workspace files are skipped and named in warnings without `--force`.
With `--force`, only the fixed scaffold files and the shared installed skill
files may be replaced. A target `.git` directory is never touched. In the
default (workspace-scaffolding) mode, existing live config is an
all-or-nothing guard: if it exists and `--force` is absent, the command
exits non-zero after leaving it unchanged. `--skills-only` mode is
independent of this guard — it never reads or writes the live config or any
workspace file, so an existing live config neither blocks it nor is touched
by it, with or without `--force`.

## Configuration Requirements

### CLI

- `<path>` is required unless `--skills-only` is given, and resolves relative
  input against the current working directory to an absolute workspace path.
  An uncreatable path fails without partial writes where feasible.
- `--force` is optional. It enables replacement of only the fixed generated
  files; its absence skips workspace conflicts and refuses a live config
  conflict.
- `--skills-only` is optional and mutually exclusive with `<path>`. It
  installs or refreshes the shared skill package only at the default skill
  install path, which it resolves from the environment alone
  (`XDG_DATA_HOME`, or the platform default for bob's data bucket); it never
  reads `config.toml` and so never follows a configured
  `skill_install_path` override. This is what lets `install.sh` refill
  exactly the path it emptied (S-013, ADR-017). It is not subject to the
  live-config-exists guard: it creates or writes no workspace file and no live config, so there
  is nothing for that guard to protect. Per-file semantics match the
  Shared-skill installer's existing non-destructive/force behavior: each
  embedded skill file is created if missing and left untouched unless
  `--force` is also given, which then replaces every packaged skill file
  with the version embedded in the running binary. `--skills-only` remains
  filesystem-only and contacts no running service, consistent with `bob
  init`'s existing classification (S-002, ADR-007). When `install.sh`
  invokes `--skills-only` (S-013), it has first emptied the default skill
  install path, so the call installs every embedded skill into an empty
  folder; CR-012's non-destructive "existing files are left untouched"
  outcome therefore no longer applies to installs through `install.sh`. A
  hand-run `bob init --skills-only [--force]` and plain
  `bob init <path> [--force]` keep the per-file semantics above. No new flag
  or mode is added for this.

### Files created

- `<workspace>/AGENTS.md` and `<workspace>/CLAUDE.md` contain concise,
  identical placeholders stating that workspace-specific instructions belong
  there and are trusted pi context.
- `<workspace>/config/email-triage.toml` is created from the shipped example,
  rather than only writing an example file. It remains a local operator file;
  `manager_address` is intentionally left for the operator.
- `<workspace>/worklog/` is created for the worklog skill.
- `<workspace>/tasks/` is created, empty, as the S-014 task board. No task file,
  placeholder, or index is written into it. Because its contents are operator
  and agent work product rather than files this command owns, `--force` never
  removes or replaces anything inside it; an existing directory at that path is
  skipped and named in the warnings.
- The shared install path receives the five embedded pi-package trees —
  `himalaya`, `email-triage`, `worklog`, `tasks`, and `the-intern-docs` (its
  `SKILL.md`, topic index, and the manual pages copied in at build time) —
  never a workspace copy.
- Directories are mode `0700`; generated files, including live `config.toml`,
  are mode `0600` on Unix platforms.

### Generated live config

The command writes to the loader's XDG config path (`$XDG_CONFIG_HOME/bob/
config.toml`, or its existing platform fallback) and includes the resolved
absolute shared `skill_install_path` plus four separate `[[policy.action_rules]]`
entries for `bash`, `read`, `write`, and `edit`, each with no `arg_matchers`.
It may include the existing operational defaults required for a valid fresh
`BobConfig`, but no schedule entries or secrets. It must not write
workspace-relative policy paths.

The terminal output must state that the profile permits arbitrary shell
commands and unrestricted reads/writes/edits available to bob's uid; the
operator MUST review and narrow it before relying on it as a security control.

## Verification

Automated coverage must prove a fresh init creates all five shared skill
trees (including the `the-intern-docs` manual pages), workspace files, mode
bits, and a loader-valid config with precisely the four
no-matcher rules; an unsupported tool remains denied. It must also prove
relative-path resolution, no-force conflicts, force replacement, `.git`
preservation, live-config refusal, and that no admin socket is opened.
It must additionally prove that `--skills-only` installs a missing skill
file and leaves an existing one untouched without `--force`, replaces it
with `--force`, and behaves identically whether or not a live config
already exists — and that plain `bob init`'s live-config refusal is
unaffected by `--skills-only`'s existence. Expectations that pin the
embedded or installed skill set must name the five skills. A test must fail
when the embedded `the-intern-docs` pages differ from the manual source, and
no manual page copied into that skill may be named `SKILL.md`.

An end-to-end command test must use isolated XDG paths, run `bob init`, then
start `bob serve` and verify a `bob chat` or scheduled session can discover
the shared skills from the initialized workspace without a workspace
`.pi/skills` directory.

## Implementation Order

| Phase | What | Depends On |
|---|---|---|
| 1 | Embed the generated pi skill package and expose a deterministic shared-install materializer. | Nothing |
| 2 | Implement workspace and live-config generation, permissions, and conflict/force safety rules. | Phase 1 |
| 3 | Add the clap command and runtime dispatch, with filesystem-only command tests. | Phase 2 |
| 4 | Document the one-command procedure and the broad bootstrap-policy warning. | Phase 3 |
| 5 | (CR-016) Embed the five-skill set: copy the manual pages into the `the-intern-docs` skill at build time under the never-tracked and fail-loudly constraints, add the drift test, and update every expectation that pins the embedded or installed skill set to four. | Phase 1; S-011 Phase 6 (the docs skill's `SKILL.md` and topic index exist in the packaged skill set) |

## Amendment Log

| Date | What changed | Why | Affected tasks |
|------|-------------|-----|----------------|
| 2026-08-12 | Redrafted against S-011/ADR-014: skills install once at a shared path, while init creates workspace-local state and the CR-007 permissive bootstrap policy. | The earlier draft's per-workspace skill deployment contradicted the approved shared install-path architecture. | Tasks TBD |
| 2026-08-23 | `bob init` also creates an empty `<workspace>/tasks/` board directory and installs a fourth `tasks` pi-package tree at the shared install path. `--force` never removes or replaces board content. | CR-009, driven by S-014: the task board resolves from the working directory, so scaffolding it fixes the resolution point at the workspace root, and the skill that teaches the command reaches sessions only through the shared install path this command populates. | Tasks TBD |
| 2026-08-23 | The canonical skills source and the embedded pi-package output are named under `the-intern/bob-skills/` instead of `the-intern/email-skills/`. | CR-010. The package holds domain-free skills — `worklog` by S-011's design and `tasks` by S-014 — so its email-oriented directory name no longer describes it. Rename only; no behaviour, layout, or install-path change. | Tasks TBD |
| 2026-09-14 | Added `bob init --skills-only`: installs/refreshes the shared skill package at `skill_install_path` independent of the live-config-exists guard, mutually exclusive with `<path>`. The guard's "all-or-nothing" language is scoped explicitly to the workspace-scaffolding mode. | CR-012, driven by issue #55: an operator upgrading bob had no way to pick up a skill a newer release adds without `bob init --force`, which is destructive to operator-authored workspace/config files (issue #56, kept out of this change's scope). | T-201 (install.sh side; the `--skills-only` flag itself shipped pre-amendment via PR #88) |
| 2026-10-13 | The embedded and installed skill set grows to five with `the-intern-docs` (Principles, "Embedded pi-package assets" row, Files created, Verification). That skill's reference pages are copied from the user manual under `the-intern/docs/src/` at build time — never from a tracked copy — and a clean build either embeds them or fails with a clear error; a drift test compares them with the manual source. The `--skills-only` CLI entry records that `install.sh` now empties the default skill install path before invoking it, so CR-012's non-destructive outcome no longer applies to installs through `install.sh`; hand-run `--skills-only` and plain `bob init` keep their per-file semantics. No new flag or mode. The `--skills-only` CLI entry and Workflow line now state that it resolves the default skill install path from the environment alone, never reads `config.toml`, and never follows a `skill_install_path` override (correcting the earlier "resolved `skill_install_path`" wording to match the implementation, S-013 and ADR-017, so the path `install.sh` empties is the path refilled). New Phase 5 orders the CR-016 embedding work. | CR-016 (issue #138) / ADR-017 (CR-016): the manual ships as a skill delivered exactly like the others, and every `install.sh` install leaves the default skill install path holding exactly the release's skills. | T-232, T-233, T-237, T-238 |
