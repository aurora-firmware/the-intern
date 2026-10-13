---
title: Cross-platform bob install bundle release packaging
version: '0.4'
status: approved  # draft | review | approved | superseded
created: '2026-08-15'
author: planner
id: S-013
---

# Cross-platform bob install bundle release packaging

<!--
This spec describes requirements and measurable criteria in prose.
It is not the implementation. Do not paste full configuration files,
build manifests, or implementation code into the sections below.
Concrete code belongs in the tasks the spec-breakdown skill produces
and in the Developer's output. See the Spec Authoring Guide for the
content contract this template implements.
-->

## Purpose

Getting `bob` running today requires either a full source checkout or three
separate manual steps — download the binary, `chmod`/move it onto `PATH` by
hand, then download and extract the extension archive to a hand-typed
platform-specific path — before `bob init` is even reachable, and the whole
release is Linux-only. This matters now because the project's goal is to
make the-intern easy to hand to a new machine or a new person without
walking them through the mdBook quickstart line-by-line, and because macOS
support has been requested and nothing currently builds or ships for it.
When this work is done, every tagged release attaches one self-contained,
platform-named zip per supported platform (Linux x86_64, macOS arm64)
containing the `bob` binary, the pi-agent extension, an install script, and
a plain-text readme; running that script is the only step required before
`bob init`. Success is observable as: the quickstart's "get bob running"
section collapses from three manual multi-line steps to "download the zip
for your platform, run `install.sh`" — for both platforms.

## Exclusions

What this specification explicitly does NOT cover:

- **`bob init` workspace scaffolding.** Owned by S-012. This spec's install
  flow still ends at "bob is installed, on `PATH`, and the extension is in
  place" — it does not create or touch any workspace, and does not modify
  S-012's config generation (this handoff is only correct because `bob
  init`'s generated `config.toml` does not set `extension_path`, so bob
  keeps resolving the extension at the location `install.sh` wrote; this
  spec assumes that invariant). The one exception is `bob init --skills-only`
  (S-012, added by CR-012): after installing the binary and extension and
  emptying the default skill install path (Component 3), `install.sh`
  invokes the just-installed binary's `init --skills-only`, non-blocking on
  failure, to install the release's skills into that emptied folder. Neither
  `install.sh`'s emptying step nor that invocation touches anything but the
  default skill install path — never a workspace and never `config.toml` — so
  they do not cross into workspace scaffolding or config generation and do
  not weaken this exclusion for anything else `bob init` does.
- **Installing or managing the `pi` prerequisite.** `install.sh` may check
  and report whether `pi` is on `PATH`, but must never substitute a mock or
  wrapper for it — this is a hard, pre-existing project rule (see root
  `CLAUDE.md`/`README.md` "Runtime prerequisites").
- **Removing, replacing, or renaming the four existing release assets** (the
  bare `bob` binary, the docs archive, the `bob-extension` tarball, and the
  `bob-companion` tarball). This work is additive only — all four keep
  shipping unchanged, built and attached by the same Linux release job as
  today, for consumers that already depend on them.
- **Restructuring `deploy.yml` into a full per-step build matrix.** The
  macOS binary is produced by a separate, additional job that hands its
  install bundle to the existing Linux release job as a build artifact —
  the docs build, the three existing archives, and the single GitHub
  Release creation step stay exactly where S-007 already puts them, in one
  job, to preserve its "exactly one docs archive" contract.
- **Windows, Linux arm64, and macOS x86_64/Intel.** Only `linux-x86_64` and
  `macos-arm64` are in scope. Rejected as scope expansion during
  brainstorming — the human confirmed macOS support means Apple Silicon
  only for this spec.
- **A remote, network-fetching installer** (e.g. `curl | bash` that hits the
  GitHub Releases API at install time). Considered and rejected during
  brainstorming in favor of a self-contained, offline-capable zip — the
  remote approach was judged a materially bigger and riskier new failure
  surface (API parsing, rate limits, curl-pipe-to-bash trust concerns) for
  a first version.
- **Any unattended route other than `-y`.** The earlier exclusion of
  unattended/non-interactive install (no `--yes`-style flag) is withdrawn by
  CR-016: the `-y` argument (Component 3) answers the overwrite prompt for
  scripted and unattended upgrades and is the only unattended route. Without
  `-y` and with no input available, `install.sh` still aborts with no
  changes.
- **Following a configured `skill_install_path` override.** `install.sh`
  reads no configuration, so a skill install path overridden in
  `config.toml` is never emptied or refilled by an install. Accepted as a
  limitation; how configuration is handled across `bob init` and
  `install.sh` is tracked separately (issue #140).
- **Preserving local edits to installed skills.** Installed skills are
  release-owned content and are not a supported customisation point; local
  edits survive only by declining the install. A supported customisation
  point for email-triage categories is tracked separately (issue #139).
- **Comparing installed skill content.** All skills are embedded in the
  `bob` binary, so the binary stands in for the whole release; `install.sh`
  never compares skill files to decide whether to prompt or what to write.

## Architecture

### Design Principles

- Installing bob must never require root/sudo or write outside the current
  user's home directory — a decision this spec makes, consistent with (but
  not itself mandated by) ADR-008's single-user local deployment scope.
- The extension must land at exactly the path bob's own runtime resolver
  chooses with no `BOB_EXTENSION_PATH`/`extension_path` override set, using
  XDG Base Directory semantics for `XDG_DATA_HOME`: unset or empty uses the
  platform default (`~/.local/share/bob/extensions/bob.ts` on Linux per
  ADR-009, `~/Library/Application Support/bob/extensions/bob.ts` on macOS per
  ADR-009's macOS clause); a non-empty absolute value is honored as
  `$XDG_DATA_HOME/bob/extensions/bob.ts`; and a non-empty relative value is
  invalid configuration. `install.sh` and bob's runtime resolver must enforce
  the same three cases.
- `install.sh` writes the binary to `~/.local/bin`, the extension only to that
  resolved default location, and skills only to the default skill install
  path — the same path `bob init --skills-only` resolves from the environment
  — and does not read `config.toml`. Honoring a later
  `extension_path`/`BOB_EXTENSION_PATH` or `skill_install_path` override, if
  the operator sets one, is a post-install, operator-driven concern under
  S-003 and S-011 — not something `install.sh` resolves itself.
- The default skill install path belongs to bob alone and holds only the
  skills a bob release installs. Every install — upgrade, same-version
  reinstall, or fresh install — replaces it as a whole rather than merging
  into it, so it ends up holding exactly that release's skills; anything it
  held that the release does not ship is a leftover and is removed
  (ADR-017).
- Exactly one docs archive, one CLI-reference build, and one GitHub Release
  creation step exist per tagged release, regardless of how many platform
  binaries are built — adding platforms must not weaken S-007's existing
  release contract. Each job's `bob` build copies the manual's markdown into
  the binary's documentation skill (S-011, S-012); that is a plain file copy,
  not a docs or CLI-reference build, and does not count against this
  contract.
- Each platform's release asset must be fully self-contained and installable
  with no network access at install time.
- An install must never silently overwrite an existing install — the
  operator's explicit confirmation (interactively, or through `-y`) is
  required first. This covers installed skills as well as the binary: skills
  can exist at the default skill install path without a binary at
  `~/.local/bin/bob` (for example after a `mise` or Cargo install and a
  `bob init`). Declining leaves the local installation exactly as it was —
  no binary, extension, or skill is written. This all-or-nothing guarantee
  covers declining only; the write phase after confirmation is not
  transactional (Component 3).
- Every archive's filename must let an operator identify, without opening
  it, which release, operating system, and CPU architecture it targets.
- Adding a further platform later must require only a new build job and a
  new platform branch in `install.sh` — not a restructuring of the existing
  release job or the script's control flow.
- If the macOS build job fails, or its runner is unavailable, the release
  must fail fast as a whole rather than publish Linux-only assets — the
  Linux job's dependency on the macOS job's artifact makes this the natural
  behavior, and it matches S-007's existing no-partial-release precedent (a
  failed release job can be fixed and the tag re-run).

### System Diagram

```
                       git tag pushed
                             ↓
              ┌──────────────┴──────────────┐
              ↓                              ↓
  ┌────────────────────────┐   ┌──────────────────────────┐
  │ macOS build job (new)   │   │ Linux release job         │
  │                         │   │ (existing, extended)      │
  │ build bob macos-arm64   │   │ build bob linux-x86_64    │
  │ stage + zip install     │   │ build docs + CLI ref      │
  │  bundle (macos-arm64)   │   │ archive docs / extension /│
  │ upload as CI artifact   │   │  companion (unchanged,    │
  └────────────┬────────────┘   │  exactly one of each)     │
               │                │ stage + zip install       │
               │                │  bundle (linux-x86_64)    │
               │                │ download macOS job's zip  │
               │                │  artifact                 │
               │                │ ★ single GitHub Release   │
               │                │  step — all assets        │
               └───────────────→│  attached here             │
                                └─────────────┬──────────────┘
                                              ↓
                          GitHub Release assets: existing 4
                          (bob binary, docs, extension,
                          bob-companion) + 2 new install zips
                          the-intern-bob-install-<tag>-<os>-<arch>.zip
                                              ↓
                          ★ operator downloads the zip
                            matching their platform
                                              ↓
                            unzips, runs ./install.sh [-y]
                                              ↓
                     existing binary or installed skills?
                       → warn if needed, ★ prompt (or -y);
                         decline → abort, nothing written
                                              ↓
                     binary → ~/.local/bin/bob
                     extension → platform default if XDG_DATA_HOME is unset
                        or empty; otherwise absolute XDG_DATA_HOME/bob/...
                     skills → default skill install path emptied, then
                        refilled by the new binary's `init --skills-only`
                                              ↓
                            ready for `bob init` (S-012)
```

### Responsibility Separation

| Component | Responsibility | Notes |
|---|---|---|
| Linux release job (existing, extended) | Build the Linux `bob` binary, build the docs and CLI reference, produce the existing docs/extension/bob-companion archives, stage and zip the `linux-x86_64` install bundle, download the macOS job's install-bundle artifact, and run the single GitHub Release creation step | Unchanged responsibilities stay exactly as S-007/S-003 already assign them — this job is still the only one that builds docs or calls `action-gh-release` |
| macOS build job (new) | Build the macOS `bob` binary, stage and zip the `macos-arm64` install bundle, upload it as a CI build artifact | Runs on a separate (as yet unprovisioned) macOS-capable runner; does not build docs and never calls `action-gh-release` directly — S-007's self-hosted-runner requirement for docs/CLI-reference generation does not apply to this job. Its `bob` build copies the manual's markdown into the binary (S-012), which needs only the repository checkout and is not a docs build |
| Packaging step (per platform) | Stage a platform's binary with the shared extension, `install.sh`, and `README.txt`, then zip it with a tag+OS+arch name | Runs once in each job, producing exactly one zip per platform; mirrors the existing archive-and-attach pattern already in `deploy.yml` |
| `install.sh` | Place the binary and extension at their platform-default locations without sudo, then replace the default skill install path's contents with the release's skills via the just-installed binary; prompt before overwriting an existing binary or installed skills, with `-y` answering the prompt | Ships inside the zip; has no network dependency once downloaded; reads no configuration; never compares skill content |
| `README.txt` | Tell a first-time operator what is in the zip and how to run `install.sh`, including the overwrite prompt, its warnings, and `-y` | Plain text, zip-local; not a replacement for the mdBook docs |
| mdBook documentation (quickstart, operator guide, extension-author guide) | Present the zip+`install.sh` path as the primary "get bob running" route | Existing manual download/placement steps (including the current `sudo mv` instruction) get rewritten; the `bob init` step (S-012) is unchanged; the operator guide's upgrade guidance describes the whole-folder skill replacement (Component 5) |
| bob runtime extension resolver | Resolve the default extension path with the same XDG data-home policy as `install.sh` | Keeps a fresh install usable without `extension_path` overrides; rejects non-empty relative `XDG_DATA_HOME` values as invalid configuration instead of resolving them relative to the process cwd |

## Components

### Component 1: macOS build job

**Purpose:** Produce a release `bob` binary for macOS arm64 on every tag push, as a separate CI job from the existing Linux release job — not a matrix applied to it.
**Estimated size:** Medium — first macOS build in this project's CI. Runs on a GitHub-hosted `macos-14` runner (decided at Gate 1), alongside the existing self-hosted Linux runner — no accepted ADR requires self-hosted-only CI, so this introduces no architecture conflict.
**Interfaces:** Consumes the same `cargo build --release -p bob` contract already used for Linux; exposes a zipped macOS install bundle to the Linux release job as a CI build artifact. Does not build docs and does not call the GitHub Release creation step.

### Component 2: Per-platform packaging step

**Purpose:** Stage and zip the bob binary, the shared pi-agent extension, `install.sh`, and `README.txt` into one archive per platform, named with the release tag, OS, and architecture.
**Estimated size:** Small — extends the archive-and-attach pattern already used in `deploy.yml`, run once inside each of the two jobs.
**Interfaces:** Consumes each job's own built binary and the existing extension source; exposes one zip asset per platform, which the Linux release job collects (its own directly, the macOS one via artifact download) before the single GitHub Release step runs.

### Component 3: install.sh

**Purpose:** Install the bob binary and pi-agent extension to their default locations without sudo, using the same XDG data-home cases as bob's runtime extension resolver, replace the contents of the default skill install path with exactly the release's skills via the just-installed binary, and safely handle an existing install and an unsupported platform.
**Estimated size:** Medium — per-platform path resolution, existing-install detection over the binary and installed skills, binary comparison and warnings, interactive confirmation and `-y`, guarded emptying of the skill folder, clear unsupported-platform messaging, skill-install invocation.
**Interfaces:** Reads its own zip-local sibling files (the bob binary, `bob.ts`), an optional `-y` argument, and the `XDG_DATA_HOME` environment variable; writes to `~/.local/bin`, the resolved extension data path, and the default skill install path; rejects non-empty relative `XDG_DATA_HOME` before writing anything; probes `PATH` for `pi` and prompts on the terminal. Reads no configuration file (`config.toml`) and makes no network calls. Its contract:

- **Existing installation — prompt.** When a `bob` binary exists at `~/.local/bin/bob`, or the default skill install path holds any entry at all (not only skill-shaped directories), `install.sh` asks to overwrite before writing anything. This applies to a same-version reinstall too. Answering anything but yes aborts the whole install and leaves the local installation exactly as it was: no binary, extension, or skill is written.
- **Warnings before the prompt.** When the installed binary differs from the bundled one by byte comparison — a comparison that cannot complete counts as different — a warning says a different bob version is installed and that the installed skills (the documentation skill included) and the extension will be replaced and may differ from what is there now, including any local edits. When skills are installed but no binary is, a warning says the existing skills will be replaced. When the binaries are identical, the prompt is shown without a warning. Skill content is never compared: the binary stands in for the whole release.
- **Fresh install — no prompt.** With no binary at `~/.local/bin/bob` and an empty or absent default skill install path, `install.sh` installs without asking.
- **`-y`.** Answers yes to the overwrite prompt for unattended and scripted upgrades; warnings are still printed. Without `-y` and with no input available, `install.sh` aborts with no changes.
- **Write order and replacement.** After confirmation (or on a fresh install), `install.sh` writes the binary, then the extension, then empties the default skill install path and invokes the binary it just installed as `$install_binary_path init --skills-only` (S-012, CR-012) — never a `bob` resolved from `PATH` — which installs every embedded skill into the empty folder. Changed files, missing files, files a release no longer ships, and whole skills a release no longer ships are all handled the same way. This happens on every install, including a same-version reinstall.
- **Removal safety.** `install.sh` empties only the resolved default skill install path, and only when it resolves to a non-empty absolute path ending in `bob/skills`. It never follows a symbolic link out of that directory, and if `bob/skills` is itself a symbolic link it removes the link (or refuses to continue) rather than emptying the link's target. Both cases are covered by tests.
- **Write-phase failures.** If the skill step (emptying or the `--skills-only` invocation) fails, the binary and extension stay installed, `install.sh` prints a clearly visible warning that skills may be missing — sessions then start without them, and scheduled jobs that depend on them (email triage, for example) do nothing useful until the install is repaired — and exits 0, keeping CR-012's rule that a skill failure never fails an otherwise-successful binary install. The recovery is to rerun `install.sh`.
- **Paths and permissions.** The default skill install path is the one `bob init --skills-only` resolves from the environment alone, with the same `XDG_DATA_HOME` cases as the extension path (platform default when unset or empty, including `~/Library/Application Support/bob/skills` on macOS; `$XDG_DATA_HOME/bob/skills` when non-empty absolute; non-empty relative rejected before anything is written). `bob init` keeps writing it owner-only (ADR-014 §7, S-012). A `skill_install_path` override in `config.toml` is not followed and that location is never emptied or refilled.

### Component 4: README.txt

**Purpose:** Orient a first-time operator on what the zip contains and how to run `install.sh`, including when it prompts before overwriting an existing installation, the warnings it may print first, that every install replaces the installed skills as a whole, and the `-y` argument for unattended upgrades.
**Estimated size:** Small — static text.
**Interfaces:** None — plain-text reference shipped inside the zip.

### Component 5: mdBook documentation update

**Purpose:** Make the zip+`install.sh` path the primary "get bob running" route, replacing the manual download/`sudo mv`/manual-`cp` instructions everywhere they currently appear.
**Estimated size:** Small.
**Interfaces:** Edits `the-intern/docs/src/quickstart/index.md` and `the-intern/docs/src/operator-guide/index.md` (both currently describe the manual binary/extension placement this spec replaces), plus a pointer update in `the-intern/docs/src/extension-author-guide/index.md`; still hands off to the existing `bob init` step (S-012) unchanged. The operator guide's upgrade guidance states that the default skill install path is managed by `install.sh` and nothing else should be kept in it; that every install replaces the whole folder, so local edits and anything else placed there are lost on an install the operator confirms (or runs with `-y`); that a failed skill step can leave skills missing until `install.sh` is rerun; and, for non-zip upgrades (`mise`, Cargo), that refreshing the installed skills — the manual included — needs `bob init --skills-only --force`, and that pages or skills a release drops linger until the next `install.sh` run. The release notes of the release that first ships the whole-folder replacement call out the loss of local edits and of anything else kept in that folder.

### Component 6: bob runtime extension resolver

**Purpose:** Keep bob's default extension lookup aligned with `install.sh` so a bundle install is immediately usable without `extension_path` or `BOB_EXTENSION_PATH` overrides.
**Estimated size:** Small — one resolver policy change plus configuration/resolver test coverage.
**Interfaces:** Reads `XDG_DATA_HOME` during bob configuration load. If `XDG_DATA_HOME` is unset or empty, resolves the extension default to the platform data directory. If it is non-empty and absolute, resolves the extension default under that directory. If it is non-empty and relative, fails configuration load with a clear error naming `XDG_DATA_HOME`. Explicit `extension_path` configuration remains the existing operator override path and is not changed by this component.

## Workflow

```
Tag pushed
  ↓
deploy.yml triggers two jobs: the existing Linux release job, and a new macOS build job
  ↓
[macOS job] Build bob release binary for macos-arm64
  ↓
[macOS job] Stage binary + bob.ts + install.sh + README.txt; zip as
            the-intern-bob-install-<tag>-macos-arm64.zip; upload as a CI build artifact
  ↓
[Linux job] Build bob release binary for linux-x86_64 (existing, unchanged)
  ↓
[Linux job] Build docs + CLI reference; produce the docs, extension, and
            bob-companion archives (existing, unchanged — exactly one of each)
  ↓
[Linux job] Stage binary + bob.ts + install.sh + README.txt; zip as
            the-intern-bob-install-<tag>-linux-x86_64.zip
  ↓
[Linux job] Download the macOS job's install-bundle artifact
  ↓
★ [Linux job] Create the GitHub Release (single, unchanged action-gh-release step)
              attaching all six assets: the existing four plus the two new install zips
  ↓
★ Operator downloads the zip matching their platform from the release page
  ↓
Operator unzips and runs ./install.sh (optionally with -y)
  ↓
install.sh detects OS/arch; if unsupported, prints a clear error and exits — no partial install
  ↓
If XDG_DATA_HOME is non-empty relative, install.sh exits non-zero before writing.
  ↓
install.sh checks ~/.local/bin/bob and the default skill install path for an
existing installation (a binary, or any entry at all in that path)
  ↓
If the installed binary differs from the bundled one (or the comparison cannot
complete), warn that a different version is installed and that the skills
(documentation skill included) and extension will be replaced; if skills are
installed without a binary, warn that they will be replaced
  ↓
★ If an existing installation is found, install.sh prompts for confirmation
  before overwriting (-y answers yes); anything but yes, or no input available
  without -y, aborts with nothing written. A fresh install is not prompted.
  ↓
Binary copied to ~/.local/bin (created if missing) and marked executable
  ↓
Extension copied to the platform default when XDG_DATA_HOME is unset or empty,
or to $XDG_DATA_HOME/bob/extensions/bob.ts when XDG_DATA_HOME is non-empty absolute.
  ↓
install.sh empties the default skill install path (removal-safety rules,
Component 3), then invokes the just-installed binary's `init --skills-only`,
which installs every embedded skill into the empty folder (S-012, CR-012).
A failure here leaves the binary and extension installed, prints a warning
that skills may be missing until install.sh is rerun, and does not fail the
install (exit status stays 0)
  ↓
install.sh reports what it did and warns if pi is not found on PATH
  ↓
Operator proceeds to `bob init <workspace>` (S-012, unchanged)
```

## Configuration Requirements

- **What:** the install target directory for the bob binary. **Why:** must
  be writable without elevated privileges, matching the single-user local
  deployment scope (ADR-008). **Where it lives:** a fixed user-local
  default (`~/.local/bin`) inside `install.sh` — no config file or CI
  variable involved. **Constraints:** must be a directory that is ordinarily
  already on a typical Linux/macOS user's `PATH`; if it is not,
  `install.sh` must tell the operator so. **Default behavior when missing:**
  `install.sh` creates the directory if it does not already exist.

- **What:** the pi-agent extension's install path. **Why:** must match the
  exact path bob's own runtime resolver chooses with no
  `BOB_EXTENSION_PATH`/`extension_path` override set, or bob fails to find
  the extension without extra configuration.
  **Where it lives:** the platform default when `XDG_DATA_HOME` is unset or
  empty — `~/.local/share/bob/extensions/bob.ts` on Linux (ADR-009),
  `~/Library/Application Support/bob/extensions/bob.ts` on macOS (ADR-009's
  macOS clause, also documented in the quickstart and operator guide) — or
  `$XDG_DATA_HOME/bob/extensions/bob.ts` when `XDG_DATA_HOME` is non-empty
  and absolute. **Constraints:** a non-empty relative `XDG_DATA_HOME` is an
  invalid configuration and `install.sh` must exit non-zero before modifying
  the filesystem; `install.sh` must not normalize relative values under
  `HOME`. `install.sh` must not read `config.toml` or otherwise attempt to
  honor an `extension_path` override itself — that remains a post-install,
  operator-driven concern under S-003. **Default behavior when missing:**
  unset or empty `XDG_DATA_HOME` uses the platform default, and `install.sh`
  creates the parent directory if it does not already exist.

- **What:** bob's runtime default extension resolver. **Why:** a bundle
  install only works without extra configuration when bob resolves the same
  default extension path that `install.sh` writes. **Where it lives:** bob's
  configuration load path, not the install script. **Constraints:** the
  resolver follows the same three `XDG_DATA_HOME` cases as the installer:
  unset or empty uses the platform default; non-empty absolute is honored; and
  non-empty relative fails configuration load with a clear error naming
  `XDG_DATA_HOME`. Explicit `extension_path` configuration remains the
  existing override mechanism and is not changed by this spec. **Default
  behavior when missing:** unset or empty `XDG_DATA_HOME` resolves to the
  platform default.

- **What:** the release asset naming convention. **Why:** an operator must
  be able to identify the correct download for their machine without
  opening it. **Where it lives:** the GitHub Release asset filename itself
  — no config file. **Constraints (Contract):** each new install-bundle
  archive name must include the release tag, the OS, and the CPU
  architecture, e.g. `the-intern-bob-install-<tag>-linux-x86_64.zip` and
  `the-intern-bob-install-<tag>-macos-arm64.zip`. The four existing release
  assets (the bare `bob` binary, the docs archive, the `bob-extension`
  tarball, and the `bob-companion` tarball) keep their current naming and
  are not renamed by this spec — the bare `bob` binary in particular stays
  implicitly Linux x86_64-only and unlabeled by OS/arch, exactly as today.
  **Default behavior when missing:** not applicable — the workflow always
  produces one correctly-named install-bundle archive per supported
  platform on every tag push.

- **What:** the skill folder replacement `install.sh` performs after
  installing the binary and extension. **Why:** every install of a bob
  release must leave the default skill install path holding exactly that
  release's skills — the documentation skill, which must describe the
  installed version, and the other skills, whose policy prose is tied to the
  same release's command surface — without a separate manual step; a merge
  into the existing folder would leave changed files stale and leftovers
  loadable (ADR-017). **Where it lives:** a runtime step inside `install.sh`
  that empties the default skill install path and then invokes `bob init
  --skills-only` (S-012) on the binary it just wrote — not a config value.
  **Constraints:** the path is the one `--skills-only` resolves from the
  environment alone (same `XDG_DATA_HOME` cases as the extension path,
  including the macOS default); a `skill_install_path` override in
  `config.toml` is not followed. Emptying is subject to the removal-safety
  rules in Component 3 (non-empty absolute path ending in `bob/skills`; no
  symbolic link followed out of it; a symbolic link at `bob/skills` itself
  is removed or the step refuses, never its target emptied). Operator edits
  to installed skills are not preserved — they survive only by declining
  the install. Failure is non-blocking: it must never undo the binary or
  extension or fail the install (exit 0), matching the `pi`-presence check's
  existing pattern and CR-012, and it prints a warning that skills may be
  missing until `install.sh` is rerun. **Default behavior when missing:**
  not applicable — `install.sh` always performs this step on every install
  it does not abort.

- **What:** the `-y` argument to `install.sh`. **Why:** scripted and
  unattended upgrades need a supported way to answer the overwrite prompt
  instead of piping input into the script. **Where it lives:** a
  command-line argument to `install.sh` — no config file or environment
  variable. **Constraints:** answers yes to the single overwrite prompt
  only; the warnings that precede the prompt are still printed. It is the
  only unattended route. **Default behavior when missing:** an existing
  installation is prompted for interactively; with no input available, the
  install aborts with no changes.

- **What:** the `pi` prerequisite check inside `install.sh`. **Why:** bob is
  unusable without `pi` on `PATH`, and the operator should learn this
  immediately — but `install.sh` must never install or substitute `pi`
  itself (hard, pre-existing project rule). **Where it lives:** a runtime
  check inside `install.sh`, not a config value. **Constraints:**
  informational only — must never block or fail the install if `pi` is
  absent. **Default behavior when missing:** print a clear warning pointing
  at the `pi` install guide already referenced in the quickstart, and
  continue.

## Implementation Order

| Phase | What | Depends On |
|---|---|---|
| 1 | Add the new macOS build job (separate from the existing Linux release job) producing a macOS arm64 `bob` binary on every tag push, on a GitHub-hosted `macos-14` runner | Nothing |
| 2 | Write `install.sh` and `README.txt`: XDG data-home extension-path resolution, existing-install detection and confirmation prompt, unsupported-platform handling, `pi` presence check | Nothing (can proceed in parallel with Phase 1) |
| 3 | Align bob's runtime default extension resolver with the installer's XDG data-home policy and add configuration/resolver test coverage | Nothing (can proceed in parallel with Phases 1 and 2) |
| 4 | Add the per-platform packaging step to both jobs (staging, zip, tag+OS+arch naming); have the macOS job upload its zip as a build artifact; have the Linux job download it and attach both new zips, unchanged alongside the existing four assets, in its single GitHub Release step | Phases 1 and 2 |
| 5 | Update the mdBook quickstart and operator guide (and the extension-author guide pointer) to lead with the zip+`install.sh` path | Phases 3 and 4 |
| 6 | (CR-016) Extend `install.sh`'s existing-install prompt to installed skills, add the binary comparison and its warnings and the `-y` argument, and replace the default skill install path as a whole on every install with the removal-safety and write-phase failure contracts; update `README.txt` and the operator guide's upgrade guidance to match | Phases 2 and 5 |

## Amendment Log

<!-- Optional. Use when an approved spec is amended after tasks are in flight.
| Date | What changed | Why | Affected tasks |
|------|-------------|-----|----------------|
| YYYY-MM-DD | Description of change | Reason for amendment | T-XXX, T-YYY |
-->
| 2026-08-15 | Replaced the prior literal "`XDG_DATA_HOME` is set" extension-path rule with XDG Base Directory semantics for both `install.sh` and bob's runtime resolver: unset or empty uses the platform default, non-empty absolute is honored, and non-empty relative is invalid. Added Component 6 for runtime resolver alignment and made the documentation phase wait for that behavior. | CR-008 / Architect consistency review PASS. The old rule made empty `XDG_DATA_HOME` resolve to `bob/extensions/bob.ts`, colliding with the bundle's sibling `./bob` executable; HOME-normalizing relative values made install/runtime lookup diverge. | T-170, T-173, T-174 |
| 2026-09-14 | `install.sh` (Component 3) now invokes the just-installed binary as `bob init --skills-only` immediately after the binary replace step, refreshing the shared skill package; failure is non-blocking. The Exclusions section's `bob init` bullet is narrowed to carve out this one invocation, which touches neither a workspace nor `config.toml`. | CR-012 / Architect consistency review PASS, driven by issue #55: a zip-based upgrade should pick up a newer release's skill without a separate manual step. | T-201 |
| 2026-10-13 | `install.sh` now replaces the default skill install path as a whole on every install: after writing the binary and extension it empties that path (under explicit removal-safety rules) and runs the just-installed binary's `init --skills-only` into the empty folder. CR-012's "never passes `--force`" / edits-preserved outcome is superseded for installs through `install.sh`. The never-silently-overwrite principle is extended to installed skills: the prompt appears when a binary exists or the default skill install path holds any entry, declining writes nothing, and a different installed binary (byte comparison; incomplete comparison counts as different) or skills without a binary trigger a warning first; skill content is never compared. The "Unattended/non-interactive install" exclusion is withdrawn in favour of a new `-y` argument, the only unattended route. Write-phase failure contract: binary and extension stay, a warning says skills may be missing, exit 0, recovery is rerunning `install.sh`. New exclusions record that a configured `skill_install_path` override is not followed (issue #140), local skill edits are not a customisation point (issue #139), and skill content is not compared. The `bob init` exception is reworded, and Design Principles, System Diagram, Responsibility rows (`install.sh`, `README.txt`, macOS job, mdBook docs), Components 3–5, Workflow, Configuration Requirements, and a new Phase 6 follow. The macOS job's `bob` build copying manual markdown is recorded as not a docs build. Bundle contents and release assets are unchanged. | CR-016 (issue #138) / ADR-017 (CR-016). The skills embedded in the binary — now including the manual as a skill — must match the installed release; the non-destructive refresh left installed skills silently stale after the first upgrade. | Tasks TBD (CR-016 breakdown) |
