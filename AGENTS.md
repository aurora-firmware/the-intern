# AGENTS.md

This file gives coding agents the commands and conventions they need to work in this repository.

## Branches

- The main dev branch for this version is dev-pi-durable.
- As we develop it, feature branches should merge into dev-pi-durable.
- Don't open PRs into main but into dev-pi-durable.

## Status

The Intern (`bob`) is one TypeScript/Node package that embeds pi as a library on `@earendil-works/pi-durable`.
The package and its tooling exist (TypeScript, tests, lint, formatting, CI and the user manual site), but there is no
product code yet.

Read these before designing anything:

- `docs/ai-team/specs/S-000-system-overview.md`: what the product is, who it serves, its components and exclusions.
  It is the source of truth for scope.
- `docs/system_overview.html`: the shared vocabulary and the spec map.
- `docs/reports/pi-durable-knowledge.md`: pi-durable, the pi coding-agent SDK, prototype results, API footguns.
- `docs/reports/feature-review.md`: background only. It records per-feature directions from before S-000, and S-000
  wins where they differ.

`docs/AGENTS.md` maps the `docs/` folder: what each part holds, which documents bind the work, and who updates them
and when.

## Development environment

See the "Development environment" and "Building from scratch" sections of `README.md`. Code conventions are in
`docs/development/coding_guidelines.md`.

## Build and Install

Node 24 is required (`mise install` provides it). There is no compile step: the code runs as TypeScript on Node.

```
npm ci
```

## Test

```
npm test
```

`npm run test:unit` and `npm run test:service` run the two test folders separately.

## Run

There is no runnable command yet. The daemon (`bob serve`) is added by the tasks of S-002; until then the code is
exercised through the tests only.

## Lint and Format

```
npm run lint        # biome check
npm run format      # biome format --write
npm run typecheck   # tsc --noEmit
npm run check       # typecheck, lint and tests
```

`npm run format:check` verifies formatting without writing. Build the user manual with `npm run docs:build`.

## Key Conventions

- Reference `docs/development/coding_guidelines.md` for detailed rules; `docs/development/README.md` indexes the
  developer docs.
- Write every document, task, review and commit message by `docs/development/writing_style.md`.

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
├── package.json                 # Scripts and pinned dependencies
├── package-lock.json
├── tsconfig.json                # TypeScript configuration
├── biome.json                   # Lint and format configuration
├── mise.toml                    # Tool versions and the ai-team pin
├── src/                         # Product code
├── test/                        # Tests (unit/, support/)
├── .github/workflows/
│   ├── build.yml                # CI: Format, Build, User Documentation, Tests
│   ├── pages.yml                # Publishes the user manual to GitHub Pages
│   └── deploy.yml               # Release placeholder (tag pushes)
└── docs/
    ├── development/             # Developer docs and coding guidelines
    ├── manual/                  # User manual (VitePress site)
    ├── ai-team/                 # Specs, decisions and project-local ai-team docs
    └── reports/                 # Knowledge base, feature review
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
