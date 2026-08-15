---
title: Cross-platform bob install bundle release packaging
version: '0.1'
status: draft  # draft | review | approved | superseded
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
  create or touch any workspace.
- **Installing or managing the `pi` prerequisite.** `install.sh` may check
  and report whether `pi` is on `PATH`, but must never substitute a mock or
  wrapper for it — this is a hard, pre-existing project rule (see root
  `CLAUDE.md`/`README.md` "Runtime prerequisites").
- **Removing or replacing the existing standalone `bob` binary and
  `bob-extension` tarball release assets.** This work is additive only —
  both existing assets keep shipping unchanged for consumers that already
  depend on them.
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
  user's home directory (single-user local deployment scope, ADR-008).
- The extension must land at exactly the path bob's own runtime already
  resolves by default on each platform — no additional configuration step
  may be required afterward (ADR-009's resolution logic is the source of
  truth, not a value install.sh invents independently).
- Each platform's release asset must be fully self-contained and installable
  with no network access at install time.
- An install must never silently overwrite an existing install — the
  operator's explicit confirmation is required first.
- Every archive's filename must let an operator identify, without opening
  it, which release, operating system, and CPU architecture it targets.
- Adding a further platform later must require only a new build target and
  a new platform branch in `install.sh` — not a restructuring of the
  packaging step or the script's control flow.

### System Diagram

```
                    git tag pushed
                          ↓
              deploy.yml release job triggers
                          ↓
        ┌─────────────────────────────────────┐
        │   Per-platform build matrix          │
        │   linux-x86_64  |  macos-arm64       │
        └───────────────────┬───────────────────┘
                          ↓
        ┌─────────────────────────────────────┐
        │   Stage per platform:                │
        │   bob binary + bob.ts + install.sh   │
        │   + README.txt                       │
        └───────────────────┬───────────────────┘
                          ↓
        zip named the-intern-bob-install-
              <tag>-<os>-<arch>.zip
                          ↓
        ┌─────────────────────────────────────┐
        │   GitHub Release assets              │
        │   (existing binary/docs/extension    │
        │    assets unchanged, additive)        │
        └───────────────────┬───────────────────┘
                          ↓
              ★ operator downloads the zip
                matching their platform
                          ↓
              unzips, runs ./install.sh
                          ↓
        binary → ~/.local/bin/bob
        extension → platform default data path
                (ADR-009 / macOS equivalent)
                          ↓
              ready for `bob init` (S-012)
```

### Responsibility Separation

| Component | Responsibility | Notes |
|---|---|---|
| Release workflow build matrix | Produce a `bob` release binary for each supported platform/architecture on every tag push | Extends the existing single-target build; `linux-x86_64` keeps building on the current runner, `macos-arm64` is a new build target |
| Packaging step | Stage each platform's binary with the shared extension, install script, and readme, then zip it with a tag+OS+arch name | Runs once per platform after that platform's binary is built; mirrors the existing docs/extension archive-and-attach pattern already in `deploy.yml` |
| `install.sh` | Place the binary and extension at their platform-default locations without sudo, prompting before overwriting an existing install | Ships inside the zip; has no network dependency once downloaded |
| `README.txt` | Tell a first-time operator what is in the zip and how to run `install.sh` | Plain text, zip-local; not a replacement for the mdBook quickstart |
| mdBook quickstart | Present the zip+`install.sh` path as the primary "get bob running" route | Existing manual download/placement steps get rewritten; the `bob init` step (S-012) is unchanged |

## Components

### Component 1: macOS build target

**Purpose:** Produce a release `bob` binary for macOS arm64 on every tag push, alongside the existing Linux x86_64 build.
**Estimated size:** Medium — first macOS build in this project's CI, needs a new build target/runner.
**Interfaces:** Consumes the same `cargo build --release -p bob` contract already used for Linux; exposes a macOS arm64 binary artifact to the packaging step.

### Component 2: Per-platform packaging step

**Purpose:** Stage and zip the bob binary, the shared pi-agent extension, `install.sh`, and `README.txt` into one archive per platform, named with the release tag, OS, and architecture.
**Estimated size:** Small — extends the archive-and-attach pattern already used twice in `deploy.yml`.
**Interfaces:** Consumes each platform's built binary and the existing extension source; exposes one zip asset per platform to the GitHub Release step.

### Component 3: install.sh

**Purpose:** Install the bob binary and pi-agent extension to their platform-default locations without sudo, safely handling an existing install and an unsupported platform.
**Estimated size:** Medium — per-platform path resolution, existing-install detection, interactive confirmation, clear unsupported-platform messaging.
**Interfaces:** Reads its own zip-local sibling files (the bob binary, `bob.ts`); writes to `~/.local/bin` and the platform's default extension data path; no other interfaces.

### Component 4: README.txt

**Purpose:** Orient a first-time operator on what the zip contains and how to run `install.sh`.
**Estimated size:** Small — static text.
**Interfaces:** None — plain-text reference shipped inside the zip.

### Component 5: Quickstart documentation update

**Purpose:** Make the zip+`install.sh` path the primary "get bob running" route in the mdBook quickstart.
**Estimated size:** Small.
**Interfaces:** Edits `the-intern/docs/src/quickstart/index.md`; still hands off to the existing `bob init` step (S-012) unchanged.

## Workflow

```
Tag pushed
  ↓
deploy.yml release job triggers
  ↓
Build bob release binary — linux-x86_64 (existing) and macos-arm64 (new)
  ↓
For each platform: stage binary + bob.ts extension + install.sh + README.txt
  ↓
Zip each platform's staging dir as the-intern-bob-install-<tag>-<os>-<arch>.zip
  ↓
Attach both new zips to the GitHub Release, alongside the existing
binary/docs/extension assets (unchanged)
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
Extension copied to the platform's default extension data path (created if missing)
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
  exact default bob's own runtime already resolves (ADR-009 on Linux; the
  macOS Application Support equivalent already documented in the
  quickstart), or bob fails to find the extension without extra
  configuration. **Where it lives:** the platform-default data directory,
  following the same resolution precedence bob's own runtime already uses
  (including its existing `BOB_EXTENSION_PATH`-style override) —
  `install.sh` must not invent a different default. **Constraints:** must
  match bob's own resolution logic exactly, so a later manual override still
  works unmodified. **Default behavior when missing:** `install.sh` creates
  the parent directory if it does not already exist.

- **What:** the release asset naming convention. **Why:** an operator must
  be able to identify the correct download for their machine without
  opening it. **Where it lives:** the GitHub Release asset filename itself
  — no config file. **Constraints (Contract):** each archive name must
  include the release tag, the OS, and the CPU architecture, e.g.
  `the-intern-bob-install-<tag>-linux-x86_64.zip` and
  `the-intern-bob-install-<tag>-macos-arm64.zip`. **Default behavior when
  missing:** not applicable — the workflow always produces one
  correctly-named archive per supported platform on every tag push.

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
| 1 | Add the macOS arm64 build target to the release workflow, producing a macOS `bob` binary on every tag push | Nothing |
| 2 | Add the per-platform packaging step (staging, zip, tag+OS+arch naming) and attach the resulting zips as new release assets, for both `linux-x86_64` (using the existing binary) and `macos-arm64` (using Phase 1's output) | Phase 1 |
| 3 | Write `install.sh` and `README.txt`: path resolution, existing-install detection and confirmation prompt, unsupported-platform handling, `pi` presence check | Phase 2 (needs the final staging layout to test against) |
| 4 | Update the mdBook quickstart to lead with the zip+`install.sh` path | Phase 3 |

## Amendment Log

<!-- Optional. Use when an approved spec is amended after tasks are in flight.
| Date | What changed | Why | Affected tasks |
|------|-------------|-----|----------------|
| YYYY-MM-DD | Description of change | Reason for amendment | T-XXX, T-YYY |
-->
