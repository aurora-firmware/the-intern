---
id: T-006
title: Refresh repo documentation to reflect foundations work
status: pending
priority: medium
assigned-role: unassigned
created: '2026-05-15'
---

# Refresh repo documentation to reflect foundations work

## Description

This task runs **after** T-001 … T-005 have landed. It updates the existing
top-level documentation so that it reflects everything those tasks introduced:

- T-001 — `.github/workflows/{build,test,deploy}.yml` exist; CI triggers on
  PR (build/test) and on `v*` tags (deploy).
- T-002 — `project/docs/coding-guidelines-rust.md` and `…-node.md` exist.
- T-003 — Application code now lives under `the-intern/{service,extensions}/`.
- T-004 — `.devcontainer/devcontainer.json` references a local dev image.
- T-005 — `project/docs/roadmap.md` exists and lays out Phase 0–7.

Editing rules:
- **Update existing files only — do not create new files.** Touch only
  `README.md`, `CLAUDE.md` (and, only if it requires structural changes,
  `project/docs/the-intern-architecture.md`).
- `AGENTS.md` is a symlink to `CLAUDE.md`; do not edit it separately.
- Each new fact lives in one document. Other documents link to it rather
  than duplicate it.
- Out of bounds (explicit): no edits to `project/specs/**`, `project/decisions/**`,
  or `project/docs/system_overview.md`. No edits to `.claude/agents/**` or
  `.claude/skills/**` (no new agent or skill behaviour rules).

What to put where:
- **`README.md`** — short orientation page: one-paragraph what-this-repo-is,
  links to `project/docs/system_overview.md`, `project/docs/roadmap.md`,
  `project/specs/`, `CLAUDE.md`, the dev container, and the coding guidelines.
- **`CLAUDE.md`** — update the existing *Folder structure* section to include
  `the-intern/`, `.devcontainer/`, and `.github/workflows/`; add brief
  pointers to the coding guidelines and roadmap; mention the CI triggers in
  one line.

## Acceptance Criteria

AC-1: WHEN this task is started THE SYSTEM SHALL verify that T-001 through T-005 are in `project/tasks/completed/` (or otherwise merged) before edits begin; IF any of T-001..T-005 are still pending or in-progress THEN THE SYSTEM SHALL block this task.
AC-2: The system shall update `README.md` and `CLAUDE.md` so that both reference the new `the-intern/` code layout, the devcontainer, the CI workflows, the coding guidelines, and the roadmap.
AC-3: The system shall NOT create any new file as part of this task (no `CONTRIBUTING.md`, no `project/docs/index.md`, no other new docs).
AC-4: The system shall NOT modify any file under `project/specs/`, `project/decisions/`, `.claude/agents/`, `.claude/skills/`, or the file `project/docs/system_overview.md`.
AC-5: IF the same fact (folder map, CI trigger list, roadmap phase list) is referenced from more than one document THEN THE SYSTEM SHALL keep the authoritative copy in one file and link to it from the others.

## Dependencies

- `T-001` — CI workflows must exist before they can be documented
- `T-002` — Coding guidelines docs must exist before being linked
- `T-003` — `the-intern/` tree must exist before being added to the folder map
- `T-004` — Devcontainer file must exist before being referenced
- `T-005` — Roadmap must exist before being linked

## Files to Touch

- `README.md` — rewrite as short orientation page with links
- `CLAUDE.md` — refresh *Folder structure* and add pointers to CI / devcontainer / guidelines / roadmap
- `project/docs/the-intern-architecture.md` — only if structural references need updating; otherwise leave alone

## Verification

```bash
# Predecessors must be done
for t in T-001 T-002 T-003 T-004 T-005; do
  ls project/tasks/completed/ | grep -q "^$t-" || { echo "predecessor $t not completed"; exit 1; }
done

# Touched docs reference the new artifacts
grep -q "the-intern/" CLAUDE.md
grep -qE "\.devcontainer|devcontainer\.json" CLAUDE.md
grep -qE "\.github/workflows|build\.yml|test\.yml|deploy\.yml" CLAUDE.md
grep -q "coding-guidelines" CLAUDE.md
grep -q "roadmap" CLAUDE.md

grep -q "roadmap" README.md
grep -q "system_overview" README.md
grep -q "coding-guidelines" README.md

# Forbidden new files
! test -f CONTRIBUTING.md
! test -f project/docs/index.md

# Forbidden edits — these must be unchanged on this branch vs dev-agent
git diff --name-only dev-agent...HEAD -- \
  project/specs project/decisions .claude/agents .claude/skills \
  project/docs/system_overview.md | (! grep -q .)
```

## Work Log

## Review
