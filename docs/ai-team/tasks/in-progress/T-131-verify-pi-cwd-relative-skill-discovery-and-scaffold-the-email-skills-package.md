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

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->
