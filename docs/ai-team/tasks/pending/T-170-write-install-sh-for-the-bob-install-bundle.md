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
   fail or block on it.
6. Print a short summary of what was installed and where.

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
AC-5: IF `pi` is not found on `PATH` THEN THE SYSTEM SHALL print a warning naming the pi
      install guide and continue without failing.

## Dependencies

- None

## Files to Touch

- `the-intern/install-bundle/install.sh` — new file, the install script described above

## Verification

```bash
shellcheck the-intern/install-bundle/install.sh

# Manual dry-run against an isolated HOME, using the real dev binary as a stand-in:
export TEST_HOME="$(mktemp -d)"
mkdir -p "$TEST_HOME/bundle" && cd "$TEST_HOME/bundle"
cp the-intern/service/target/debug/bob bob
cp the-intern/pi-extension/bob.ts bob.ts
HOME="$TEST_HOME" XDG_DATA_HOME= ./install.sh
test -x "$TEST_HOME/.local/bin/bob"
test -f "$TEST_HOME/.local/share/bob/extensions/bob.ts"
# Re-run and confirm the overwrite prompt appears (answer n, confirm no changes;
# answer y, confirm it re-copies).
```

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->
