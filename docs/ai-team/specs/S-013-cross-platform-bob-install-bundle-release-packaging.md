---
title: Cross-platform bob install bundle release packaging
version: '0.2'
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

- **`bob init` / workspace scaffolding.** Owned by S-012. This spec ends at
  "bob is installed, on `PATH`, and the extension is in place" — it does not
  create or touch any workspace. This handoff is only correct because
  `bob init`'s generated `config.toml` does not set `extension_path`, so bob
  keeps resolving the extension at the location `install.sh` wrote; this
  spec assumes that invariant and does not modify S-012's config generation.
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
- **Unattended/non-interactive install.** `install.sh`'s overwrite
  confirmation is interactive-only in this version; a `--yes`-style flag for
  scripted/CI use is out of scope.

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
- `install.sh` writes only to that resolved default location and does not
  read `config.toml`. Honoring a later `extension_path`/`BOB_EXTENSION_PATH`
  override, if the operator sets one, is a post-install, operator-driven
  concern under S-003 — not something `install.sh` resolves itself.
- Exactly one docs archive, one CLI-reference build, and one GitHub Release
  creation step exist per tagged release, regardless of how many platform
  binaries are built — adding platforms must not weaken S-007's existing
  release contract.
- Each platform's release asset must be fully self-contained and installable
  with no network access at install time.
- An install must never silently overwrite an existing install — the
  operator's explicit confirmation is required first.
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
                            unzips, runs ./install.sh
                                              ↓
                     binary → ~/.local/bin/bob
                     extension → platform default if XDG_DATA_HOME is unset
                        or empty; otherwise absolute XDG_DATA_HOME/bob/...
                                              ↓
                            ready for `bob init` (S-012)
```

### Responsibility Separation

| Component | Responsibility | Notes |
|---|---|---|
| Linux release job (existing, extended) | Build the Linux `bob` binary, build the docs and CLI reference, produce the existing docs/extension/bob-companion archives, stage and zip the `linux-x86_64` install bundle, download the macOS job's install-bundle artifact, and run the single GitHub Release creation step | Unchanged responsibilities stay exactly as S-007/S-003 already assign them — this job is still the only one that builds docs or calls `action-gh-release` |
| macOS build job (new) | Build the macOS `bob` binary, stage and zip the `macos-arm64` install bundle, upload it as a CI build artifact | Runs on a separate (as yet unprovisioned) macOS-capable runner; does not build docs and never calls `action-gh-release` directly — S-007's self-hosted-runner requirement for docs/CLI-reference generation does not apply to this job |
| Packaging step (per platform) | Stage a platform's binary with the shared extension, `install.sh`, and `README.txt`, then zip it with a tag+OS+arch name | Runs once in each job, producing exactly one zip per platform; mirrors the existing archive-and-attach pattern already in `deploy.yml` |
| `install.sh` | Place the binary and extension at their platform-default locations without sudo, prompting before overwriting an existing install | Ships inside the zip; has no network dependency once downloaded; reads no configuration |
| `README.txt` | Tell a first-time operator what is in the zip and how to run `install.sh` | Plain text, zip-local; not a replacement for the mdBook docs |
| mdBook documentation (quickstart, operator guide, extension-author guide) | Present the zip+`install.sh` path as the primary "get bob running" route | Existing manual download/placement steps (including the current `sudo mv` instruction) get rewritten; the `bob init` step (S-012) is unchanged |
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

**Purpose:** Install the bob binary and pi-agent extension to their default locations without sudo, using the same XDG data-home cases as bob's runtime extension resolver, and safely handling an existing install and an unsupported platform.
**Estimated size:** Medium — per-platform path resolution, existing-install detection, interactive confirmation, clear unsupported-platform messaging.
**Interfaces:** Reads its own zip-local sibling files (the bob binary, `bob.ts`) and the `XDG_DATA_HOME` environment variable; writes to `~/.local/bin` and the resolved extension data path; rejects non-empty relative `XDG_DATA_HOME` before writing anything; probes `PATH` for `pi` and prompts on the terminal. Reads no configuration file (`config.toml`) and makes no network calls.

### Component 4: README.txt

**Purpose:** Orient a first-time operator on what the zip contains and how to run `install.sh`.
**Estimated size:** Small — static text.
**Interfaces:** None — plain-text reference shipped inside the zip.

### Component 5: mdBook documentation update

**Purpose:** Make the zip+`install.sh` path the primary "get bob running" route, replacing the manual download/`sudo mv`/manual-`cp` instructions everywhere they currently appear.
**Estimated size:** Small.
**Interfaces:** Edits `the-intern/docs/src/quickstart/index.md` and `the-intern/docs/src/operator-guide/index.md` (both currently describe the manual binary/extension placement this spec replaces), plus a pointer update in `the-intern/docs/src/extension-author-guide/index.md`; still hands off to the existing `bob init` step (S-012) unchanged.

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
Operator unzips and runs ./install.sh
  ↓
install.sh detects OS/arch; if unsupported, prints a clear error and exits — no partial install
  ↓
install.sh checks ~/.local/bin/bob for an existing install
  ↓
★ If an existing install is found, install.sh prompts for confirmation before overwriting
  ↓
Binary copied to ~/.local/bin (created if missing) and marked executable
  ↓
Extension copied to the platform default when XDG_DATA_HOME is unset or empty,
or to $XDG_DATA_HOME/bob/extensions/bob.ts when XDG_DATA_HOME is non-empty absolute.
If XDG_DATA_HOME is non-empty relative, install.sh exits non-zero before writing.
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

## Amendment Log

<!-- Optional. Use when an approved spec is amended after tasks are in flight.
| Date | What changed | Why | Affected tasks |
|------|-------------|-----|----------------|
| YYYY-MM-DD | Description of change | Reason for amendment | T-XXX, T-YYY |
-->
| 2026-08-15 | Replaced the prior literal "`XDG_DATA_HOME` is set" extension-path rule with XDG Base Directory semantics for both `install.sh` and bob's runtime resolver: unset or empty uses the platform default, non-empty absolute is honored, and non-empty relative is invalid. Added Component 6 for runtime resolver alignment and made the documentation phase wait for that behavior. | CR-008 / Architect consistency review PASS. The old rule made empty `XDG_DATA_HOME` resolve to `bob/extensions/bob.ts`, colliding with the bundle's sibling `./bob` executable; HOME-normalizing relative values made install/runtime lookup diverge. | T-170, T-173, T-174 |
