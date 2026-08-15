---
id: CR-008
title: Align install bundle with XDG data-home semantics
status: pending
created: '2026-08-15'
---

# Align install bundle with XDG data-home semantics

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
runtime resolver still treats empty and relative values literally; a separate follow-up may
be needed if runtime behavior must be made fully consistent with this installer rule.

## Possible Spec Amendments

S-013 Component 3 and its Configuration Requirements must replace the current
empty-is-set/literal-resolver rule with the three explicit XDG cases above. T-170 must then
be amended with matching acceptance criteria and verification for unset, empty, absolute,
and non-empty relative values.
