---
id: T-131
title: Verify pi cwd-relative skill discovery and scaffold the email-skills package
status: pending  # pending | in-progress | completed | blocked
priority: high  # critical | high | medium | low
assigned-role: developer
created: '2026-08-01'
spec: S-010
---

# Verify pi cwd-relative skill discovery and scaffold the email-skills package

## Description

S-010 ships two pi-agent skills as a new product package that a scheduled job
reaches through its per-entry `--cwd` (S-009 / ADR-012 §7). Every later task in
this plan writes files into that package, so its on-disk layout must first be
the one pi actually discovers — this task proves it and records it.

Create the package root `the-intern/email-skills/` (a new top-level directory
under `the-intern/`, sibling to `bob-companion`, per S-010's Configuration
Requirements) with a `README.md` that documents the verified layout, and add the
directory to the folder-structure tree in `CLAUDE.md` (`AGENTS.md` is a symlink
to it — edit `CLAUDE.md` only).

The expected path is `.pi/skills/<name>/SKILL.md` relative to the session's cwd,
mirroring pi's global `~/.pi/agent/skills/<name>/SKILL.md` layout (SKILL.md with
`name` / `description` / `allowed-tools` frontmatter, plus optional
`references/*.md`). Confirm it with a throwaway probe skill in a copy of the
package before writing it into the README.

**`.gitignore` ignores the bare pattern `.pi` (line 4), which git matches at
every directory level — so `the-intern/email-skills/.pi/` and every skill file
T-132–T-138 write into it would be silently untracked.** Fix it here, before any
skill file exists: anchor the repo-root agent-config ignores (`/.pi`), or negate
for this package. `the-intern/bob-companion/claude/` (undotted) is the existing
precedent for the same problem with `.claude`.

`pi` on PATH is a hard precondition (CLAUDE.md); do not mock it. `pi` defaults to
an interactive `ink` TUI needing a real TTY — probe with the non-interactive
`-p`/`--print` opt-out and record the working invocation form in the README,
since T-132–T-138 reuse it.

This package is the repository source of truth only: a scheduled job's `--cwd`
points at an owner-only *deployed copy*, never at the checkout.

## Acceptance Criteria

AC-1: WHEN a pi session runs with a copy of the package as its working directory
      THE SYSTEM SHALL list the probe skill placed at the candidate path among its
      available skills, and `the-intern/email-skills/README.md` shall record that
      verified path together with the `pi --version` and the invocation form used,
      evidenced by a transcript in the Work Log.
AC-2: The system shall document in the README the package's full intended layout
      — the `himalaya` and `email-triage` skill directories, the category
      reference directory, the skill-local configuration file, and the runtime
      `worklog/` directory — so later tasks add files without editing that
      section.
AC-3: IF the verified discovery path differs from `.pi/skills/<name>/SKILL.md`
      THEN THE SYSTEM SHALL adopt the verified path in the README and report the
      deviation so dependent tasks' file paths are corrected before they start.
AC-4: The system shall make every file under `the-intern/email-skills/` — including
      the dot-directory the verified discovery path uses — trackable by git,
      evidenced by `git check-ignore -v` reporting no match for a file at the
      verified skill path.
AC-5: The system shall list `the-intern/email-skills/` with a one-line purpose in
      the folder-structure tree in `CLAUDE.md`.

## Dependencies

- None

## Files to Touch

- `the-intern/email-skills/README.md` — new: package purpose, verified skill
  discovery path and invocation form, full intended layout, deployment-copy note
- `.gitignore` — stop the bare `.pi` pattern from ignoring the package's skill
  directory
- `CLAUDE.md` — add the new top-level package to the folder-structure tree

## Verification

```bash
# Prerequisite (hard project precondition — escalate if absent)
pi --version

# Probe the candidate discovery path in a throwaway copy of the package
rm -rf /tmp/email-skills-probe
mkdir -p /tmp/email-skills-probe/.pi/skills/probe-marker
cp -r the-intern/email-skills/. /tmp/email-skills-probe/
printf -- '---\nname: probe-marker\ndescription: Probe skill used to verify cwd-relative discovery.\n---\n\n# Probe\n' \
  > /tmp/email-skills-probe/.pi/skills/probe-marker/SKILL.md

# Ask pi, with that directory as its cwd, to list its available skills.
# Use -p/--print: pi's default mode is an interactive ink TUI needing a real TTY
# and will not run under a non-interactive shell.
cd /tmp/email-skills-probe && pi -p "List the names of every skill available to you. Do not use any tools."

# Confirm `probe-marker` appears. If -p does not surface project skills, retry
# under a TTY (`script -qec 'pi' /dev/null`) and record which form worked.
# If the skill does not appear at all, repeat with the next candidate path until
# one is confirmed. Paste the transcript into the Work Log and record the
# confirmed path and invocation form in the README.

# The package's skill files must not be gitignored (AC-4) — this must print
# nothing and exit non-zero:
cd "$OLDPWD" && git check-ignore -v the-intern/email-skills/.pi/skills/probe-marker/SKILL.md
```

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

### Session 1 — 2026-08-02

Confirmed `pi` on PATH (`pi --version` → `0.80.3`), then probed the candidate discovery path exactly as the task's verification script specifies: created `/tmp/email-skills-probe/.pi/skills/probe-marker/SKILL.md` and ran `pi` with that directory as `cwd`.

Key finding: `pi -p "<prompt>"` alone (the form given literally in the task's Verification block) never surfaced `probe-marker` — only the three globally-installed skills (`gh-cli`, `git-conventions`, `pr-review`) appeared, reproducibly across repeated runs. Investigating `pi --help`, the `--approve`/`-a` flag ("Trust project-local files for this run") turned out to be the missing piece: `pi -p -a "<prompt>"` (or `pi --print --approve`) consistently surfaced `probe-marker` alongside the global skills. So the discovery *path* itself needed no correction (`.pi/skills/<name>/SKILL.md` relative to cwd was right on the first try — AC-3 is N/A, no path deviation to report), but the invocation form recorded in the README had to be `-p -a`, not bare `-p`, since pi does not load project-local content from an untrusted cwd without explicit per-run trust. Recorded this as the important caveat for T-132–T-139, which reuse this invocation form.

Reproduced the `.gitignore` bug described in the task before fixing it: placed a file at `the-intern/email-skills/.pi/skills/probe-marker/SKILL.md` in the real package and confirmed `git check-ignore -v` matched it against `.gitignore:4:.pi` (the bare pattern matching at every directory level, not just repo root). Fixed by anchoring that one line to `/.pi` (left the other three agent-config lines — `.codex`, `.claude`, `.agents` — untouched, since only `.pi` conflicts with this new package and the task's own phrasing singles out `/.pi`). Re-verified: the same path no longer matches (`git check-ignore` exits 1), and a repo-root `.pi/...` path still matches (exit 0), so the intended repo-root agent-config ignore behavior is preserved. Removed the probe file from the real package afterward — per the task's own instruction, the probe belongs in a throwaway copy, and `git check-ignore` works fine against a path that doesn't exist on disk, so the final AC-4 verification command in the task doesn't require a committed probe file.

Wrote `the-intern/email-skills/README.md` covering: package purpose and how it differs from `bob-companion/claude` and `.claude/skills`; the verified discovery path, `pi --version`, and the `-p -a` invocation form (AC-1); the full intended layout — `himalaya` and `email-triage` skill directories, `references/categories/` (the category reference directory), `config/email-triage.example.toml` (the skill-local configuration template) and `worklog/` (the runtime diary directory) — cross-referenced to T-132–T-138 so those tasks can add files without touching this section (AC-2); and the deployed-copy-only note (checkout is never a scheduled job's `--cwd`). Cross-checked the layout names (`references/categories/`, category names, `config/email-triage.example.toml`, `worklog/<YYYY-MM-DD>.md`) against S-010 and the pending T-132–T-138 task files rather than inventing names, so downstream tasks' assumed paths line up.

Added `the-intern/email-skills/` to `CLAUDE.md`'s folder-structure tree (AGENTS.md is a symlink, edited `CLAUDE.md` only) as a sibling of `bob-companion`, one line, per AC-5.

Re-ran the task's full Verification block end-to-end after committing (fresh `/tmp` probe copy, bare `-p` vs `-p -a`, and the `git check-ignore` command from the repo root) — all outcomes match what's recorded in the README. Nothing remains for this task; all five acceptance criteria are implemented and independently re-verified. Three commits on the task branch, one per Files-to-Touch item: `32f35e1` (`.gitignore` fix, AC-4), `9c64243` (README, AC-1/2/3), `cdbdcd0` (`CLAUDE.md` tree, AC-5).

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->
