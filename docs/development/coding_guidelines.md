# Coding guidelines

Project-specific rules for writing code in The Intern (`the-intern`), a TypeScript service on
`@earendil-works/pi-durable`. General TypeScript practice (types, narrowing, imports, async and cancellation, error
handling, test style, review checklist) comes from the `pi-agent-dev:typescript-best-practices` skill and is not
repeated here; this document adds only what is specific to this project, and wins where the two differ.

Terms follow the vocabulary of [system_overview.html](../system_overview.html) (section 4): team member, job, job
source, service account, way in. Where a term exists in both runtimes, write "pi-durable X" or "pi agent X".

Read [S-000](../ai-team/specs/S-000-system-overview.md) first: it is the source of truth for scope. The background for
most rules is in [pi-durable-knowledge.md](../research/pi-durable-knowledge.md) (sections 5 and 6).
[feature-review.md](../research/feature-review.md) is background only; S-000 wins where they differ. Approved specs and
accepted ADRs win over this document; when they disagree, fix this document. The tool choices are recorded in
[tech_stack.md](tech_stack.md).

## Runtime and tooling

| Concern | Choice |
|---|---|
| Runtime | Node 24 runs the `.ts` sources directly (type stripping). No build step |
| Typecheck | `tsc --noEmit` |
| Format and lint | Biome. 4-space indentation, 120 columns |
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

- File names are lowercase `snake_case.ts`; tests are `<module>.test.ts` (for example `job_store.test.ts`).
- Durable document and memo keys are namespaced by their owner, so two owners never share a key.
- A request id is derived from what it admits (its job source and the event), so submitting the same input twice is
  deduplicated by pi-durable. The spec that adds a job source defines its request id.

## Module structure

- **Pure core.** Decision logic (schedule parsing and validation, settings mapping, transcript mapping) imports
  neither pi-durable nor I/O, and is tested without a harness.
- **pi-durable sits behind a narrow host module plus the-intern's own extensions** (ADR-001). Nothing else imports
  pi-durable. The API changes between releases; this keeps an upgrade to a few files.
- **Every job source ends in the same service operation.** A way in or a job source (a team member, a schedule, a
  trigger, a follow-up) submits through the service layer. Knowledge of one source stays in that source; the core
  never learns source names.
- **One source of truth per fact.** Runtime state lives in the one database file. Conversations, memos and the
  daemon's own facts about a conversation are pi-durable documents. Jobs live in the job store's `intern_` tables,
  never in pi-durable documents, and the job store never reads or writes pi-durable's tables (ADR-001 decision 1).
  Team-edited inputs (configuration, skills, instructions) stay files. Never copy a fact between these places.
- **The job model and the job store stay free of pi packages.** `src/jobs/job_model.ts` imports nothing, and
  `src/jobs/job_store.ts` reaches the database only through the host's `HostDatabase`. A job store write never runs
  inside a pi-durable `commit()`, and a pi-durable commit never runs inside a job store transaction.
- **Release-owned content loads by path from inside the package** (shipped skills, prompt text). No copy or install
  step. Team customisation goes in an overlay loaded after the shipped content.

## Command line

The `bob` commands (`src/cli/`, [S-005](../ai-team/specs/S-005-command-line.md)) follow these rules. A later spec that
adds a command group follows them too, and does not change them without amending S-005.

- **One noun per component.** A group is named for the thing a team member works with (`jobs`, `conversations`,
  `roles`), has its commands in a file `src/cli/<name>_commands.ts` that exports its `CommandSpec` entries, and joins
  the `COMMANDS` table in `src/cli/commands.ts`. `jobs`, `conversations` and `roles` have their own files; `workspaces`
  and `models` share `roles_commands.ts`, and `bob follow` and `bob jobs follow` share `follow_commands.ts`. `bob chat`, the third following command, has
  `chat_command.ts` and `chat_terminal.ts`. A group that is
  reserved for a later spec (`RESERVED_GROUPS` in `command_line.ts`) leaves that list in the change that adds it.
- **Curated commands.** A command is named for what a team member does (`bob jobs answer`), not for the operation it
  calls. It calls the operations its spec names for it, and every option maps to the input of the same meaning in the
  operation.
- **The shared verbs.** Use `bob <group> <verb> [arguments] [options]`, with the verbs `list`, `show`, `create`,
  `change` and `remove` where they apply.
- **The shared options.** A data command takes `--json`, a command that calls the service takes `--runtime-dir`
  (else `BOB_RUNTIME_DIR`, else the default runtime directory), and every command takes `--help`. Declare `isData` and
  `callsService` on the `CommandSpec`; the parser adds these options from them.
- **Output.** Data goes to standard output; errors, notices and hints go to standard error. No colour, prompt or
  interactive step appears when standard input or output isn't a terminal. Print through `src/cli/output.ts`.
- **`--json` prints the service's answer unchanged**, with `writeJson`. A `show` command that calls several operations
  prints one object keyed by operation name, each value that operation's answer. A following command prints one JSON
  value per line. The wording of text output may change; command names, `--json` output and exit codes may not.
- **Exit codes.** `0` success, `1` the service refused or failed (its error code and message on standard error), `2` a
  usage error or a reserved group, `3` the daemon can't be reached. Use `EXIT_CODES` and `withClient`
  (`src/cli/connection.ts`), which maps the client's errors to them.
- **A thin client.** A command validates nothing and resolves no short number the service does, and keeps no file, cache
  or history. It reaches the daemon only through the client library. No daemon module (daemon, host, service, listeners,
  jobs, agents) is imported by a command other than `serve` and `import`, and those load theirs by a dynamic `import()`
  inside `run`, so a command that only calls the service starts quickly. The one exception is
  `src/daemon/state_layout.ts`, which `connection.ts` imports to resolve the runtime directory and which imports only
  Node modules. To check, list the modules a run loads with
  `node --import ./test/support/module_trace.ts src/cli/bob.ts <command>`: it prints that file and nothing else from the
  daemon, host, service, listeners, jobs or agents folders.
- **Words.** Help and messages say team member, job and invokes, never user, subagent or task in its general sense.
- **The command reference page changes in the same change as a command** (S-005 REQ-017):
  `docs/manual/commands.md` lists every command, its arguments and options, its JSON output and its exit codes, so a
  command, option or output that changes leaves the page wrong until it changes too.

## Durability rules (pi-durable)

- **Don't write recovery or retry code** (ADR-001). Resume, `requestId` dedup and the follow-up queue are library
  features. If you find yourself writing a retry loop or an intake table, check the library first. Decision 4 allows
  two bounded exceptions, and nothing else:
  - The-intern's own facts about a conversation (held messages, awaiting links, parked state, the abort mark, the
    closed mark, creation keys) are pi-durable documents committed with the change they describe, and the only
    recovery is redelivering the input they show as undelivered, made safe to repeat by request ids.
  - A job write is committed before the pi-durable change it goes with, and the four startup repair rules of S-004
    REQ-018 (`src/jobs/job_repair.ts`) are the only job recovery. Rule 4 closes and aborts the conversations of a Done
    job that a crash left open. Rule 3 also covers input the lead took since the job
    blocked, read from the entry the block recorded in `blockedAfterEntry`, and always clears the park the block made,
    so the turn-end rule applies to the lead's next stop. A fifth rule, a retry of a failed job
    write or a timer that checks jobs amends ADR-001 first.
- **Effect sandwich.** Commit the intent, perform the effect, commit the outcome. A handler reopened in an intent phase
  must assume the effect may have happened.
- **Never mark an effectful tool `replay: "safe"`.** Effects are checkpointed, not exactly-once.
- **Inside a `commit()` callback:** never await a model or the network; mutate drafts in place; never return a value
  read from a draft (return a JSON copy made inside the callback).
- **Write related state in the same commit** that creates what it describes (for example the job to conversation map
  in the `createConversation({ init })` commit), so a crash can't leave the two out of step.
- **Select extensions explicitly** in the extensions array. An extension left out of an array selection doesn't run.
  `configure({ extensions: { add, remove } })` edits the host default, not the conversation's list.
- **Close and abort look the same to a hook.** To tell them apart, check `abortRequested` and
  `abortReason !== "restart"` on the pi-durable task record.
- **Convert between pi-ai and pi-durable JSON types** at the boundary with a JSON round trip.
- **Keep prompt sections byte-stable** across turns; unstable text defeats provider caching. Test it.
- **Shutdown closes the Harness and cached model connections**, or the process hangs.
- **A storage error closes the Harness.** Let the daemon exit non-zero and rely on the operating system's supervisor;
  don't recover in-process (ADR-001). A job store write that fails with anything but a refusal is a storage error too.

## Security and failure behaviour

- **The service account is the boundary** (ADR-002). Anyone who can reach a way in is a team member, and no operation
  reads transport details or the caller's identity to decide its outcome.
- **Fail explicitly at startup, fail open on content.** A configuration that is present but invalid stops startup with
  a message naming the file and the problem. A missing or broken skill renders no prompt section and logs a
  diagnostic.
- Owner-only files: create state and runtime directories `0700` and every file accessible only to the service account.
  An existing directory that is accessible to the group or others, or not owned by the service account, stops startup.
  Don't add checks that can't reject anyone behind them (such as a uid allow-list behind a `0700` directory).
- No credentials in the repository, state directory, database or logs. Models and every other credential are the
  service account's, used in place: models authenticate through the service account's pi agent login, and nothing is
  copied into the instance's directories.
- pi agent's context loader reads `AGENTS.md`/`CLAUDE.md` from the parent directories of a working directory; keep
  that in mind for working directories and test fixtures.
- Validation runs the same at every way in; something accepted when added must not be denied when used.

## Tests

- Test-driven: write a failing test before the change (see the `tdd` skill).
- Integration tests use a real Harness on a temporary SQLite file.
- **Never call a real model in the test suite.** Use a deterministic fake model whose reply is a pure function of the
  transcript (a self-re-appending `FauxResponseFactory`); the default queue-based faux provider breaks on restart.
- Durability claims need a restart test: kill or close mid-run, reopen, assert on the resumed outcome.
- Don't swap the real pi packages for substitutes to get a test passing; only the model is faked.
- Tests are hermetic: temporary directories for state and runtime paths, an isolated pi agent folder, no dependence on
  the user's own pi configuration, a running daemon or inherited environment variables.
- Tests are kept apart by folder (`test/unit`, `test/service`), as recorded in `tech_stack.md`.
