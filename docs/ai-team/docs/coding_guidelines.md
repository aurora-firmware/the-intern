# Coding guidelines

Project-specific rules for writing code in `bob`, the TypeScript rework of the Intern on
`@earendil-works/pi-durable`. General TypeScript practice (types, narrowing, imports, async and cancellation, error
handling, test style, review checklist) comes from the `pi-agent-dev:typescript-best-practices` skill and is not
repeated here; this document adds only what is specific to this project, and wins where the two differ.

The background for most rules is in [pi-durable-knowledge.md](../../pi-durable-knowledge.md) (sections 5 and 6) and
[feature-review.md](../../feature-review.md). Approved specs and accepted ADRs win over this document; when they
disagree, fix this document.

## Development environment

- All development, tests and runs happen inside the devcontainer (`.devcontainer.json`). The container
  user is `ubuntu`, with its UID remapped to the host user's and passwordless `sudo`.
- The image is pinned to a tag whose pi CLI matches the pi SDK versions in `package.json`. Upgrade the image tag and
  the pi packages together.
- `~/.pi` is bind-mounted from the host: it holds the user's pi login, settings and models, shared with the host's pi.
  Read it, never write to it, and never point tests at it.
- Reference sources are mounted read-only under `/refs` (for example `/refs/pi-mono`). Never write there. Before
  writing commits, hooks or tools, read `/refs/pi-mono/packages/durable/docs/spec.md` §12 ("API footguns"), and use
  `/refs/pi-mono/packages/durable/test/examples` as the API reference.
- Local state for manual runs goes in a git-ignored `.tmp/` inside the workspace, never in the real XDG directories.

## Runtime and tooling

| Concern | Choice |
|---|---|
| Runtime | Node 24 runs the `.ts` sources directly (type stripping). No build step |
| Typecheck | `tsc --noEmit` |
| Format and lint | Biome. Tabs, indent width 3, 120 columns (as pi-mono) |
| Tests | `node:test` with `node:assert/strict` |
| SQLite | `node:sqlite` (no native addon) |
| Packages | npm with a committed lockfile; `.npmrc` sets `save-exact` and `engine-strict` |

- Type stripping means only erasable syntax (`erasableSyntaxOnly`): no `enum`, no `namespace`, no constructor
  parameter properties. Running code proves nothing about types; `tsc --noEmit` must pass.
- Pin every dependency to an exact version. The pi packages (`pi-durable`, `pi-ai`, `chord`, `pi-coding-agent`) stay
  on the same version, and `README.md` records which one is in use.
- Import pi packages only through their public exports, never through deep `dist/` or `src/` paths.
- Add a dependency only when it removes real code. Prefer Node built-ins.

## Naming

- File names are lowercase `snake_case.ts`; tests are `<module>.test.ts` (for example `schedule_store.test.ts`).
- Durable document and memo keys are namespaced: `bob.<name>` for documents, `<extension>.<name>` for memos (for
  example `bob.approvals`, `bob-policy.verdict`).
- Request ids encode their source: `job:<id>:<fireTime>` for schedule fires. Follow this pattern for new sources.

## Module structure

- **Pure core.** Decision logic (policy evaluation, schedule parsing and validation, settings mapping, transcript
  mapping) imports neither pi-durable nor I/O, and is tested without a harness.
- **pi-durable sits behind a narrow host module plus bob's extensions.** Nothing else imports pi-durable. The API
  changes between releases; this keeps an upgrade to a few files.
- **Every channel ends in the same call** (`conversation.submit({ requestId, whenBusy })`). Channel-specific knowledge
  stays in its adapter; the core never learns channel names.
- **One source of truth per fact.** Runtime state (conversations, approvals, job map, memos) lives in the database as
  documents. Operator-edited inputs (config, policy, `schedules.json`, skills) stay files. Never copy a fact between
  the two.
- **Release-owned content loads by path from inside the package** (shipped skills, prompt text). No copy or install
  step. Operator customisation goes in an overlay loaded after the shipped content.

## Durability rules (pi-durable)

- **Don't write recovery or retry code.** Resume, `requestId` dedup, the follow-up queue and waiting for approvals are
  library features. If you find yourself writing a retry loop or an intake table, check the library first.
- **Effect sandwich.** Commit the intent, perform the effect, commit the outcome. A handler reopened in an intent phase
  must assume the effect may have happened.
- **Never mark an effectful tool `replay: "safe"`.** Effects are checkpointed, not exactly-once.
- **Inside a `commit()` callback:** never await a model or the network; mutate drafts in place; never return a value
  read from a draft (return a JSON copy made inside the callback).
- **Write related state in the same commit** that creates what it describes (for example the job → conversation map
  in the `createConversation({ init })` commit), so a crash can't leave the two out of step.
- **Select guard extensions explicitly** in the extensions array. A guard left out of an array selection doesn't run.
  `configure({ extensions: { add, remove } })` edits the host default, not the conversation's list.
- **Close and abort look the same to a hook.** To tell them apart, check `abortRequested` and
  `abortReason !== "restart"` on the task record.
- **Convert between pi-ai and pi-durable JSON types** at the boundary with a JSON round trip.
- **Keep prompt sections byte-stable** across turns; unstable text defeats provider caching. Test it.
- **Shutdown closes the Harness and cached model connections**, or the process hangs.
- **A storage error closes the Harness.** Let `serve` exit non-zero and rely on the OS supervisor; don't recover
  in-process.

## Security and failure behaviour

- **Fail closed on the membrane, fail open on content.** A throwing policy hook blocks the call; a configured policy
  file that is missing or invalid stops startup. A missing or broken skill renders no prompt section and logs a
  diagnostic.
- Policy is deterministic and the agent can't see or change it. `evaluate()` is a pure function.
- Filesystem permissions are the boundary. Create state and runtime directories `0700` and owner-only files. Don't add
  checks that can't reject anyone behind them (such as a uid allow-list behind a `0700` directory).
- No credentials in the repository, state directory, logs or audit records. Models authenticate through the user's pi
  login.
- pi's context loader reads `AGENTS.md`/`CLAUDE.md` from the parent directories of a working directory; keep that in
  mind for working directories and test fixtures.
- Validation runs the same at every entry point; something accepted when added must not be denied when used.

## Tests

- Test-driven: write a failing test before the change (see the `tdd` skill).
- Integration tests use a real Harness on a temporary SQLite file.
- **Never call a real model in the test suite.** Use a deterministic fake model whose reply is a pure function of the
  transcript (a self-re-appending `FauxResponseFactory`); the default queue-based faux provider breaks on restart.
- Durability claims need a restart test: kill or close mid-run, reopen, assert on the resumed outcome.
- Don't swap the real pi packages for substitutes to get a test passing; only the model is faked.
- Tests are hermetic: temporary directories for state and runtime paths, no dependence on `~/.pi`, a running
  `bob serve` or inherited environment variables.
