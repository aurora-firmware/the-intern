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
├── .github/
│   └── workflows/
│       ├── build.yml            # CI: format, build, rust-docs, user-docs, tests (PRs + pushes to dev-agent/main)
│       ├── deploy.yml           # Release: build release binary + mdBook docs, attach both to GitHub Release (tag pushes)
│       └── test_deploy_workflow.py  # Static checks over deploy.yml (T-083 acceptance tests)
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

GitHub workflows (self-hosted runners):
- `build.yml` runs on pull requests and pushes to `dev-agent`/`main`. Jobs: `format`
  (`cargo fmt --check`), `build` (`cargo build -p bob`), `documentation` (`cargo doc`,
  uploads `rust-docs` artifact), `user-docs` (mdBook build of `the-intern/docs`,
  uploads `user-docs` artifact), and `tests` (`cargo test --workspace`, uploads
  `rust-test-report`).
- `deploy.yml` runs on tag pushes. Builds the release `bob` binary and the mdBook
  docs, archives the book as `the-intern-docs-<tag>.tar.gz`, and attaches both
  artifacts to the GitHub Release.

Local Rust verification commands are still documented in
`the-intern/service/README.md` for fast feedback.

## Runtime prerequisites

- The pi-agent binary must be available as `pi` on `PATH`. This is a hard
  project precondition for Phase 2 and later work.
- If `pi` is not available at any point, stop the current work and escalate;
  do not implement substitutes, mocks, or alternate process runners as a way
  around the missing prerequisite.

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
