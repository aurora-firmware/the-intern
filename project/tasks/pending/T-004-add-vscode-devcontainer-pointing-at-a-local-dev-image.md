---
id: T-004
title: Add VSCode devcontainer pointing at a local dev image
status: pending
priority: medium
assigned-role: unassigned
created: '2026-05-15'
---

# Add VSCode devcontainer pointing at a local dev image

## Description

Add a `.devcontainer/devcontainer.json` so VSCode opens the repo inside a
pre-built local image that already carries the Rust + Node + pi-agent
toolchain. We are NOT building the image in this task — we reference a
locally available image.

Image reference: one of `localhost/rust_dev` or `localhost/aurorafw_dev`
(exact name still to be confirmed by the developer working the task — pick
whichever is actually present locally and record the choice in the Work Log).

The devcontainer config should:
- Use `image:` (not `build:` or `dockerComposeFile:`) so we depend on the
  already-built local image.
- Mount the repo at the default workspace path.
- Set `remoteUser` to a non-root user if the chosen image provides one;
  otherwise leave it at the image default.
- Pin runtimes only to a major version family if the image itself exposes a
  choice (e.g. Node 22, Rust stable) — do not pin patch versions.

Out of scope (explicit): no specific patch-version pinning of Rust or Node,
no GitHub Codespaces-specific config (`hostRequirements`, prebuilds, machine
sizes), and no host-side install scripts (`scripts/setup.sh`, bootstrappers).
The image itself is built and maintained outside this repo.

## Acceptance Criteria

AC-1: The system shall provide `.devcontainer/devcontainer.json` that VSCode recognises as a valid devcontainer.
AC-2: The devcontainer configuration shall reference a local image via the `image` key (one of `localhost/rust_dev` or `localhost/aurorafw_dev`), and shall NOT use `build` or `dockerComposeFile`.
AC-3: The system shall NOT pin Rust or Node to a specific patch version anywhere in `.devcontainer/`.
AC-4: The system shall NOT include any GitHub Codespaces-specific keys (`hostRequirements`, prebuild config, machine-type hints) in `.devcontainer/devcontainer.json`.
AC-5: The system shall NOT introduce host-side setup scripts (no new files under `scripts/`, no top-level `setup.sh` / `bootstrap.sh`).

## Dependencies

- None

## Files to Touch

- `.devcontainer/devcontainer.json` — new

## Verification

```bash
test -f .devcontainer/devcontainer.json

# Valid JSON (allow // and /* */ comments — devcontainer.json is JSONC)
node -e "const fs=require('fs');const s=fs.readFileSync('.devcontainer/devcontainer.json','utf8').replace(/\/\*[\s\S]*?\*\//g,'').replace(/^\s*\/\/.*$/gm,'');JSON.parse(s)"

# References a local image, not a build or compose file
grep -q '"image"' .devcontainer/devcontainer.json
grep -qE 'localhost/(rust_dev|aurorafw_dev)' .devcontainer/devcontainer.json
! grep -qE '"build"|"dockerComposeFile"' .devcontainer/devcontainer.json

# No Codespaces-specific keys
! grep -qE '"hostRequirements"|"prebuild"' .devcontainer/devcontainer.json

# No host-side setup script introduced
! test -f scripts/setup.sh
! test -f setup.sh
```

## Work Log

## Review
