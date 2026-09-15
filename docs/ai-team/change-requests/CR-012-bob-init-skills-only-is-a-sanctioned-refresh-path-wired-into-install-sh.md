---
id: CR-012
title: bob init --skills-only is a sanctioned refresh path, wired into 
  install.sh
status: applied
created: '2026-09-14'
---

# bob init --skills-only is a sanctioned refresh path, wired into install.sh

> **Applied (2026-09-14):** Architect consistency review passed (one in-place
> correction to this draft: narrowed S-013's `bob init` exclusion instead of
> leaving it as a blanket exclusion, before the review closed). S-012 was
> amended to version 0.3 (CLI contract, Workflow, Responsibilities,
> Verification, Amendment Log) to sanction `--skills-only` as a real mode,
> already reflected by the shipped implementation on `dev-agent`/`main` (PR
> #88). S-013 was amended to version 0.3 (Exclusions, Component 3, Workflow
> diagram, Configuration Requirements, Amendment Log) to document
> `install.sh` invoking `bob init --skills-only` non-blocking after the
> binary replace. The `install.sh` side is new work, not yet implemented —
> a task should be created against it (Depends On: none; touches
> `the-intern/install-bundle/install.sh` and its test script).

## Desired Changes

`bob init --skills-only` becomes a sanctioned, documented `bob init` flag — not
a bypass of S-012, but a third explicit mode alongside plain `bob init <path>`
and `bob init <path> --force`:

- **Argument shape:** `<path>` becomes required unless `--skills-only` is
  given (a skills-only refresh touches no workspace, so it needs none).
  `--skills-only` is mutually exclusive with `<path>`.
- **Behavior:** installs/refreshes the shared skill package at the resolved
  `skill_install_path` only — it never scaffolds a workspace, never writes
  the live config, and is *not* subject to S-012's live-config-exists guard,
  because it never touches any of the files that guard protects. Per-file
  semantics reuse the existing, already-spec'd "Shared-skill installer"
  responsibility (S-012's Responsibilities table): each embedded skill file
  is created if missing and left untouched unless `--force` is also given,
  which then replaces every packaged skill file with the version embedded in
  the running binary.
- **`install.sh` integration (S-013):** immediately after `install.sh`
  atomically replaces the `bob` binary, it invokes
  `$install_binary_path init --skills-only` — the binary it just installed,
  not whatever `bob` resolves on `PATH` (keeps this independent of the
  PATH-shadow scenario `install.sh` also warns about). This call never
  passes `--force`. Failure is non-blocking: `install.sh` prints a warning
  and continues, the same pattern already used for the `pi`-on-`PATH` check
  — a skill-refresh failure must not fail an otherwise-successful binary
  install.
- Plain `bob init <path> [--force]` is completely unchanged: the live-config
  all-or-nothing guard still applies exactly as S-012 specifies today.

## Context

Issue #55 reported that upgrading `bob` (via `mise` or the release zip) does
not pick up a skill added by a newer release, and the only existing route
(`bob init --force`) is destructive to operator-authored files (`AGENTS.md`,
`CLAUDE.md`, `config/email-triage.toml`, the live config). It was fixed as a
plain bug fix (PR #88, merged to `dev-agent`) by adding `bob init
--skills-only`, which installs/refreshes the shared skill package
independent of `bob init`'s live-config-exists guard.

A dedicated spec/ADR-alignment review of that fix found it contradicts
S-012's explicit, unqualified CLI contract: `"<path>` is required", `--force`
is the only flag, and "Existing live config is an all-or-nothing guard: if it
exists and `--force` is absent, the command exits non-zero after leaving it
unchanged." No change-request or spec amendment sanctioned this before it
shipped. This is the same class of gap issue #56's diagnosis already flagged
and explicitly deferred to a change-request: *"The reporter's second remedy
— copying each overwritten file to a backup — was implemented first, then
dropped. It extends S-012 beyond its written contract... so it belongs in a
change-request, not this fix."* That precedent should have been applied to
#55 too; this CR is the missing step.

**Alternatives considered and rejected during brainstorming with the human:**

1. A wholly separate `bob skills install`/`refresh` subcommand outside `bob
   init`'s CLI contract entirely — never needs an S-012 amendment. Rejected:
   would discard the already-built, tested, merged `--skills-only`
   implementation for no material benefit, and still needs its own spec.
2. Ship the skill package as a plain file tree in the release zip;
   `install.sh` copies it directly with no `bob` binary invocation at all
   (closer to the issue's own original suggested fix; avoids touching S-012
   entirely, only needs an S-013 change). Rejected in favor of keeping
   `--skills-only`: reuses already-built code, and a zip-file-tree approach
   would still need a standalone equivalent command for the `mise`/non-zip
   upgrade case anyway, so it doesn't actually avoid needing *some*
   CLI-level change — it would just duplicate the mechanism in two places
   instead of one.
3. Automatic top-up at `bob serve` startup instead of any explicit command.
   Rejected: means `bob` silently writes to the filesystem on every service
   start with no operator action or visibility — the human preferred an
   explicit, auditable action over silent automation. Settled instead on
   `install.sh` performing the refresh automatically as part of the upgrade
   step the operator already explicitly runs, while keeping the manual `bob
   init --skills-only` path for non-zip upgrades (this is the part that
   actually matters: issue #55's own repro was a `mise` upgrade, which never
   runs `install.sh` at all, so an `install.sh`-only fix would not have
   covered the reported scenario).

## Potential Impact

- **S-012** (`bob init` workspace-scaffolding subcommand): CLI contract gains
  a third mode. The "Configuration Requirements → CLI" section's `<path> is
  required` statement needs the `--skills-only` exception; the "Existing live
  config is an all-or-nothing guard" statement needs a note that it governs
  the workspace-scaffolding mode only, not the skills-only mode which never
  touches the live config or workspace files in the first place. The
  Responsibilities table's "Shared-skill installer" row already describes
  non-destructive/force semantics generically enough to cover this without
  change. The Amendment Log gains an entry.
- **S-013** (install-bundle release packaging): Component 3 (`install.sh`)
  gains a documented fourth interface — invoking the just-installed binary
  once, non-blocking on failure — alongside its existing "reads no
  configuration file... makes no network calls" characterization (that
  characterization is otherwise unaffected: no config file is read, no
  network call is made; a local subprocess invocation of the binary
  `install.sh` itself just wrote is a new but narrowly-scoped exception worth
  calling out explicitly rather than leaving implicit). The Workflow diagram
  and the Configuration Requirements list gain the new step.
- **No impact to any other spec or ADR.** ADR-009 (XDG layout) and ADR-014
  (skill delivery via `resources_discover`) are unaffected — `--skills-only`
  resolves `skill_install_path` through the same path S-012/ADR-009 already
  govern.
- **No impact to in-flight tasks.** The S-012-side implementation is already
  merged to `dev-agent` (PR #88, reviewed clean); this CR makes it
  spec-compliant retroactively rather than requiring rework. Only the
  S-013-side `install.sh` integration is new implementation work, to be
  broken into a task once this CR is accepted.
- **Explicitly out of scope, kept separate:** issue #56's still-open concern
  — `--force` overwriting `AGENTS.md`/`CLAUDE.md`/`config/email-triage.toml`/
  the live config with no backup — is not addressed by this CR. That was
  already scoped out of #56's own fix (PR #80, message-only) as needing its
  own change-request, and stays that way here too.
- **Risk:** none identified to shipped behavior — the S-012 side is already
  live on `dev-agent` and has not regressed anything; this CR only brings the
  documentation into alignment with it and adds the new, non-blocking
  `install.sh` call.

## Possible Spec Amendments

- **S-012** (`docs/ai-team/specs/S-012-bob-init-workspace-scaffolding-subcommand.md`):
  amend "Configuration Requirements → CLI" to document `--skills-only` as a
  third mode (path becomes required unless `--skills-only` is given, mutually
  exclusive with it); amend the Workflow section's "Existing live config is an
  all-or-nothing guard" language to scope it explicitly to the
  workspace-scaffolding mode; add an Amendment Log entry citing this CR and
  issue #55.
- **S-013** (`docs/ai-team/specs/S-013-cross-platform-bob-install-bundle-release-packaging.md`):
  amend Component 3 (`install.sh`) and the Workflow diagram to document the
  post-binary-replace, non-blocking `bob init --skills-only` invocation.
  **Also amend the Exclusions section** — it currently states "`bob init` /
  workspace scaffolding... this spec ends at 'bob is installed, on `PATH`,
  and the extension is in place' — it does not create or touch any
  workspace," which as written excludes S-013 from ever invoking `bob init`
  at all. The amendment must narrow this to "workspace scaffolding" (S-012's
  `<path>` mode) specifically, carving out that `install.sh` MAY invoke `bob
  init --skills-only` — which touches only the shared skill install path,
  never a workspace and never `config.toml` — while leaving the rest of the
  exclusion (no workspace touched, `bob init`'s generated `config.toml` and
  its `extension_path` omission are unmodified) explicitly intact, since
  `--skills-only` writes neither. Add an Amendment Log entry citing this CR
  and issue #55.
