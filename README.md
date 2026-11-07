# the-intern

The Intern is an agent that works for a team. It runs unattended on a machine the team keeps running and takes jobs
from anyone who can reach it: through the command line, a web interface or its own email address. It sees each job
through to the end. It defines the job (goal, needs, plan and definition of done), gets what is missing by asking
back only when it lacks something, acts, and verifies the result before closing the job with the evidence.

Its main uses are:

- one-off objectives, such as "find out why the nightly build got slower and fix it";
- recurring housekeeping, such as checking every night that the backups ran and the services answer;
- keeping the team's documentation current.

The Intern runs as one account of the machine it is installed on and acts with that account's credentials and access.
What it can do is bounded by what that account can reach, not by approval rules for each action.

Its service, `bob`, is one TypeScript package that embeds pi as a library on `@earendil-works/pi-durable`. The
product scope is in [S-000, the system overview](docs/ai-team/specs/S-000-system-overview.md); the team-member
documentation is the [user manual](docs/manual/index.md). Most of the product is not implemented yet.

## Start here

- [pi-durable and pi SDK knowledge base](docs/research/pi-durable-knowledge.md): what pi-durable and the
  coding-agent SDK provide, how they fit together, prototype results and the API footguns.
- [Feature review](docs/research/feature-review.md): the direction for each feature and the open design decisions.

## Development environment

Prerequisites:

- Git and Node.js 24 (the sources run directly on Node's type stripping; the `engines` field will enforce the
  minimum).
- Using [mise](https://mise.jdx.dev/) is suggested, to fix the tool versions for everyone working on the project;
  `mise.toml` pins Node, uv and Python. Any other way to get the same versions works as well.
- The `ai-team` CLI drives the development process. `mise run setup:ai-team` installs the pinned release into
  `.tmp/tools`. A git-ignored `mise.local.toml` may override `AI_TEAM_REF` to try another version.
- util-linux `script`, for the tests of `bob chat` on a terminal: it gives them a pseudo-terminal. Where it is missing
  those tests are skipped, and they fail when the environment variable `CI` is set.
- The pi CLI logged in to a model provider, only for manual runs against a real model. The test suite never calls a
  real model.
- Browsers, for `npm run test:web`. Chrome and Firefox are required; Edge is good to have. Next to an installed Chrome,
  `npx playwright-core install firefox` is enough. A missing browser skips its tests with a diagnostic. With
  `BOB_WEB_ALL_BROWSERS=1`, as CI sets, a missing Chrome or Firefox fails them instead. Edge's tests run where Edge is
  installed (`npm run test:web:setup:edge` installs it) and are skipped where it isn't. See
  `docs/development/tech_stack.md`, Test harness.

Keep the state of manual runs in a git-ignored `.tmp/` directory inside the working copy. Tests use temporary
directories and must not touch your own pi configuration.

## Building from scratch

These steps take a fresh clone to a checked working copy:

1. Clone the repository and check out `dev-pi-durable`.
2. Install the tools (with mise: `mise install`, then `mise run setup:ai-team`) and confirm `node --version`
   reports 24.
3. Install the dependencies from the lockfile: `npm ci`.
4. Run all checks (typecheck, `biome check` for lint and format, and the tests): `npm run check`.
5. Build the user manual: `npm run docs:build`.

There is no build step for the sources; Node runs the `.ts` sources directly. `npm run docs:build` builds only the
user manual, as a static site.

## pi version compatibility

This README is the canonical record of the pi versions the project is tested against. No backwards compatibility is
guaranteed. When the pi version in use changes, update this section; specs and ADRs don't pin pi versions.

- Target: `@earendil-works/pi-durable`, `pi-ai`, `chord` and `pi-coding-agent` 1.4.0 (exact pins in `package.json`
  and `package-lock.json`, released 2026-10-21) with Node 24. The changes between
  pi versions are analysed in `docs/research/pi-durable-knowledge.md` §7.
