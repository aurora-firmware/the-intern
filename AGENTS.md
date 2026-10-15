# AGENTS.md

This file gives coding agents the commands and conventions they need to work in this repository.

## the-intern rework with pi durable is under development

- The main dev branch for this version is dev-pi-durable.
- As we develop it, feature branches should merge into dev-pi-durable.
- Don't open PRs into main but into dev-pi-durable.

## Status

The repository was reset to a clean slate for the new version of the Intern (`bob`): one TypeScript/Node package
that embeds pi as a library on `@earendil-works/pi-durable`. There is no source code, test suite or build yet. The
previous Rust implementation, its specs and its ADRs are in git history only; don't restore them.

Read these before designing anything:

- `docs/pi-durable-knowledge.md`: pi-durable, the pi coding-agent SDK, proof-of-concept results, API footguns.
- `docs/feature-review.md`: verdicts per feature of the previous bob and the open design decisions.

## Build, test, lint

Not defined yet. The CI workflows in `.github/workflows/` are placeholders with the job names kept; fill them in when
the package exists, and add the commands here.

## Key conventions

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

### ai-team dev version

`ai-team` in this folder is a development build, not the released version. The git-ignored `mise.toml` puts
`~/.local/share/ai-team-dev/bin` first on `PATH`. Report errors on the open PR:
https://github.com/aurora-firmware/The-AI-team-definition/pull/32.

- Rebuild after changes, from `~/projects/the-ai-team-definition/cli`:
  `python scripts/sync_init_scaffolds.py && uv build && uv pip install --python ~/.local/share/ai-team-dev/bin/python --reinstall dist/<newest wheel>`.
- Revert to the released version: delete `mise.toml` and `~/.local/share/ai-team-dev`.
