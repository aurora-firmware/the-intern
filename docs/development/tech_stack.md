# Technology stack

This file records the answers to the "Decisions needed" of the development infrastructure components in
`docs/ai-team/specs/S-000-system-overview.md`. The product owner settled them in an interview on 2026-10-30. There is
one section per component, and each answer sits under the question it settles. A question that is still open says so
and names where it is decided.

Control endpoint isn't one of those components: it records technology choices moved out of S-003.

## Development environment

**Which language and runtime version is the solution written for?**
TypeScript, run directly on Node 24 by type stripping. There is no build step, so only erasable syntax is used.

**How is the tool set reproduced on a new machine, and is that the only supported way?**
mise is the recommended way to get the pinned tools (`mise.toml`). It is not required: any setup with the same
versions works.

**Which package manager is used, and how are dependency versions locked and upgraded?**
npm with a committed lockfile. Versions are pinned exactly (`save-exact` and `engine-strict` in `.npmrc`).
Dependencies are upgraded only by deliberate tasks, with no automatic bumps. A pi upgrade is its own task: all four
packages move together, the knowledge base and the `README.md` are updated, and the full suite is green. Other
dependencies are bumped in a task when needed.

**How are the agent runtime packages kept on one version, and where is that version recorded?**
The four pi packages (`@earendil-works/pi-durable`, `pi-ai`, `chord`, `pi-coding-agent`) stay on one version, recorded
in `README.md`. The bootstrap pins the latest release.

## Quality checks

**Which formatter, linter and type checker are used, and with which settings?**
`tsc --noEmit` checks types. Biome formats and lints, with 4-space indentation and 120 columns.

**Which checks block a merge, and which only warn?**
Every check blocks a merge into `dev-pi-durable`: format, lint, typecheck, tests and the user documentation build.
Nothing only warns.

**Where are the coding conventions written down, and who changes them?**
In `docs/development/coding_guidelines.md`. Anyone can propose a change in a task or pull request; the product owner
approves it. A rule that comes from a spec or an ADR changes with that spec or ADR.

## Test harness

**Which test runner is used, and how are unit, whole-service and web-interface tests separated?**
`node:test` with `node:assert/strict`. Tests are kept apart by folder: `test/unit`, `test/service` (the whole daemon,
including crash and resume) and `test/web` (real pages in real browsers against a daemon child). `npm test` runs them
all, `test/web` last and on its own, because its time checks suffer under the other folders' load; `test:unit`,
`test:service` and `test:web` run one folder each. `test:web` runs at most 2 files at a time (`--test-concurrency=2`).

**Which tool drives the browser in `test/web`?** `playwright-core` 1.65.0, a dev dependency, driven from `node:test`. It
covers all of S-006 REQ-021's browsers: Chrome, and Edge where it is installed, through their real builds
(`channel: "chrome"`, `channel: "msedge"`) and Firefox through Playwright's own build, and it records downloads,
separate contexts and keyboard input. Its test runner, `@playwright/test`, isn't used, so the project keeps one runner.
`axe-core` 4.14.0, a dev dependency, runs the contrast check of S-006 AC-020.1 in the page. Puppeteer's Firefox and Edge
support is thinner, and Selenium needs a driver per browser. Playwright can't drive a stock Firefox, so a by-hand pass covers one before a release.

Chrome and Firefox are required; Edge is good to have (S-006 REQ-021). `npm run test:web:setup` runs
`playwright-core install --with-deps chrome firefox` in CI, and `npm run test:web:setup:edge` runs the same for
`msedge`. On a developer's machine, `playwright-core install firefox` is enough next to an installed Chrome. A missing
Chrome or Firefox fails with a message naming the install command when `BOB_WEB_ALL_BROWSERS=1`, as CI sets, and
otherwise skips that browser's tests with a diagnostic. Edge's tests run where Edge is installed and are skipped, with
that diagnostic, where it isn't, whatever `BOB_WEB_ALL_BROWSERS` says. An Edge that is installed and fails to launch
still fails its tests. `PLAYWRIGHT_BROWSERS_PATH` doesn't affect Edge: Playwright finds it by channel at a system path.

**How does a deterministic fake model stand in for a real one?**
The fake model's reply is a pure function of the transcript.

**How is email tested without a real mail server?**
Against a local test mail server. Which one is open, to be decided in the Email spec.

**How are crash-and-resume tests run reliably?**
They kill and restart a daemon child process.

**How are tests kept away from a service the developer has running and from their personal configuration?**
Tests are hermetic: temporary directories, an isolated pi agent folder and no inherited environment.

**Is there a coverage or test-presence rule for changes?**
There is no coverage threshold. Every behaviour change comes with tests, enforced in review.

## Continuous integration

**Which continuous-integration service runs the jobs?**
GitHub Actions, on the self-hosted Linux runner, with every job in the official `node:24.22.0-bookworm` container
image from Docker Hub (Node, npm and git; the exact tag follows the Node version in use).

**Which jobs run on which events, and on which supported platforms?**
The jobs run on pull requests and on pushes to `dev-pi-durable` and `main`. Linux runs in continuous integration.
macOS (Apple silicon) is checked by hand before a release. No API documentation is generated.

**Which job results are required before a change merges?**
Every check listed under Quality checks: format, lint, typecheck, tests and the user documentation build.

**How do the browser tests get real browsers in CI?** The `Tests` job keeps its name and image, so the required checks
stay as they are. It adds two steps before `npm test`, and sets `BOB_WEB_ALL_BROWSERS=1`. `Install Chrome and Firefox
for web tests` runs `npm run test:web:setup` and fails the job when it fails. `Install Edge for web tests` runs
`npm run test:web:setup:edge` with `continue-on-error: true` and `timeout-minutes: 15`, so a failed or hung Edge
install doesn't fail the job, and Edge's tests are then skipped. In
`node:24.22.0-bookworm` as root, that step installed and then ran Chrome 157, Edge 157 and Firefox 159, measured on
2026-11-06. It adds about 1.4 GB per run, downloaded again each time because the container is new. A prepared image is
the way to cut that if the time matters; nothing depends on it.

## Installation and service setup

**What form does a release take: a package for an existing runtime, or a self-contained bundle?**
Open, pending the comparison in `docs/development/release_form.md`, where it will be decided.

**How is a release triggered, built and published?**
A version tag publishes a GitHub Release.

**How is the background service registered with each supported operating system, and how does it start at boot
without anyone logging in, on macOS in particular?**
A `bob` command registers and removes the boot-time service: systemd on Linux, launchd on macOS. How the service
starts at boot without a login on macOS is open, to be settled from the comparison in
`docs/development/release_form.md`.

**How does an upgrade export the job record from the old version and import it into the new one, and what happens to
jobs still in progress?**
An upgrade exports and imports the job record automatically. What happens to jobs still in progress during an upgrade
is open, to be settled from the comparison in `docs/development/release_form.md`.

## User manual

**Which documentation format and tool are used, and where is the manual published?**
Markdown, built into a static site and published to GitHub Pages. The tool is VitePress: it runs on the project's Node
toolchain, builds plain Markdown pages (which the shipped "explain The Intern" skill can read) and needs no extra
runtime. Its build output and cache go to the git-ignored `.tmp/` folder, and `npm run docs:build` builds the site.

**How is the manual kept in step with the commands, the web interface and the configuration?**
A task that changes a command, a web interface page or a setting updates the manual in the same change, and the
reviewer checks it.

## Developer documentation

**Which standing architecture decisions are recorded as decision records before development starts?**
ADR-001 (one daemon owns one pi-durable database) and ADR-002 (equal team members, bounded by the service account),
both in `docs/ai-team/decisions/`.

**Where does the shared vocabulary live, and how is it kept in step with the specs?**
Developer docs live in `docs/development/`. The shared vocabulary stays in `docs/system_overview.html`. A task that
changes a shared term updates it in the same change, and the reviewer checks it.

## Control endpoint

**Which HTTP support do the listeners and the client library use?**
The HTTP support built into Node and the browser, so they add no runtime dependency.

## Web interface

These answers settle S-006's Open Questions. The reasons are in
[ADR-006](../ai-team/decisions/ADR-006-web-pages-are-typescript-modules-with-no-build-step.md) and
[ADR-007](../ai-team/decisions/ADR-007-one-shared-worker-holds-a-browser-s-feed-connections.md).

**How are the pages written and built?** TypeScript ES modules in `web/ui/`, with erasable syntax only and no build step
(ADR-006). The listener strips their types as it serves them, with `amaro` 1.1.11, the version Node 24.22.0 bundles, so
moving Node moves this pin too.

**Which rendering and style libraries do they use?** `preact` 11.1.1 with `h()` calls, and our own CSS on S-006
REQ-016's tokens. Not Next.js, React, Tailwind, shadcn or Radix; the look comes from REQ-016's values and The Round
Table's measures. Lucide's icons are copied as path data. The fonts are copied `woff2` files, under the SIL Open Font
License.

**How do the installed package and CI get the files?** They are source files, so nothing is generated: a release carries
`web/ui/`, the two browser-safe client modules, `preact` and `amaro`. `npm run typecheck` adds `web/tsconfig.json` and
`web/tsconfig.worker.json`, and `web/types/preact.d.ts` gives `tsc` a stricter `h()` (ADR-006 decision 3). Biome adds
`web/**`. There is no `web:build` script and no CI build step.

**How do tabs share the browser's connections?**
One module `SharedWorker` holds at most two feed streams per browser profile (ADR-007).

## Local runs and diagnostics

**Where does a development instance keep its state, and how is it kept apart from a real one?**
In the git-ignored `.tmp/` directory, through the instance-directory flags (S-002 REQ-006), apart from any team's
instance.

**What logging and diagnostic output does the service give, and at which levels?**
One plain line per event on standard error (S-002 REQ-004). Each line holds an ISO-8601 timestamp, a level (`ERROR`,
`INFO` or `DEBUG`), the message, then `key=value` fields. The line written when the daemon is ready is:

```
2026-10-31T18:08:49.668Z INFO ready stateDir=/path/to/state intern=0.0.0 pi=1.4.0 workerThreads=32
```

`--verbose` shows the `DEBUG` lines; without it the daemon writes `ERROR` and `INFO` only.
journald and launchd capture the lines as they are. The product owner ruled
this on 2026-10-31.

**How does a developer inspect a running instance's state without opening its saved data directly?**
Through `bob` read commands, never by opening its database.
