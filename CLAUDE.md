# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repository is

Two things live here, and they must not be confused:

1. **The product being designed — "the Intern".** A logical architecture for an intelligent
   office-assistant agent. Its design lives in `project/docs/system_overview.md`. The repo is
   currently in the *design phase* (branch `pi-agent-design`) — there is no application source
   code or test suite yet.
2. **The AI-team framework that governs how work gets done.** A structured multi-agent software
   development process defined entirely in `.claude/` (agents, skills) and `.ai-team.toml`. All
   work on the product flows through this process.

There are no build/lint/test commands — there is no code. "Commands" in this repo are the
slash-skills below, backed by the `ai-team` CLI.

## The `ai-team` CLI

Skills shell out to an `ai-team` CLI for lifecycle artifacts (verify it is on PATH):
- `ai-team task new "<title>" --priority <p> [--assigned-role <r>] --json`
- Analogous subcommands back the `new-bug`, `new-spec`, `new-adr` skills.

Project config is `.ai-team.toml` (`project.dir = "project"`, framework version 0.1.0).

## Roles (subagents)

Five role agents in `.claude/agents/`, each with a fixed model and skill set:

| Role | Model | Owns |
|---|---|---|
| `planner` | opus | Brainstorm → approved spec → decompose into atomic tasks |
| `architect` | opus | Gate-2 preflight, escalation consultation, ADRs |
| `developer` | sonnet | Implements exactly one task/bug via TDD on its own branch |
| `reviewer` | sonnet | Two-stage code review after Developer handoff |
| `integrator` | sonnet | Manual merges + semantic conflict resolution |

Mirror definitions for the `codex` toolchain exist in `.codex/agents/*.toml`.

## Workflow

Feature request → `brainstorm` → approved **spec** (`project/specs/`) → `spec-breakdown` into
**tasks** → Architect **Gate-2 preflight** (`spec-breakdown-review`) → `dev-loop` runs each task
through Developer ⇄ Reviewer cycles → `integrate` merges to `dev-agent`. Bugs follow the parallel
`bug-loop` path. Blocked work escalates: role → Architect (`escalation-review`) → human.

`dev-loop` and `bug-loop` are autonomous orchestrators (`disable-model-invocation: true` — human
triggers only). They read/write lifecycle state directly from the filesystem and stop only at hard
gates: empty queue, blocked task, escalation, or integration failure.

## Lifecycle state lives in the filesystem

`project/` is the source of truth. Task and bug files **move between status directories** as their
state changes — the directory *is* the status:

```
project/tasks/{pending,in-progress,completed,blocked}/
project/bugs/{open,in-progress,resolved}/
project/specs/      project/decisions/ (ADRs)      project/docs/
```

Task/bug files are **canonical on `dev-agent`**. Implementation branches may carry copies for
context, but lifecycle state is always read from and committed to `dev-agent`.

## Git model (authoritative: `git-conventions` skill)

| Branch | Who touches it |
|---|---|
| `main` | Human only — no automated role ever commits here |
| `dev-agent` | Integration target + canonical lifecycle state; non-Developer roles & loops commit docs/specs/task files here (never source code) |
| `task/T-NNN-...` / `bug/B-NNN-...` | Developer only; source, tests, artifacts |

Commit format: `<type>(<component>): <description>` — type ∈ `feat|fix|test|docs|chore`,
imperative, lowercase, no period, ≤72 chars. Do not repeat the task/bug ID (the branch carries it).

Hard rules: no `--no-verify`, no `--force` on `dev-agent`/`main`, no amending pushed commits.

## Working in this repo

- When asked to do product work, route it through the framework (spec → tasks → loop), don't
  free-hand implementation against `project/docs/`.
- Editing process itself (agents/skills) is direct repo work — but keep agent and skill
  definitions internally consistent (each agent's `skills:` frontmatter must match real skills).
- Keep the `.claude/` and `.codex/` agent definitions in sync when changing roles.
