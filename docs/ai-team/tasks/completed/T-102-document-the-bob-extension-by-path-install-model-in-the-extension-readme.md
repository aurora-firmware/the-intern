---
id: T-102
title: Document the bob extension by-path install model in the extension README
status: completed
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

### Session 1 — 2026-06-24

Read the task file and the existing `the-intern/extensions/README.md`. Read T-100
and T-101 completed task files for context, then read the actual source code —
`crates/bob/src/config.rs` (for `extension_path`, `default_extension_path_for_env`,
and the TOML key name) and `crates/pi-agent-supervisor/src/process.rs` (for the
`--extension` argv append and the pre-spawn `is_file()` fail-closed check). Both
`RpcWorkerProcess::spawn` and `InteractiveProcess::spawn` follow the same pattern:
check `is_file()` first, return `ServiceError::ChildProcess` naming the expected
path, then build the command with `.arg("--extension").arg(&cfg.extension_path)`.

The README's Installation section was a complete rewrite. The table column for
"Install path" was updated to describe the by-path model rather than "pi's
extension search path". The old `~/.pi/agent/extensions/` and
`<project>/.pi/extensions/` copy-paste instructions were removed. The new section
documents: (1) the default path by platform (`~/.local/share/bob/extensions/bob.ts`
on Linux, `~/Library/Application Support/bob/extensions/bob.ts` on macOS,
`$XDG_DATA_HOME/bob/extensions/bob.ts` when that var is set); (2) the
`extension_path` config-file key and `BOB_EXTENSION_PATH` env-var override; (3) how
bob passes the resolved path to pi via `--extension`; and (4) the fail-closed
behavior including the exact error message text from the source. The env-var
contract section (`BOB_SESSION_ID`, `BOB_EXTENSION_SOCK_PATH`, `BOB_AUTHZ_TIMEOUT_MS`)
was left untouched. All other sections were left untouched.

Verification ran clean (the grep check passed; old pi search-path directories no
longer present). No attempts were tried and rejected; the first draft matched all
three ACs.

**Obstacles Encountered:** none.

**What remains:** nothing for this task.

Commit `d4293ef` on branch
`task/T-102-document-the-bob-extension-by-path-install-model-in-the-extension-readme`.

## Review

<!-- Reviewer: append verdict here after each review cycle. -->

### Review Verdict — 2026-06-24

PASS

**Stage 1 — Acceptance Criteria**

AC-1: PASS. The README documents the default location `~/.local/share/bob/extensions/bob.ts`
(Linux) and `~/Library/Application Support/bob/extensions/bob.ts` (macOS), along with
`$XDG_DATA_HOME/bob/extensions/bob.ts` when `XDG_DATA_HOME` is set. The `extension_path`
config-file key is shown in a TOML snippet. All three paths match `default_extension_path_for_env`
in `crates/bob/src/config.rs` exactly.

AC-2: PASS. The README documents that bob appends `--extension <resolved_path>` to the pi
command line (confirmed against `.arg("--extension").arg(&cfg.extension_path)` in
`process.rs` lines 55-56 / 288-289 for both `RpcWorkerProcess` and `InteractiveProcess`).
The fail-closed behaviour and the exact error message text
`pi extension file does not exist at expected path '<resolved_path>'` match the code in
`process.rs` lines 46-49 / 279-282.

AC-3: PASS. No references to `~/.pi/agent/extensions/` or `<project>/.pi/extensions/` remain
in the README. The `grep -n "pi/agent\|pi/extensions\|\.pi/"` check returned no results.

**Verification command:** passed.

**Stage 2 — Code Quality / Accuracy**

This is a documentation-only change. Accuracy checks against the implementation:

- Config key name `extension_path` in `config.toml`: matches `RawBobConfig.extension_path`
  field (config.rs line 290) and the test at line 981 (`extension_path = "..."`). Correct.
- Default path logic (XDG_DATA_HOME → platform Home fallback): matches `default_extension_path_for_env`
  exactly (config.rs lines 744-760). Correct.
- `BOB_EXTENSION_PATH` env-var override: the generic `env_overrides` function (config.rs lines
  473-480) strips `BOB_` and lowercases, mapping `BOB_EXTENSION_PATH` → `extension_path`.
  The README's statement that it "overrides the config-file value with the same precedence rules
  as other `BOB_*` variables" is accurate (env overrides come after TOML file in the figment
  layering at lines 157-165).
- Env-var contract section (`BOB_SESSION_ID`, `BOB_EXTENSION_SOCK_PATH`, `BOB_AUTHZ_TIMEOUT_MS`):
  retained untouched.
- No stale pi-search-path install guidance anywhere in the file.

No accuracy issues found. Only the one specified file (`the-intern/extensions/README.md`) was
changed.
