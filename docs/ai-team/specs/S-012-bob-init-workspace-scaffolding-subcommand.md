---
title: bob init workspace-scaffolding subcommand
version: '0.1'
status: draft  # draft | review | approved | superseded
created: '2026-08-09'
author: planner
id: S-012
---

# bob init workspace-scaffolding subcommand

<!--
This spec describes requirements and measurable criteria in prose.
It is not the implementation. Do not paste full configuration files,
build manifests, or implementation code into the sections below.
Concrete code belongs in the tasks the spec-breakdown skill produces
and in the Developer's output. See the Spec Authoring Guide for the
content contract this template implements.
-->

> **Paused (2026-08-09).** Architecture Consistency Review found this
> spec's core mechanism — a per-workspace deployed copy of the
> `email-skills` package under `.pi/skills/`, with working-directory-scoped
> `[[policy.action_rules]]` — contradicts `S-001`, `S-002`, and `S-010` as
> amended on 2026-08-06 alongside `ADR-014`/`S-011`, which state skills are
> supplied by bob through a single shared install path independent of
> working directory, explicitly **not** as a per-job deployed copy. That
> target model (`S-011` phases 3–4) is approved but not yet implemented. The
> human decided (2026-08-09) to finish `S-011` first rather than carve a
> transitional exception into the approved set. This draft is parked until
> `S-011` phase 4 lands; it should then be redrafted (or folded into `S-011`
> as a new phase under its existing "operator-facing deployment procedure",
> phase 5) to scaffold against the install-path model instead of a
> per-workspace copy. Full architect findings, including issues that apply
> regardless of sequencing (mixed absolute/relative `arg_matchers` patterns
> in the validated rule set; the undefined and potentially blanket-`bash`
> "generic baseline rules"; the missing offline/filesystem-only subcommand
> category in `S-001`/`S-002`; the unspecified `config.toml` file mode), are
> preserved in this review's session record for whoever resumes this work.

## Purpose

Today, taking a new machine from "bob binary downloaded" to a working session
requires hand-assembling a pi-agent workspace: copying `AGENTS.md`/`CLAUDE.md`
placeholders, deploying the `email-skills` package's `.pi/skills` content into
a workspace directory, hand-writing `config/email-triage.example.toml`, and
hand-writing a `config.toml` whose `[[policy.action_rules]]` `arg_matchers`
patterns must exactly match the workspace's own absolute path. This multi-step
procedure's failure modes — path mismatches, wrong `field_path` values, missing
owner-only permissions — are already documented at length in
`the-intern/email-skills/README.md` and the operator guide, and every step of
it has already been hand-validated once (T-139/T-140) without ever being
turned into repeatable tooling; that gap is the single biggest source of
friction in getting bob to a useful first session. When this work is done, a
single command — `bob init <path>` — produces a working, correctly-permissioned
pi-agent workspace and a bob config already wired to admit that workspace's
email-skills tool calls. Success is measured by an operator with only the
released `bob` binary and `pi` on `PATH` running `bob init <path>` followed by
`bob serve` and `bob chat` on a machine with no pre-existing bob config, and
having the email-skills tool calls admitted with zero manual TOML edits.

## Exclusions

What this specification explicitly does NOT cover:

- **Manual per-workspace skill deployment.** Skeleton-only generation that
  leaves the user to `cp -r the-intern/email-skills/.pi` into place themselves
  was rejected — it defeats the one-command goal and leaves the generated
  config referencing skill files that do not exist until the manual copy
  happens.
- **A separate email-skills release tarball unpacked by `bob init`.** Rejected
  in favor of embedding the skill content into the `bob` binary itself at
  compile time — it avoids new release-packaging CI surface and a two-artifact
  install flow for a case the compiled-in approach already covers.
- **A standalone sample-workspace repo directory or release tarball,
  independent of any CLI command.** Rejected once the `bob init` direction was
  chosen: the already-released `bob` binary becomes the delivery vehicle, so a
  separately distributed workspace artifact would be redundant.
- **Writing the generated config only inside the workspace directory.**
  Considered, but rejected in favor of a first-run-safe direct write to the
  live bob config location — the operator wanted a genuinely one-command
  fresh-install experience, not a manual copy-in step afterward.
- **Merging into an existing populated `config.toml`.** `--force` replaces the
  file wholesale; `bob init` never unions or merges
  `[[policy.action_rules]]` entries into an existing configuration.
- **Talking to a running `bob serve` instance.** `bob init` never calls `bob
  policy reload` or otherwise contacts the admin socket — it is filesystem-only.
  Applying the generated config to a live service remains a manual step.
- **Verifying or installing the `pi` binary, configuring an IMAP/SMTP account,
  or setting `manager_address`.** These remain the existing documented manual
  prerequisites; this command does not attempt to automate them.
- **Implementing S-011/ADR-014's bob-side skill-loading model** (extension-
  supplied skill paths independent of working directory). That work is
  approved but not yet implemented; this specification targets today's shipped
  working-directory-based skill discovery mechanism.
- **Multiple named or simultaneous default workspaces / per-workspace config
  profiles.** `bob init` always targets the single canonical live bob config
  location; running it again against a second path still requires `--force`
  and replaces that same single config.

## Architecture

### Design Principles

- Skill content must exist exactly once in the repository; the binary must
  embed it from the canonical `the-intern/email-skills/.pi/skills` source
  rather than carrying an independently maintained copy.
- A first run against a machine with no existing bob config must require no
  manual TOML editing to reach an admitted email-skills tool call.
- The command must never destroy data it did not itself create: default
  (non-`--force`) runs must not overwrite any pre-existing file, and even
  `--force` runs must never remove or modify a `.git` directory or touch any
  file outside the fixed set this command writes.
- Every path written into generated `[[policy.action_rules]]` `arg_matchers`
  patterns must be the resolved absolute path of the target workspace, so the
  generated rules match runtime tool-call payloads on the first try — the
  exact failure class T-139 already documents as the most common mistake.
- The command must be pure filesystem scaffolding: it must not require a
  running `bob serve` instance and must not mutate live service state.
- Every file and directory the command creates under the target workspace
  must be owner-only (mode 700/600), consistent with the existing S-010
  configuration requirement and the ADR-012 §7 trust boundary.

### System Diagram

```
 compile time                          bob init <path>  (runtime)
┌──────────────────────────┐           ┌───────────────────────────────┐
│ the-intern/email-skills/  │  embed    │ 1. resolve target path         │
│ .pi/skills/{himalaya,     │─────────▶ │ 2. create/layer workspace tree │
│ email-triage}             │ (compile) │    AGENTS.md, CLAUDE.md        │
└──────────────────────────┘           │    .pi/skills/*  (embedded)    │
             │                          │    config/*.example.toml       │
             │ include_str!             │    worklog/                    │
             ▼                          │    (mode 700; skip existing    │
      ┌──────────────┐                  │     unless --force; never      │
      │  bob binary  │                  │     touch .git)                │
      └──────────────┘                  └────────────────┬────────────────┘
                                                           │
                                                           ▼
                                          ┌───────────────────────────────┐
                                          │ 3. generate config.toml        │
                                          │    action_rules scoped to      │
                                          │    resolved absolute path      │
                                          │    + generic baseline rules    │
                                          └────────────────┬────────────────┘
                                                            │
                                                            ▼
                                    $XDG_CONFIG_HOME/bob/config.toml
                                    (refuse if exists, unless --force)
```

### Responsibility Separation

| Component | Responsibility | Notes |
|---|---|---|
| Embedded skill assets | Carry the compiled-in copy of the email-skills package content | Sourced once from `the-intern/email-skills/.pi/skills` at build time; read-only at runtime |
| `bob init` CLI command | Orchestrate workspace scaffolding and config generation | New clap subcommand in the bob crate; pure filesystem operation |
| Workspace materializer | Create/layer the target directory tree and set permissions | Applies skip-on-conflict vs. `--force` overwrite; never touches `.git` |
| Config generator | Produce a complete `config.toml` from the resolved workspace path | Bakes the absolute path into `action_rules`; writes to the live XDG config location |
| Live bob config location | Where `bob serve` actually reads its config from | Existing XDG resolution (`ADR-009`); write-guarded unless `--force` |

## Components

### Component 1: Embedded skill assets

**Purpose:** Provide the `bob` binary with a compiled-in copy of the
email-skills package content so `bob init` works from just the released
binary.
**Estimated size:** Small — build-time embedding of an existing,
already-versioned source tree.
**Interfaces:** Consumes `the-intern/email-skills/.pi/skills` as its single
source; exposes the embedded content to the workspace materializer.

### Component 2: `bob init` CLI command

**Purpose:** New clap subcommand that parses `<path>` and `--force`, then
drives workspace materialization and config generation.
**Estimated size:** Small — follows the existing per-command module pattern
already used by `status`/`sessions`/`policy`/`schedule`/`chat`.
**Interfaces:** Consumes CLI arguments; produces process exit status and
user-facing terminal output, including per-file conflict warnings.

### Component 3: Workspace materializer

**Purpose:** Create or layer into the target directory, writing the fixed set
of workspace files/directories and setting owner-only permissions.
**Estimated size:** Medium — directory creation, per-file existence checks,
conflict warnings, permission setting, and the `.git` exclusion rule.
**Interfaces:** Consumes the embedded skill assets and the target path;
exposes the finished workspace tree on disk.

### Component 4: Config generator

**Purpose:** Produce a complete `config.toml` — email-skills action rules
bound to the resolved workspace path, plus generic baseline rules — and write
it to the live bob config location under the same overwrite-guard rules.
**Estimated size:** Small-medium — templated TOML generation plus the
existing-file guard.
**Interfaces:** Consumes the resolved absolute workspace path; produces the
on-disk `config.toml` that `bob serve`'s existing config loader reads.

## Workflow

```
Operator downloads released bob binary, has pi on PATH
  ↓
Operator runs `bob init <path>` [--force]
  ↓
bob resolves <path> to an absolute path
  ↓
Target path missing → create it
Target path exists  → layer in (per-file skip+warn, or overwrite if --force;
                       .git never touched)
  ↓
Write AGENTS.md / CLAUDE.md placeholders, .pi/skills/{himalaya,email-triage}
  (from embedded assets), config/email-triage.example.toml, worklog/
  ↓
Set the workspace tree owner-only (mode 700/600)
  ↓
Generate config.toml: email-skills action_rules bound to the resolved
  absolute path, plus generic baseline read/bash/write/edit rules
  ↓
Live config already exists at the XDG location?
  → yes and no --force: refuse, print the existing path, exit non-zero
  → yes and --force: overwrite it
  → no: write it
  ↓
Print next steps: set manager_address in config/email-triage.toml,
  start `bob serve`, run `bob policy reload` if it was already running
  ↓
★ Operator reviews the generated config.toml before relying on it
  ↓
Operator runs `bob chat`, or adds a scheduled job with --cwd <path>
```

## Configuration Requirements

- **What must exist:** the target workspace path argument to `bob init`.
  **Where it lives:** a required positional CLI argument.
  **Constraints:** resolved to an absolute path before use (relative paths
  resolve against the current working directory); must not resolve to a path
  the process lacks permission to create.
  **Missing-value behaviour:** clap-level error — the command refuses to run
  without it.

- **What must exist:** the `--force` flag governing overwrite behaviour.
  **Where it lives:** an optional CLI flag.
  **Constraints:** when present, permits overwriting exactly the fixed set of
  files/directories `bob init` itself writes (workspace placeholders,
  embedded skill files, the example config, and the live `config.toml`) and
  nothing else; must never delete or modify a `.git` directory at the target
  path even when set.
  **Missing-value behaviour:** absent means skip-and-warn on any existing
  workspace file, and refuse outright if the live `config.toml` already
  exists.

- **What must exist:** the live bob config location `bob init` writes to.
  **Where it lives:** the same XDG-based resolution bob's config loader
  already uses (`$XDG_CONFIG_HOME/bob/config.toml`, falling back per-platform
  as bob already documents).
  **Constraints:** must be the same path `bob serve` itself resolves, so the
  generated config takes effect without an extra relocation step.
  **Missing-value behaviour:** if no config exists yet at that path, `bob
  init` creates it; if one exists, behaviour follows the `--force` rule
  above.

- **What must exist:** the embedded email-skills asset source at build time.
  **Where it lives:** the existing `the-intern/email-skills/.pi/skills`
  directory in the repository, embedded into the `bob` binary at compile
  time.
  **Constraints:** must remain the single source of this content — no second
  copy is checked in or maintained elsewhere; a change to the email-skills
  package is picked up by the next `bob` build with no separate sync step.
  **Missing-value behaviour:** not applicable — this is a build-time
  dependency internal to the repository, not an operator-facing setting.

## Implementation Order

| Phase | What | Depends On |
|---|---|---|
| 1 | Embed the email-skills package content (`the-intern/email-skills/.pi/skills`) into the bob binary at compile time, verified by a test that the embedded content matches the source tree. | Nothing |
| 2 | Add the `bob init <path> [--force]` CLI command: resolve the path, create/layer the workspace tree (placeholders, embedded skill files, example config, worklog dir), apply owner-only permissions, and implement the skip-and-warn / `--force`-overwrite / `.git`-exclusion rules. | Phase 1 |
| 3 | Add `config.toml` generation: bind the validated email-skills action rules to the resolved absolute workspace path, add the generic baseline rules, and write to the live XDG config location with the exists-refuse / `--force`-overwrite guard. | Phase 2 |
| 4 | Document `bob init` in the operator guide/quickstart and the CLI reference, replacing or supplementing the existing manual deployment procedure with the one-command path. | Phase 3 |

## Amendment Log

<!-- Optional. Use when an approved spec is amended after tasks are in flight.
| Date | What changed | Why | Affected tasks |
|------|-------------|-----|----------------|
| YYYY-MM-DD | Description of change | Reason for amendment | T-XXX, T-YYY |
-->
