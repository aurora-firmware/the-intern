# AGENTS.md

This file gives coding agents the commands and conventions they need to work in this repository.

## Branches

- The main dev branch for this version is dev-pi-durable.
- As we develop it, feature branches should merge into dev-pi-durable.
- Don't open PRs into main but into dev-pi-durable.

## Status

The Intern (`bob`) is one TypeScript/Node package that embeds pi as a library on `@earendil-works/pi-durable`.
There is no source code, test suite or build yet.

Read these before designing anything:

- `docs/ai-team/specs/S-000-system-overview.md`: what the product is, who it serves, its components and exclusions.
  It is the source of truth for scope.
- `docs/system_overview.html`: the shared vocabulary and the spec map.
- `docs/reports/pi-durable-knowledge.md`: pi-durable, the pi coding-agent SDK, prototype results, API footguns.
- `docs/reports/feature-review.md`: background only. It records per-feature directions from before S-000, and S-000
  wins where they differ.

## Development environment

See the "Development environment" and "Building from scratch" sections of `README.md`. Code conventions are in
`docs/ai-team/docs/coding_guidelines.md`.

## Build and Install

Not defined yet. The CI workflows in `.github/workflows/` are placeholders with the job names kept; fill them in when
the package exists, and add the commands in this section and the three below.

```
# Replace with the command agents should run to install or build the project.
# Example: npm install / npm run build
```

## Test

```
# Replace with the command agents should run to execute the test suite.
# Example: npm test
```

## Run

```
# Replace with the command agents should use to start the application locally.
# Example: npm start
```

## Lint and Format

```
# Replace with the command agents should run to check code style.
# Example: npm run lint
```

## Key Conventions

- Reference `docs/ai-team/docs/coding_guidelines.md` for detailed rules.

### Vocabulary

Shared terms are defined in `docs/system_overview.html` (section 4, Vocabulary). Use them in every spec, task, review
and commit message. In short:

- **Team member**, never user, operator, admin or owner.
- **Job** is the product's unit of work. **Task** is used only in the pi-durable meaning.
- An agent **invokes** another agent; never "subagent".
- When a term exists in both runtimes, write "pi-durable X" or "pi agent X".
- Never "sandbox": workspaces don't confine agents.

### Fixes follow the specs

A bug or issue fix must stay within the approved specs and accepted ADRs. If the fix would change or contradict
specified behaviour, stop and escalate it as blocking (a spec amendment or change request) instead of shipping the
code change alone.

### Folder structure

```
.
├── AGENTS.md                    # This file
├── README.md
├── .github/workflows/
│   ├── build.yml                # CI placeholder: format, build, documentation, user-docs, tests
│   └── deploy.yml               # Release placeholder (tag pushes)
└── docs/                        # Project docs: knowledge base, feature review
```

### Runtime prerequisites

- pi is consumed as npm packages (`@earendil-works/pi-durable`, `pi-ai`, `chord`, `pi-coding-agent`), pinned to exact
  versions with a lockfile. The packages ship in lockstep; keep them on the same version.
- Don't replace the real pi packages with substitutes or alternate agent runtimes to get around a missing or broken
  dependency; stop and escalate. Deterministic fake models for tests are fine.
- `README.md` is the canonical record of the pi versions in use (no backwards compatibility guaranteed). Whenever the
  version changes, update the README's compatibility section.

### ai-team version

`ai-team` is installed per project by `mise run setup:ai-team`, into the git-ignored `.tmp/tools`, at the released
version pinned as `AI_TEAM_REF` in `mise.toml`. Bump that pin to move to a new release. Report errors at
https://github.com/aurora-firmware/the-ai-team/issues.
