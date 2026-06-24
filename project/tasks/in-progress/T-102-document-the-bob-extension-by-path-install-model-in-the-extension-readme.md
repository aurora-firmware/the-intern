---
id: T-102
title: Document the bob extension by-path install model in the extension README
status: pending
priority: medium
assigned-role: developer
created: '2026-06-23'
spec: CR-003
---

# Document the bob extension by-path install model in the extension README

## Description

Per CR-003 and the amended S-003, update `the-intern/extensions/README.md` to
replace the manual "install `bob.ts` into pi's search path" guidance with the new
model: bob resolves the extension at `$XDG_DATA_HOME/bob/extensions/bob.ts`
(override `config.toml` `extension_path`), passes it to pi via `pi --extension`,
and fails closed if the file is missing. Keep the env-var contract section
(`BOB_SESSION_ID`, `BOB_EXTENSION_SOCK_PATH`). Remove the `~/.pi/agent/extensions/`
and `<project>/.pi/extensions/` directories as the bob install mechanism.

## Acceptance Criteria

AC-1: The system shall document the default extension location
      `~/.local/share/bob/extensions/bob.ts` and the `extension_path` override.

AC-2: The system shall document that bob passes the extension via
      `pi --extension` and fails closed when the file is missing.

AC-3: WHEN the README is read THE SYSTEM SHALL no longer present installing the
      extension into pi's own search path as the bob mechanism.

## Dependencies

- None (documentation reflecting T-100 / T-101 behaviour; can be authored in
  parallel).

## Files to Touch

- `the-intern/extensions/README.md` — rewrite the install-path guidance.

## Verification

```bash
grep -q "extension_path" the-intern/extensions/README.md \
  && grep -q "local/share/bob/extensions" the-intern/extensions/README.md \
  && grep -q -- "--extension" the-intern/extensions/README.md
```

## Work Log

<!-- Mandatory. Append one entry per session boundary. -->

## Review

<!-- Reviewer: append verdict here after each review cycle. -->
