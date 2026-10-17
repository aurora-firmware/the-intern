# AGENTS.md

This file gives coding agents the commands and conventions they need to work in this repository.

## the-intern rework with pi durable is under development

- The main dev branch for this version is dev-pi-durable.
- As we develop it, feature branches should merge into dev-pi-durable.
- Don't open PRs into main but into dev-pi-durable.

## Working philosophy (cornerstone)

Applies to every design and implementation decision in this project. Original wording, kept verbatim:

> **Lo determinista se encarga de lo repetible y exacto; el LLM, de lo contextual y variado.**
> - Código para: filtrar, agrupar y compactar, alarmas con criterios conocidos, validaciones (que la carpeta exista,
>   que el cron se pueda interpretar), etiquetas que ya conocemos (canal, hilo, remitente, fecha).
> - LLM para: decisiones que requerirían un `switch` inmanejable, como a quién delegar, si algo es preocupante o si
>   un hecho sustituye a otro.
> - Sin purismos: si llamar al modelo es más simple y fiable que el código, se llama al modelo.

English: **deterministic code handles what is repeatable and exact; the LLM handles what is contextual and varied.**
Code for filtering, grouping and compacting, alarms with known criteria, validations (the folder exists, the cron
parses) and labels we already know (channel, thread, sender, date). The LLM for decisions that would need an
unmanageable `switch`: who to delegate to, whether something is worrying, whether one fact replaces another. No
purism: if calling the model is simpler and more reliable than code, call the model.

For each new piece, ask first: can code do this well? If yes, code; if not, the LLM.

## Status

The repository was reset to a clean slate for the new version of the Intern (`bob`): one TypeScript/Node package
that embeds pi as a library on `@earendil-works/pi-durable`. There is no source code, test suite or build yet. The
previous Rust implementation, its specs and its ADRs are in git history only; don't restore them.

Read these before designing anything:

- `docs/pi-durable-knowledge.md`: pi-durable, the pi coding-agent SDK, proof-of-concept results, API footguns.
- `docs/feature-review.md`: verdicts per feature of the previous bob and the open design decisions.

## Development environment

Work inside the devcontainer (`.devcontainer.json`): user `ubuntu`, passwordless `sudo`, `~/.pi` shared
with the host, reference sources read-only under `/refs`. Details in `docs/ai-team/docs/coding_guidelines.md`.

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

### Folder structure

```
.
├── AGENTS.md                    # This file
├── README.md
├── .devcontainer.json           # Development container (all work happens inside it)
├── .github/workflows/
│   ├── build.yml                # CI placeholder: format, build, documentation, user-docs, tests
│   └── deploy.yml               # Release placeholder (tag pushes)
└── docs/                        # Project docs: knowledge base, feature review
    └── proposals/               # Design proposals under discussion (not specs)
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
