# Technology stack

This file records the answers to the "Decisions needed" of the development infrastructure components in
`docs/ai-team/specs/S-000-system-overview.md`. The product owner settled them in an interview on 2026-10-30. There is
one section per component, and each answer sits under the question it settles. A question that is still open says so
and names where it is decided.

Control endpoint, Web interface, Schedules, Skills and instructions and Email aren't among those components: they
record the technology choices of S-003, S-006, S-007, S-008 and S-009.

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
`test:service` and `test:web` run one folder each. `test:web` runs at most 2 files at a time (`--test-concurrency=2`)
and `test:service` at most 10 (`--test-concurrency=10`): on a busy machine, more files at once only slow each test past
its waits. Each wait and timeout a test writes goes through `scaled()` in `test/support/time_scale.ts`. The environment
variable `TEST_TIME_SCALE` (1 to 10) multiplies them; without it, the factor is twice the one-minute load average per
core, between 2 and 4. Each of the three scripts sends two reporters to two places: the `dot` reporter to the terminal,
which then shows one character per test and a "Failed tests:" block with each failure's error and stack, and the `spec`
reporter to `.tmp/test-logs/<folder>.log`, which holds every test and its console output. A script creates
`.tmp/test-logs` first, so a fresh checkout works. `test:verbose` runs the three folders with the `spec` reporter on the
terminal. The CI workflow uploads `.tmp/test-logs/` as an artifact when the test step fails.

**Which tool drives the browser in `test/web`?** `playwright-core` 1.65.0, a dev dependency, driven from `node:test`. It
covers all of S-006 REQ-021's browsers: Chrome, and Edge where it is installed, through their real builds
(`channel: "chrome"`, `channel: "msedge"`) and Firefox through Playwright's own build, and it records downloads,
separate contexts and keyboard input. Its test runner, `@playwright/test`, isn't used, so the project keeps one runner.
`axe-core` 4.14.0, a dev dependency, runs the contrast check of S-006 AC-020.1 in the page. Puppeteer's Firefox and Edge
support is thinner, and Selenium needs a driver per browser. Playwright can't drive a stock Firefox, so a by-hand pass
covers one before a release.

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
Against in-process fake servers and a fake OAuth provider, with no network beyond the loopback. S-009's Feature
Architecture settled it; the answer is under Email below.

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
stay as they are. It sets `HOME=/root` for the whole job, because the runner's `/github/home` is owned by `node` and
Firefox won't start as root there; the install and the tests then share `/root/.cache/ms-playwright`. It adds two steps
before `npm test`, and sets `BOB_WEB_ALL_BROWSERS=1`. `Install Chrome and Firefox for web tests` runs
`npm run test:web:setup` and fails the job when it fails. `Install Edge for web tests` runs
`npm run test:web:setup:edge` with `continue-on-error: true` and `timeout-minutes: 15`, so a failed or hung Edge install
doesn't fail the job, and Edge's tests are then skipped. In `node:24.22.0-bookworm` as root, one install step, as it was
before it split in two, installed Chrome 157, Edge 157 and Firefox 159, and ADR-006's probe page then ran on all three,
measured on 2026-11-06. It adds about 1.4 GB per run, downloaded again each time because the container is new. A
prepared image is the way to cut that if the time matters; nothing depends on it.

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

## Schedules

This answer settles S-007's Open Question. The design is in [architecture.md](architecture.md), Schedules.

**Which library works out due times?** None. `src/schedules/schedule_time.ts` is a small module of our own, with no new
dependency. `croner` was the feature review's preference, and version 11.0.0 was measured against REQ-005 on 2026-11-07:

| Rule | `croner` 11.0.0, `TZ=Europe/Madrid` | REQ-005 |
|---|---|---|
| `30 2 * * *` on 28 March 2027, when 02:30 doesn't exist | Runs at 03:00 | Doesn't fire |
| `*/20 2 * * *` on 31 October 2027, when 02:00 to 02:59 repeat | Runs each time in both passes, 6 runs | Each time once, 3 runs |
| `0 0 L * *`, `0 0 * * MON`, `@daily`, and six and seven fields | Accepts them | Five fields of `*`, numbers, lists, ranges and steps |
| Both day fields restricted, 0 and 7 as Sunday | Either day is due, 7 is Sunday | The same |

So `croner` would need a matcher of our own to catch the moved and repeated runs and a parser of our own to refuse the
extra forms. The scheduler's tick reads an injected clock and applies REQ-007's one-minute rule itself, so `croner`'s
timer wouldn't be used either. That leaves it nothing to do, and `coding_guidelines.md` adds a dependency only when it
removes real code. JavaScript's local-time rule gives both clock change rules directly: `new Date(y, m, d, h, min)`
moves a time that doesn't exist forward, so reading it back shows it, and takes the earlier instant of a repeated one.
This was measured on Node 24.22.0 in Madrid, Lord Howe and Havana.

**Where does the local time zone come from?** The daemon process's own, through `Date`. S-007 has no time zone setting.

## Skills and instructions

These answers record S-008's technology choices. The design is in [architecture.md](architecture.md), Skills and
instructions, and the durable parts in
[ADR-009](../ai-team/decisions/ADR-009-the-internal-folder-is-the-live-copy-of-shipped-text-tracked-by-a-manifest.md).
S-008 adds no dependency.

**What finds and reads skills?** `src/skills/skill_discovery.ts`, a walk of our own, with `parseFrontmatter` from
`@earendil-works/pi-coding-agent` 1.4.0, so a `SKILL.md` reads as pi agent reads it. pi agent's `loadSkills` and
`loadSkillsFromDir` were read in `dist/core/skills.js` on 2026-11-13, and differ from S-008 REQ-004 in five ways:

| pi agent's loader | S-008 REQ-004 |
|---|---|
| The first of two copies of a name wins | A later search path wins, and the workspace wins over all |
| Copies in one folder come in `readdir` order | The copy whose folder path sorts first by bytes wins, with a diagnostic |
| A `.md` file with a description at a source's root is a skill | A skill is a folder holding `SKILL.md` |
| `.gitignore`, `.ignore` and `.fdignore` hide folders, and hidden folders and `node_modules` are skipped | Skills are found at any depth below a source |
| A shadowed copy is a collision diagnostic, with no record of its source | `skills.list` shows each shadowed copy with its source |

Its result would have to be undone and redone, so the walk is ours. It is synchronous in pi agent; ours uses
`node:fs/promises`, because the catalog is read before every model request.

**What writes the skill listing?** `renderSkillListing` in `src/prompt/role_prompt.ts`. pi agent's
`formatSkillsForPrompt(skills, fileReadTool)` can only tell the model to load a skill with `read`, with `bash`, or with
no tool named, and S-008 REQ-008 asks the listing to name `skill`. The listing keeps the Agent Skills
`<available_skills>` shape that function writes.

**Which size limit does `skill` use?** `truncateHead` from `@earendil-works/pi-coding-agent`, with its
`DEFAULT_MAX_LINES` (2000) and `DEFAULT_MAX_BYTES` (50 KiB), the limits of pi agent's `read` tool (S-008 REQ-008). A pi
upgrade that changes them changes `skill` with them.

**What is a version token?** The SHA-256 hex of the file's bytes, from `fingerprintOf` in `src/config/config_file.ts`,
the configuration file's fingerprint (ADR-009 decision 5).

**How is UTF-8 text checked?** `new TextDecoder("utf-8", { fatal: true })`, which throws on bytes that aren't UTF-8.

**How does the `about-the-intern` skill stay in step with the manual?** It bundles byte copies of the manual pages it
draws from, and a unit test compares them with `docs/manual/` (S-008 REQ-017). No generator: a copy is the simplest
thing a check can compare exactly, and VitePress markup in a page reads well enough to a model. `biome.json` excludes
`src/shipped/skills/about-the-intern/manual`, because Biome would reformat the copies and `docs/manual/` is outside its
includes.

**How does an agent run `bob`?** pi-durable's `createBashTool` with a `prepare` hook, which adds the instance's
runtime directory, the conversation id and a launcher folder to the command's environment (S-008 REQ-014).

## Email

These answers settle S-009's Open Questions on libraries, test servers and sign-in. The design is in
[architecture.md](architecture.md), Email, and the durable parts are in
[ADR-010](../ai-team/decisions/ADR-010-accounts-share-one-sign-in-layer-and-one-owner-only-secrets-store.md) (the
accounts layer and the secrets store) and
[ADR-011](../ai-team/decisions/ADR-011-saved-mail-lives-in-the-database-and-agents-read-a-written-out-copy.md) (saved
mail).

**Which libraries speak IMAP and SMTP and read messages?** Three runtime dependencies, pinned exactly, chosen with the
product owner's preference and the research of 2026-11-17. Only the adapter modules in `src/mail/` import them
(`docs/development/coding_guidelines.md`, Module structure).

| Library | Version, licence | Used for | Points to keep |
|---|---|---|---|
| `imapflow` | 2.12.1, MIT | IMAP: IDLE, UIDVALIDITY and UIDNEXT, SPECIAL-USE folders, MOVE, flags, APPEND, SASL XOAUTH2, TLS and STARTTLS | Its default logger is `pino`; it always gets `logger: false`. `messageMove` falls back to COPY and EXPUNGE on a server without MOVE, so the adapter checks the MOVE capability itself and refuses. The adapter never calls `mailboxClose`, because IMAP CLOSE expunges messages a person marked deleted; it leaves a mailbox by selecting another or logging out |
| `nodemailer` | 10.6.0, MIT-0 | SMTP (`secure`, `requireTLS`, `ignoreTLS`, OAuth2 `accessToken`), and composing messages with its `nodemailer/lib/mail-composer` export | Gets `logger: false` and `debug: false`. A message is composed once; the same bytes go to SMTP as `raw` with an explicit `envelope`, to the Sent folder and to the Drafts folder |
| `postal-mime` | 4.2.1, MIT-0 | Reading a message: headers, text, HTML and attachments as bytes | No dependencies |

One person publishes all five mail packages, and their 2026 majors were mainly TypeScript rewrites. Each is reached
through one adapter (`imap_client.ts`, `smtp_client.ts`, `mime.ts`), so replacing one touches one file. They add no
native addon.

**Why not the himalaya command-line program?** S-009, Open Questions, records the research: its commands and JSON
output broke in each major version, one person maintains it, its message summary has no `References` header, push is a
separate tool at version 0, each call opens a new connection, and the project's earlier use of v1.2.0 met five defects
(B-034, B-050 to B-053). A library in the daemon keeps one connection per account and gives the headers job threads
need.

**How does sign-in work without the providers' libraries?** With Node's `fetch` against the providers' documented
OAuth 2.0 endpoints, in `src/accounts/` (ADR-010 decision 3). `@azure/msal-node` and `google-auth-library` are not
used.

| `auth` | Flow | Endpoints | Scopes |
|---|---|---|---|
| `microsoft` | Device code, public client | `https://login.microsoftonline.com/<tenant>/oauth2/v2.0/devicecode` and `/token` | `offline_access https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send` |
| `google` | Authorization code with PKCE (S256) and the client secret of a "Desktop app" client, answer to `http://127.0.0.1:<port>` | `https://accounts.google.com/o/oauth2/v2/auth` with `access_type=offline` and `prompt=consent`, then `https://oauth2.googleapis.com/token` | `https://mail.google.com/` |
| `microsoft_app` | Client credentials | `https://login.microsoftonline.com/<tenant>/oauth2/v2.0/token` | `https://outlook.office365.com/.default` |

IMAP and SMTP log in with SASL XOAUTH2, the mailbox address as user. The scopes are the mail code's; the endpoints
are the accounts layer's. The task that writes the manual's sign-in steps (S-009 REQ-025) checks each value against
the providers' documentation of that day. Tests replace the endpoints with the fake provider's.

**How is the HTML part turned into text?** `src/mail/html_text.ts`, a pure function of our own: it drops `script` and
`style`, turns block ends and `br` into line breaks, removes the tags and decodes entities. A converter library would
pull in an HTML parser for a fallback that the model only reads.

**How is the password command run?** `execFile` from `node:child_process`, with no shell, the list from
`password_command` as the program and its arguments, a 30-second limit and at most 64 KiB of standard output, whose
trailing line end is removed (S-009 REQ-004). Its output is never logged; a failure reports the exit status only.

**How does `bob` read a secret?** `src/cli/secret_prompt.ts` sets standard input to raw mode on a terminal and echoes
nothing; `--secret-stdin` reads standard input to its end and removes one trailing line end. No flag or environment
variable carries a secret (S-009 REQ-017).

**How is email tested without a real mail server?** In-process fakes, as dev dependencies pinned exactly:

- `imapkit` 5.3.2 (MIT) serves IMAP and `smtp-server` 3.21.6 (MIT-0) receives SMTP, on loopback ports, both behind
  one helper, `test/support/fake_mail_server.ts`. `imapkit` first shipped in October 2026, so no test imports it
  directly and a replacement changes that file alone. The helper holds mailboxes in memory, delivers a message to an
  inbox, records every message its SMTP side receives (S-009 AC-016.1 scans them), can stop answering and answer
  again, can answer slowly (AC-005.2), can refuse a recipient permanently (AC-022.3), and can leave IDLE out of its
  capabilities (AC-023.1).
- `test/support/fake_oauth_provider.ts`, on `node:http`, answers the device code, authorization code, refresh and
  client credentials requests, rotates refresh tokens, and revokes one on request (AC-004.1 to AC-004.3).
- A test-only certificate authority and a `localhost` certificate, valid for 100 years, live in
  `test/fixtures/tls/`. They grant access to nothing; a test trusts them by `NODE_EXTRA_CA_CERTS` in the daemon child,
  and leaves them untrusted where a certificate must fail to verify (S-009 REQ-001).
- The mail component takes a test-only clock, as the schedules component does, so retries and check intervals run
  under test time (AC-005.1, AC-023.1).

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
