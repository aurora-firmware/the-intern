---
title: bob init workspace-scaffolding subcommand
version: '0.2'
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

- The canonical skills source remains `the-intern/email-skills/skills`; the
  released binary embeds the generated pi package only as a delivery asset and
  materializes it once into the shared install path.
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
| Embedded pi-package assets | Compile the generated `email-skills/.pi/skills` output into the binary and expose its fixed files to installation code. |
| Shared-skill installer | Materialize the assets at the resolved shared install path, with owner-only permissions and non-destructive/force semantics. |
| Workspace materializer | Create `AGENTS.md`, `CLAUDE.md`, `config/email-triage.toml`, `worklog/`, and `tasks/`; all are owner-only. |
| Config generator | Write the complete live config at the same path used by bob's loader, including its shared install path and CR-007 policy profile. |
| `bob init` command | Parse path and `--force`, resolve paths, run the filesystem steps, report conflicts, warnings, and next steps. |

## Workflow

```
bob init <workspace> [--force]
  → resolve workspace and shared XDG paths to absolute paths
  → install the embedded pi skill package once at the shared install path
  → create/layer workspace context files, local email configuration, worklog/
  → create or replace live XDG config.toml (guarded by --force)
  → print broad-policy warning and next steps
```

Existing workspace files are skipped and named in warnings without `--force`.
With `--force`, only the fixed scaffold files and the shared installed skill
files may be replaced. A target `.git` directory is never touched. Existing
live config is an all-or-nothing guard: if it exists and `--force` is absent,
the command exits non-zero after leaving it unchanged.

## Configuration Requirements

### CLI

- `<path>` is required and resolves relative input against the current working
  directory to an absolute workspace path. An uncreatable path fails without
  partial writes where feasible.
- `--force` is optional. It enables replacement of only the fixed generated
  files; its absence skips workspace conflicts and refuses a live config
  conflict.

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
- The shared install path receives the embedded `himalaya`, `email-triage`,
  `worklog`, and `tasks` pi-package trees, never a workspace copy.
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

Automated coverage must prove a fresh init creates the shared skills,
workspace files, mode bits, and a loader-valid config with precisely the four
no-matcher rules; an unsupported tool remains denied. It must also prove
relative-path resolution, no-force conflicts, force replacement, `.git`
preservation, live-config refusal, and that no admin socket is opened.

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

## Amendment Log

| Date | What changed | Why | Affected tasks |
|------|-------------|-----|----------------|
| 2026-08-12 | Redrafted against S-011/ADR-014: skills install once at a shared path, while init creates workspace-local state and the CR-007 permissive bootstrap policy. | The earlier draft's per-workspace skill deployment contradicted the approved shared install-path architecture. | Tasks TBD |
| 2026-08-23 | `bob init` also creates an empty `<workspace>/tasks/` board directory and installs a fourth `tasks` pi-package tree at the shared install path. `--force` never removes or replaces board content. | CR-009, driven by S-014: the task board resolves from the working directory, so scaffolding it fixes the resolution point at the workspace root, and the skill that teaches the command reaches sessions only through the shared install path this command populates. | Tasks TBD |
