---
id: T-170
title: Write install.sh for the bob install bundle
status: pending
priority: high
assigned-role: unassigned
created: '2026-08-15'
---

# Write install.sh for the bob install bundle

<!--
Task Quality Rules (see the new-task skill for full details):
  - Atomic — one clear outcome.
  - One-shottable — ≤ 3–4 files touched, ≤ 5 ACs, Description ≈ 20 lines.
  - Verifiable — concrete Verification command or explicit manual steps.
  - Self-contained — Description is enough to start without follow-up questions.
  - EARS — every AC matches one of the five EARS patterns below.
  - Dependency-honest — list every prior task this one reads from or modifies.
-->

## Description

Implement `docs/ai-team/specs/S-013-cross-platform-bob-install-bundle-release-packaging.md`
Component 3. Create `the-intern/install-bundle/install.sh`, the entry point of the
per-platform install-bundle zip. At runtime it sits next to a `bob` binary and `bob.ts`
(siblings in the same unzipped directory). It must:

1. Detect OS and architecture; if not `linux`/`x86_64` or `darwin`/`arm64`, print what was
   detected and exit non-zero without touching the filesystem.
2. Install the sibling `bob` binary to `~/.local/bin/bob` (create the directory if missing)
   and mark it executable.
3. Resolve the extension install path the same way bob's own runtime resolver does: if
   `XDG_DATA_HOME` is set, use `$XDG_DATA_HOME/bob/extensions/bob.ts` (both platforms);
   otherwise fall back to the platform default — `~/.local/share/bob/extensions/bob.ts` on
   Linux (ADR-009), `~/Library/Application Support/bob/extensions/bob.ts` on macOS
   (ADR-009's macOS clause). Create parent directories as needed and copy the sibling
   `bob.ts` there.
4. If a `bob` binary already exists at `~/.local/bin/bob`, prompt for interactive `y/n`
   confirmation before overwriting; abort with no changes if declined.
5. If `pi` is not on `PATH`, print a warning pointing at the pi install guide, but never
   fail or block on it. If `~/.local/bin` is not itself on the operator's `PATH`, print a
   separate warning saying so, but never fail or block on it either.
6. Print a summary naming the installed binary path and extension path.

"`XDG_DATA_HOME` is set" means the variable exists in the environment, even if its value is
the empty string — this matches bob's own resolver
(`the-intern/service/crates/bob/src/config.rs:680-695`, referenced here alongside ADR-009 as
the reference implementation `install.sh` must reproduce exactly). A smoke test that wants to
simulate "unset" must unset the variable (`env -u XDG_DATA_HOME`), not set it to an empty
string.

Do not read `config.toml` or make network calls — honoring a later `extension_path`/
`BOB_EXTENSION_PATH` override is explicitly out of scope (S-013 Design Principles).

## Acceptance Criteria

AC-1: WHEN `install.sh` is run on a platform/architecture other than linux-x86_64 or
      macos-arm64 THE SYSTEM SHALL print the detected platform and exit non-zero without
      creating or modifying any file.
AC-2: THE SYSTEM SHALL install the sibling `bob` binary to `~/.local/bin/bob`, creating
      `~/.local/bin` if it does not exist, and mark the installed file executable.
AC-3: THE SYSTEM SHALL install the sibling `bob.ts` to `$XDG_DATA_HOME/bob/extensions/bob.ts`
      when `XDG_DATA_HOME` is set, otherwise to the platform default path, creating parent
      directories as needed.
AC-4: IF a `bob` binary already exists at `~/.local/bin/bob` THEN THE SYSTEM SHALL prompt for
      interactive confirmation before overwriting it, and make no changes if the operator
      declines.
AC-5: THE SYSTEM SHALL print a summary naming the installed binary path and extension path,
      including a warning when `pi` is not found on `PATH` (naming the pi install guide) and
      a warning when `~/.local/bin` is not on the operator's `PATH`, continuing without
      failing in either case.

## Dependencies

- None

## Files to Touch

- `the-intern/install-bundle/install.sh` — new file, the install script described above

## Verification

```bash
# shellcheck if available; otherwise fall back to a bash syntax-only check
shellcheck the-intern/install-bundle/install.sh || bash -n the-intern/install-bundle/install.sh

# Manual dry-run against an isolated HOME, using the real dev binary as a stand-in.
# Use absolute paths throughout — the script itself runs from inside the bundle dir.
REPO="$PWD"
TEST_HOME="$(mktemp -d)"
BUNDLE="$TEST_HOME/bundle"
mkdir -p "$BUNDLE"
cp "$REPO/the-intern/service/target/debug/bob" "$BUNDLE/bob"
cp "$REPO/the-intern/pi-extension/bob.ts" "$BUNDLE/bob.ts"
cp "$REPO/the-intern/install-bundle/install.sh" "$BUNDLE/install.sh"
chmod +x "$BUNDLE/install.sh"

# XDG_DATA_HOME truly unset -> platform default path
(cd "$BUNDLE" && env -u XDG_DATA_HOME HOME="$TEST_HOME" ./install.sh)
test -x "$TEST_HOME/.local/bin/bob"
test -f "$TEST_HOME/.local/share/bob/extensions/bob.ts"

# XDG_DATA_HOME set -> honored, even overriding the platform default
rm -rf "$TEST_HOME/.local/bin" "$TEST_HOME/.local/share"
(cd "$BUNDLE" && HOME="$TEST_HOME" XDG_DATA_HOME="$TEST_HOME/xdg" ./install.sh)
test -f "$TEST_HOME/xdg/bob/extensions/bob.ts"

# Re-run and confirm the overwrite prompt: answer n (no changes made), then y (re-copies).
```

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

### Session 1 — 2026-08-15

Implemented `the-intern/install-bundle/install.sh` with command-level TDD. The script rejects unsupported platforms before filesystem changes; installs the sibling binary and extension; follows bob's XDG-data-home presence semantics; prompts before overwriting the binary; and emits the required non-blocking warnings and summary. Three red→green→refactor commits were made (`e4908c3`, `9ba4b13`, and `4d40d34`). Verification used syntax/lint checks and isolated temporary-home smoke tests for supported and unsupported platforms, XDG set/unset handling, overwrite decline and confirmation, and warning behavior. No persistent test file was added because the task's Files to Touch boundary permits only the new script. Nothing remains for implementation.

### Session 2 — 2026-08-15

Addressed the review finding for an explicitly empty `XDG_DATA_HOME`. The script now retains the required “set” branch but anchors the otherwise relative resolved extension path below `HOME`, preventing a collision with the sibling bundle binary. The defect was reproduced before the fix; the isolated regression then passed with the extension at `$HOME/bob/extensions/bob.ts`. The existing unset, absolute-XDG, and overwrite smoke checks also passed. Implementation commit: `056ce96` (`fix(install-bundle): anchor empty xdg path in home`). Nothing remains for implementation.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->

### Review Verdict — 2026-08-15
FAIL

- `the-intern/install-bundle/install.sh:46-54,91-96` — AC-3 is not fully met for the task's required `"XDG_DATA_HOME is set, even if empty"` semantics. With `XDG_DATA_HOME=''`, the script resolves the extension target to `bob/extensions/bob.ts`, then fails from inside the bundle with `mkdir: cannot create directory 'bob': Not a directory` because the sibling bundle binary already occupies `./bob`. Reproduction used the reviewed script from `task/T-170-write-install-sh-for-the-bob-install-bundle` with `(cd "$BUNDLE" && HOME="$TEST_HOME" XDG_DATA_HOME='' PATH="/usr/bin:/bin" ./install.sh)`, which exited 1 before copying the extension. Update the installer so the empty-string `XDG_DATA_HOME` case still completes successfully while preserving the resolver semantics required by the task note.
