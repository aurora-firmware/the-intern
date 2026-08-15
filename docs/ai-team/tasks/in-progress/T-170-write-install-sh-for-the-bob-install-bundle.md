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
3. Resolve the extension install path with XDG Base Directory semantics matching amended
   S-013: if `XDG_DATA_HOME` is unset or empty, use the platform default —
   `~/.local/share/bob/extensions/bob.ts` on Linux (ADR-009),
   `~/Library/Application Support/bob/extensions/bob.ts` on macOS (ADR-009's macOS
   clause); if `XDG_DATA_HOME` is non-empty and absolute, use
   `$XDG_DATA_HOME/bob/extensions/bob.ts`; if `XDG_DATA_HOME` is non-empty and relative,
   print a clear error and exit non-zero before modifying the filesystem. Create parent
   directories as needed and copy the sibling `bob.ts` there.
4. If a `bob` binary already exists at `~/.local/bin/bob`, prompt for interactive `y/n`
   confirmation before overwriting; abort with no changes if declined.
5. If `pi` is not on `PATH`, print a warning pointing at the pi install guide, but never
   fail or block on it. If `~/.local/bin` is not itself on the operator's `PATH`, print a
   separate warning saying so, but never fail or block on it either.
6. Print a summary naming the installed binary path and extension path.

Planner amendment from CR-008 supersedes the prior "empty string means set" requirement and
the attempted HOME anchoring described in the existing Work Log. `install.sh` must not
normalize a non-empty relative `XDG_DATA_HOME` under `HOME`; it must reject that value before
any write. The matching bob runtime resolver change is owned by T-174, which is independent
of this install-script task except for the shared S-013 contract.

Do not read `config.toml` or make network calls — honoring a later `extension_path`/
`BOB_EXTENSION_PATH` override is explicitly out of scope (S-013 Design Principles).

## Acceptance Criteria

AC-1: WHEN `install.sh` is run on a platform/architecture other than linux-x86_64 or
      macos-arm64 THE SYSTEM SHALL print the detected platform and exit non-zero without
      creating or modifying any file.
AC-2: THE SYSTEM SHALL install the sibling `bob` binary to `~/.local/bin/bob`, creating
      `~/.local/bin` if it does not exist, and mark the installed file executable.
AC-3: THE SYSTEM SHALL install the sibling `bob.ts` to the platform default extension path
      when `XDG_DATA_HOME` is unset or empty, and to
      `$XDG_DATA_HOME/bob/extensions/bob.ts` when `XDG_DATA_HOME` is non-empty and absolute,
      creating parent directories as needed.
AC-4: IF `XDG_DATA_HOME` is non-empty and relative THEN THE SYSTEM SHALL print a clear error
      and exit non-zero before creating or modifying any file.
AC-5: WHEN installation reaches overwrite and reporting checks THE SYSTEM SHALL prompt before
      overwriting an existing `~/.local/bin/bob`, make no changes if the operator declines,
      print a summary naming the installed binary path and extension path, and print
      non-blocking warnings when `pi` is not on `PATH` or `~/.local/bin` is not on `PATH`.

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

# XDG_DATA_HOME unset -> platform default path
(cd "$BUNDLE" && env -u XDG_DATA_HOME HOME="$TEST_HOME" ./install.sh)
test -x "$TEST_HOME/.local/bin/bob"
test -f "$TEST_HOME/.local/share/bob/extensions/bob.ts"

# XDG_DATA_HOME empty -> platform default path
rm -rf "$TEST_HOME/.local/bin" "$TEST_HOME/.local/share"
(cd "$BUNDLE" && HOME="$TEST_HOME" XDG_DATA_HOME= ./install.sh)
test -f "$TEST_HOME/.local/share/bob/extensions/bob.ts"

# XDG_DATA_HOME non-empty absolute -> honored, overriding the platform default
rm -rf "$TEST_HOME/.local/bin" "$TEST_HOME/.local/share"
(cd "$BUNDLE" && HOME="$TEST_HOME" XDG_DATA_HOME="$TEST_HOME/xdg" ./install.sh)
test -f "$TEST_HOME/xdg/bob/extensions/bob.ts"

# XDG_DATA_HOME non-empty relative -> clear error and no filesystem changes
rm -rf "$TEST_HOME/.local/bin" "$TEST_HOME/.local/share" "$TEST_HOME/xdg"
if (cd "$BUNDLE" && HOME="$TEST_HOME" XDG_DATA_HOME="relative/data" ./install.sh); then
  echo "expected relative XDG_DATA_HOME to fail" >&2
  exit 1
fi
test ! -e "$TEST_HOME/.local/bin/bob"
test ! -e "$TEST_HOME/.local/share/bob/extensions/bob.ts"

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

### Session 3 — 2026-08-15

After the abandoned earlier branch was deleted, rebuilt `the-intern/install-bundle/install.sh` on a fresh branch against the amended CR-008/S-013 contract. The new script defaults unset or empty `XDG_DATA_HOME`, honors only non-empty absolute values, and rejects relative values before filesystem changes; it also retains platform checks, binary overwrite confirmation, warnings, and installed-path summary. Syntax/lint and isolated temporary-home smoke tests passed for Linux/macOS defaults, empty/absolute/relative XDG cases, overwrite flows, and warning behavior. Implementation commits: `dda15ce`, `25b580d`, and `93b3691`. Historical Sessions 1–2 and their review verdicts are superseded by this implementation.

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

### Review Verdict — 2026-08-15
ESCALATE

Problem: `the-intern/install-bundle/install.sh:43-68` now makes any relative resolver result absolute under `HOME`, so it no longer reproduces bob's reference resolver exactly for `XDG_DATA_HOME=''` or any other relative `XDG_DATA_HOME` value. The task description explicitly says the installer must resolve the path the same way bob does and cites `the-intern/service/crates/bob/src/config.rs:680-695` as the exact reference implementation.
Attempted: Review cycle 1 failed because the literal relative resolver result (`bob/extensions/bob.ts`) collided with the sibling bundle binary when the script was run from inside the bundle directory. Review cycle 2 changed the script to anchor relative results under `HOME`, and the smoke tests then passed for unset, absolute-XDG, overwrite, and empty-XDG cases.
Failed because: Ordinary Developer fixes cannot satisfy both requirements as currently written. Bob's resolver keeps relative `XDG_DATA_HOME` values relative, but the task's execution model runs `install.sh` from the unpacked bundle directory that already contains a sibling `bob` file. In that context, the exact relative result for `XDG_DATA_HOME=''` is `bob/extensions/bob.ts`, which collides with `./bob`; changing the path to avoid that collision stops matching the mandated reference behavior.
Question: Should the installer preserve bob's literal relative-path semantics for empty or relative `XDG_DATA_HOME` values, or should the spec define a normalization rule for install-time writes (for example anchoring under `HOME` or rejecting relative `XDG_DATA_HOME` values with a clear error)?
