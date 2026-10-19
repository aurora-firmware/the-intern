# the-intern

The Intern is an AI office-assistant project. Its service, `bob`, is being rebuilt from a clean slate as one
TypeScript package that embeds pi as a library on `@earendil-works/pi-durable`, in place of the previous Rust service
that supervised `pi` child processes. The previous implementation, specs and ADRs are in git history before the
clean-slate commit.

Nothing is implemented yet.

## Start here

- [pi-durable and pi SDK knowledge base](docs/pi-durable-knowledge.md): what pi-durable and the
  coding-agent SDK provide, how they fit together, the proof-of-concept results and the API footguns.
- [Feature review](docs/feature-review.md): every feature of the previous bob with its verdict for the
  new version, and the open design decisions.

## Development environment

Prerequisites:

- Git and Node.js 24 (the sources run directly on Node's type stripping; the `engines` field will enforce the
  minimum).
- Using [mise](https://mise.jdx.dev/) is suggested, to fix the tool versions for everyone working on the project;
  `mise.toml` pins Node, uv and Python. Any other way to get the same versions works as well.
- The `ai-team` CLI drives the development process. `mise run setup:ai-team` installs the pinned release into
  `.tmp/tools`. A git-ignored `mise.local.toml` may override `AI_TEAM_REF` to try another version.
- The pi CLI logged in to a model provider, only for manual runs against a real model. The test suite never calls a
  real model.

Keep the state of manual runs in a git-ignored `.tmp/` directory inside the working copy. Tests use temporary
directories and must not touch your own pi configuration.

## Building from scratch

There is no package yet, so these steps describe the intended flow and will be corrected when the package lands:

1. Clone the repository and check out `dev-pi-durable`.
2. Install the tools (with mise: `mise install`, then `mise run setup:ai-team`) and confirm `node --version`
   reports 24.
3. Install the dependencies from the lockfile: `npm ci`.
4. Typecheck: `npx tsc --noEmit`. Format and lint: `npx biome check`. Test: `node --test`.

There is no build step; Node runs the `.ts` sources directly.

## pi version compatibility

This README is the canonical record of the pi versions the project is tested against. No backwards compatibility is
guaranteed. When the pi version in use changes, update this section; specs and ADRs don't pin pi versions.

- Target: `@earendil-works/pi-durable`, `pi-ai`, `chord` and `pi-coding-agent` 1.3.0 (exact pins, released
  2026-10-15) with Node 24. Nothing is built or pinned in a lockfile yet. The proof of concept ran on 1.2.0; the
  differences are analysed in `docs/pi-durable-knowledge.md` §7.
