---
id: CR-008
title: Align install bundle with XDG data-home semantics
status: applied
created: '2026-08-15'
---

# Align install bundle with XDG data-home semantics

> **Applied (2026-08-15):** Architect consistency review passed with direction to amend
> S-013, amend blocked T-170, and create a distinct runtime resolver task. S-013 was
> amended to version 0.2; T-170 was revised to use the three explicit XDG data-home cases;
> and T-174 was created for bob's runtime default extension resolver and configuration test
> coverage. T-173 now depends on T-174 before user-facing installation docs are finalized.

## Desired Changes

Amend S-013 Component 3 and T-170 so `install.sh` follows the XDG Base Directory
Specification for `XDG_DATA_HOME`:

- When `XDG_DATA_HOME` is unset or empty, use the existing platform default extension
  path (`~/.local/share/bob/extensions/bob.ts` on Linux and
  `~/Library/Application Support/bob/extensions/bob.ts` on macOS).
- When `XDG_DATA_HOME` is non-empty and absolute, install to
  `$XDG_DATA_HOME/bob/extensions/bob.ts`.
- When `XDG_DATA_HOME` is non-empty and relative, print a clear error and exit non-zero
  before modifying the filesystem.

Remove the current requirement that an empty-but-present variable is treated differently
from an unset variable or that the installer reproduce bob's current literal resolver
behavior for relative values. The installer must not normalize relative values under HOME.

Apply the same policy to bob's runtime extension-path resolver: unset or empty resolves to
the platform default; a non-empty absolute value is honored; and a non-empty relative value
is rejected as invalid configuration. This keeps installation and runtime lookup consistent.

## Context

The current S-013/T-170 wording requires a literal reproduction of bob's resolver, including
an empty `XDG_DATA_HOME`. That yields the relative target `bob/extensions/bob.ts`. Because
the install bundle is run from a directory containing the sibling executable `./bob`, that
target cannot be created. An attempted HOME normalization made installation work but caused
installer/runtime lookup divergence.

The XDG Base Directory Specification defines the default as `$HOME/.local/share` when
`XDG_DATA_HOME` is unset or empty and requires environment-supplied XDG paths to be absolute.
The requested amendment adopts that standard behavior for the installer.

## Potential Impact

Affected artifacts:

- `docs/ai-team/specs/S-013-cross-platform-bob-install-bundle-release-packaging.md`
- `docs/ai-team/tasks/blocked/T-170-write-install-sh-for-the-bob-install-bundle.md`
- `the-intern/install-bundle/install.sh`
- T-172 and T-173, which depend directly or indirectly on T-170

The current task-branch implementation must be revised after the task is resumed: remove
its HOME anchoring behavior, default the empty case, and reject non-empty relative values.
This changes installer behavior but aligns it with the XDG specification. Bob's existing
runtime resolver still treats empty and relative values literally and must be changed as part
of this amendment. That change affects configuration validation and its tests, and should be
planned as a separate implementation task from the install script.

## Possible Spec Amendments

S-013 Component 3 and its Configuration Requirements must replace the current
empty-is-set/literal-resolver rule with the three explicit XDG cases above. T-170 must then
be amended with matching acceptance criteria and verification for unset, empty, absolute,
and non-empty relative values. The amended spec must also require bob's runtime resolver to
enforce the same cases; the Planner must create a distinct runtime-resolver implementation
task with configuration and resolver test coverage.
