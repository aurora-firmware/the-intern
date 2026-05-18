# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repository is

Two things live here, and they must not be confused:

1. **The product being designed — "the Intern".** A logical architecture for an intelligent
   office-assistant agent, with architecture in `project/docs/system_overview.md`, implementation
   roadmap in `project/docs/roadmap.md`, and current Rust service code in `the-intern/service/`.

Repository orchestration commands are provided by the slash-skills below, backed by the
`ai-team` CLI.

## Folder structure

```
.
├── CLAUDE.md                    # This file (AGENTS.md is a symlink to it)
├── README.md
├── .ai-team.toml                # Framework config (project.dir, version)
├── .devcontainer/
│   └── devcontainer.json        # Local dev container definition
├── .github/
│   └── workflows/
│       ├── build.yml            # Build workflow (pull requests)
│       ├── test.yml             # Test workflow (pull requests)
│       └── deploy.yml           # Deploy workflow (v* tags)
├── ai-process-cli-reported-issues.md  # Running log of ai-team CLI / skill bugs
├── .claude/
│   ├── agents/                  # Role definitions: planner, architect, developer, reviewer, integrator
│   └── skills/                  # Slash-skills backing the workflow (brainstorm, spec-breakdown,
│                                #   spec-breakdown-review, dev-loop, bug-loop, tdd, code-review,
│                                #   integrate, debug, escalation-review, git-conventions,
│                                #   merge-conflicts, new-{task,bug,spec,adr}, status-report)
├── .codex/
│   └── agents/                  # Mirror role definitions for the codex toolchain (*.toml)
├── the-intern/
│   ├── extensions/              # Future JS extension/plugin code area
│   └── service/                 # Rust service workspace (`bob` and subsystem crates)
└── project/                     # Source of truth for product lifecycle state
    ├── docs/                    # Product design (system_overview.md, the-intern-architecture.md)
    │                            # Coding guidance and roadmap live here too
    ├── specs/                   # Approved specifications (input to spec-breakdown)
    ├── decisions/               # ADRs
    ├── tasks/{pending,in-progress,completed,blocked}/
    └── bugs/{open,in-progress,resolved}/
```

Directory *is* the status for tasks and bugs — moving a file is how state transitions.

## The `ai-team` CLI

IMPORTANT: The skills used in this project, together with the ai-team CLI are under development. Please write down there every bug or problem you notice with any of them in ai-process-cli-reported-issues.md

GitHub workflows are currently placeholders:
- `build.yml` and `test.yml` trigger on pull requests and pushes to `dev-agent`/`main`,
  but only run placeholder `echo` steps.
- `deploy.yml` triggers on `v*` tags and only runs a placeholder `echo` step.

Use the local Rust verification commands in `the-intern/service/README.md` for
real build/test evidence until the workflows are wired to actual commands.

## Pointers

- Coding guidelines: `project/docs/coding-guidelines-node.md`,
  `project/docs/coding-guidelines-rust.md`
- Roadmap: `project/docs/roadmap.md`

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
