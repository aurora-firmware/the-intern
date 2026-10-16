# pi-durable and the pi SDK: knowledge base for the rework

*Consolidated 2026-10-15. Input for the new version of the Intern (`bob`) built as one TypeScript package on
`@earendil-works/pi-durable`. Product decisions per feature are in [feature-review.md](feature-review.md). This
document replaces the research reports written against the old Rust service; everything still relevant from them is
here.*

## 0. Sources

| Source | Where |
|---|---|
| pi-durable package (1.2.0, 2026-10-12): README, `CHANGELOG.md`, normative `docs/spec.md` (5.3k lines; §12 "API footguns", §13 non-goals), 32 runnable examples in `test/examples` | Local clone `~/projects/pi-mono/packages/durable`; upstream `earendil-works/pi` (`badlogic/pi-mono` redirects there). Analysed at `main` `9fe3f37` |
| Announcement | <https://earendil.com/posts/pi-durable/> (2026-10-01) |
| Upstream durable demos (durable coding agent, vacation planner), on pi-durable 1.0.0 | Tag `v1.0.0`, `packages/coding-agent/src/experimental/{durable,vacation}/`. Removed from `main` in `7472cda0` (2026-10-12) together with the experimental client/server packages. Read with `git -C ~/projects/pi-mono show v1.0.0:<path>` |
| Third-party host `disler/durable-pi` (pinned to pi-durable 1.0.3) | `~/Downloads/durable-pi`, mainly `apps/dpi-backend/src/{store,jobs,addons,streams}.ts` and `API.md` |
| Proof of concept: bob on pi-durable 1.2.0 | `~/projects/the-intern-ts-poc` (`docs/findings.md`, `docs/handoff.md`, `src/`, `test/`) |
| Lessons page (sessions, conversations and context; PoC lessons) | <https://claude.ai/artifact/5XHhUR8hrigAUXaDdLB4nf> |
| Feature review with verdicts | <https://claude.ai/artifact/4x9Pbk3pVhQuGrNcppKoU6>, transcribed in [feature-review.md](feature-review.md) |
| The old Rust implementation, specs S-001…S-015, ADR-001…017, CR-001…016 | git history of this repository before the clean-slate commit (`main` at `ae34631`) |

Upstream's own advice holds: point the coding agent at `packages/durable` (README, examples, spec) before writing
hooks or commits.

---

## 1. pi-durable in brief

- **What it is.** An experimental TypeScript library, a "durable agent harness", released with pi 1.0. It runs many
  LLM conversations, their tool calls and the host's own state as checkpointed, crash-recoverable tasks over pluggable
  storage (memory, SQLite, JSONL, Cloudflare Durable Object). About 25k lines in `src/`. MIT. Node ≥ 22.19 (the PoC
  uses Node 24).
- **What it is not.** Not a replacement for the pi coding agent and not wired into the `pi` TUI (pi 1.2.0 doesn't
  depend on it). No CLI, no server, no HTTP API, no clients, no file-based extension loader. Every surface is the
  host's to build.
- **Core guarantee.** Conversations, model turns, tool calls and host state are committed to storage before anything
  is shown. All changes go through one line of atomic commits. Partial model and tool output is committed at most
  every 100 ms (configurable), which bounds what a crash loses.
- **Execution pattern** ("effect sandwich", spec §5.2): commit intent → perform the effect → commit the outcome or the
  next phase. Reopening in an intent phase means the effect may have happened; the handler retries safely, polls an
  external handle, or records an interruption.
- **Dependencies.** `pi-ai` (models, providers), `chord` (reactive documents and the cancellation `Context`),
  `pi-codemode` (QuickJS sandbox), TypeBox.
- **Stability.** "The API changes without notice between releases." 1.0.0 → 1.2.0 took under two weeks and broke
  several contracts (section 8).

### 1.1 Concepts

| Concept | Meaning |
|---|---|
| **Harness** | One open storage plus the scheduler that runs agents on it. One process owns a storage at a time; there is no cross-process locking, so the host must enforce single ownership. |
| **Session** | pi-durable's word for the whole store: one database holding every conversation, entry, task, submission and document. |
| **Conversation** | An ordered transcript of immutable entries. A root conversation (id 1, created by `harness.root()`), plus any number of created, forked or task-owned (subagent) conversations. |
| **Entry** | `pi.user`, `pi.assistant`, `pi.tool-result`, `pi.system` (prompt or tool changes), `pi.reset`, `pi.compaction`, or host-defined kinds. |
| **Commit** | Atomic write of entries, documents and task creation together, or nothing. |
| **Document** | Typed JSON state beside the transcript, changed in commits. Built-ins: `pi.agent` (per-conversation config), `pi.live` (running generation and tools), `pi.inbox` (queued input), `pi.usage` (spend), `pi.provider` (session id for prompt-cache affinity). Session-wide documents also exist. |
| **Task** | A durable state machine that checkpoints every phase. Every task has an owner (a conversation or another task), forming one ownership tree. Built-ins: `pi.generation`, `pi.tool`, compaction. |
| **Submission** | Input or an entry write handed to a conversation; `wait()`-able; idempotent through `requestId`. |
| **Extension** | Named bundle of tools, system-prompt sections, hooks, tool and section wrappers, and task definitions. |
| **Registry** | The extensions this process installed. Can change while running. Conversations store only extension and tool **names**. |
| **Agent** | Per-conversation choices stored in `pi.agent`: model, thinking level, selected extensions, tools, model-visible tools, instructions, cwd. |

One answered input, as tasks and entries:

```text
submit(input) → pi.user
  pi.generation → pi.system (only if prompt/tools changed), pi.assistant (tool calls)
    pi.tool × n → pi.tool-result × n     (owned by the generation, which waits for them)
  pi.generation → pi.assistant (answer) → submission done
```

### 1.2 Capabilities

- **Crash recovery.** `harness.resume()` restarts unfinished tasks from their last checkpoint. Interrupted model
  requests are re-sent; partial answers stay in the transcript marked aborted. Interrupted tool calls rerun only if the
  tool is declared `replay: "safe"`; otherwise the model gets an error result ("Tool bash was interrupted and may have
  partially run") with the output committed so far. Subagents resume; queued input stays queued.
- **Exactly-once admission, not exactly-once effects.** `submit({ requestId })` returns the original submission on a
  retry. External effects still need their own idempotency.
- **Many conversations, forks, subagents.** `fork(entryId)` branches without copying history and copies the agent as
  of that point. A subagent is a task-owned conversation, optionally on a cheaper model with fewer tools; foreground
  and background patterns are in examples 22 and 23. `abort()` cascades down the ownership tree.
- **Busy-conversation inbox.** `whenBusy: "followUp"` (default) queues for after the run, `"steer"` injects after the
  current tool round, `"reject"` throws `ConversationBusy`. `type: "write"` appends app entries without running the
  model. Input can be stored as custom entry kinds while the model sees text.
- **Tools** (`defineTool`, TypeBox schemas): stream output, return `output` (for the model), `structuredOutput` (for
  programs) and `details` (for UIs); commit entries and documents; start tasks and conversations; request
  `control: { terminate | handoff | addTools }`. Since 1.2.0, `api.executeTool` runs nested tool calls as their own
  durable tasks; `callers: ["model" | "tools"]` and per-conversation `modelTools` control who may call what. Deferred
  tools plus a BM25 `tool_search` exist for large tool sets.
- **System-prompt sections**, re-rendered before every request. Only diffs are sent and recorded as `pi.system`
  entries, so restarts and forks see what the model saw, and an unchanged prompt keeps the provider cache warm.
- **Hooks.** Generation: `beforeRequest`, `afterResponse`, `onYield` (keep the run going), `afterTools`. Tools:
  `beforeTool` (block or rewrite arguments), `afterTool` (replace the result). Compaction: `beforeCompact`. Hooks
  persist decisions with `api.memo` (first write wins), so a restart never asks twice. A throwing `beforeTool` blocks
  the call.
- **Overrides.** A same-name tool replaces an earlier one; `wrapTool` decorates.
- **Custom tasks** (`defineTask`): checkpointed phases, durable timers (`runtime.sleep`), child tasks with
  `allSettled` or `failFast` waiting, bottom-up abort with compensation (example 24).
- **Built-in tools.** `@earendil-works/pi-durable/tools`: `read`, `write`, `edit`, `bash` (`CodingTools`) and
  `powershell`; image reading. `/codemode`: the model writes JS calling tools in QuickJS, and scripts survive restarts
  by deterministic replay.
- **Compaction, reset, handoff.** Background compaction starts before the context is full; a request blocks only if it
  wouldn't fit; a provider "context too long" error compacts and retries once. Manual `compact(instructions)`.
  `reset(note?)` starts a fresh context; older entries stay in storage. A tool can trigger it with
  `control: { handoff }`.
- **Durable app state.** `defineDoc` documents with fork semantics (`initial`, `current`, `asOf`) and history
  (`latest`, `rewindable`); `documentState()` and `watchDoc()` for UIs.
- **Hot reload.** `registry.install()` under an existing name replaces an extension in place: running calls finish on
  the old code, the next phase, request or call uses the new code.
- **Observation.** `viewState()` (reactive structural view), `watch()` (view plus exact ops per commit, for remote
  clients; late joiners start from the snapshot; slow watchers collapse after 100 frames), `watchEvents()`
  (experimental coding-agent-style events derived from commits), `harness.taskGraph()`, `harness.usage()` and
  `pi.usage`.
- **Execution environments.** `env` builds an `ExecutionEnv` per tool call from the conversation's cwd.
  `NodeExecutionEnv` is local. `@earendil-works/pi-env` adds `RemoteExecutionEnv` (a small Rust daemon over SSH) so
  the harness and its credentials stay local while tools run elsewhere.
- **Storage.** Memory, SQLite (Node, WAL; works on Node's built-in `node:sqlite`, so no native addon), JSONL
  (append-only, keeps the whole history in memory: not for long-running agents), Cloudflare DO SQLite. Conformance
  suites for custom backends in `/testing`.
- **Retention.** `contextRetentionMs` and `documentRetentionMs` retire idle conversations from memory.

Entry points: `.`, `/tools`, `/env`, `/env/node`, `/codemode`, `/tool-search`, `/images[/node|/cloudflare]`,
`/storage/{memory,jsonl,jsonl/node,sqlite,sqlite/node,sqlite/cloudflare}`, `/testing`.

### 1.3 Interfaces available today

| Surface | Status |
|---|---|
| `pi` coding-agent TUI | Doesn't use pi-durable; its sessions are JSONL trees with `/resume`. |
| pi SDK / RPC mode | Separate stack; shares `pi-ai` only (section 2). |
| pi coding-agent extensions | Not loadable into pi-durable (section 4). |
| `@earendil-works/pi-durable` on npm | **The interface.** Embed in a Node, Bun or Cloudflare process. |
| HTTP, server, CLI, clients | None. Build them (durable-pi did). |

### 1.4 Limits and non-goals

- Single owner per storage; no cross-process locking.
- Replay safety is opt-in. Only read-only tools may be `replay: "safe"`.
- **A storage error closes the Harness** (since 1.2.0). The host watches `harness.closed` and exits or reopens.
- Non-cooperative code blocks `close()`: tools and hooks must honour the abort signal. Forced termination of
  misbehaving extension code is a non-goal, as is multi-writer CRDT merging (spec §13).
- TypeScript only.
- Roadmap signals: Earendil builds small tools on top (Slack bot, GitHub triage bot); lessons flow back into the
  coding agent "when they prove valuable"; no plan to make the `pi` TUI durable. The near-term product is the library
  plus `pi-env`.

---

## 2. The pi coding-agent SDK alongside pi-durable

### 2.1 Compatibility

| Layer | Shared? | Notes |
|---|---|---|
| Models, providers, credentials | **Yes**, both use `pi-ai`, released in lockstep | The coding-agent `ModelRuntime` passes straight into `Harness.open`, so pi's login and models apply unchanged (PoC check 8). |
| Skills, context files, settings | **Yes**, through public exports | `loadSkills`, `formatSkillsForPrompt`, `loadProjectContextFiles`, `SettingsManager`, `DefaultResourceLoader`, `getAgentDir`, `resolveCliModel`. |
| TUI components | **Mostly** | Public: `AssistantMessageComponent`, `UserMessageComponent`, `ToolExecutionComponent`, `CustomEditor`, `DynamicBorder`, `keyText`, `initTheme`, `getMarkdownTheme`, `KeybindingsManager`. `InteractiveMode` drives an `AgentSession` only (it accepts an injectable terminal). |
| Agent loop | **No** | `AgentSession` runs on `pi-agent-core`; pi-durable has its own generation and tool tasks. |
| Transcripts | **No** | JSONL session tree vs SQLite entries; neither continues the other. |
| Extensions | **No** | Different APIs (section 4). |

**Not public** (copy, reimplement or drop; the v1.0.0 demo imported them by relative path):
`configureHttpDispatcher`, `applyHttpProxySettings`, `findInitialModel`, `buildSystemPromptSections`, the
`*ToolSystemPromptContribution` snippets, `createAllToolRenderers`, `formatTokens`, `WorkingStatusIndicator`,
`getEditorTheme`, `InteractiveThemeController`.

### 2.2 What each runtime brings

| Need | Coding-agent SDK (`createAgentSession`) | pi-durable |
|---|---|---|
| Resume mid-run after a kill | No (the file reopens, the run is lost) | **Yes** |
| Exactly-once intake | Build it | **`requestId`** |
| Approval surviving a restart | No | **Stored record or durable task plus `api.memo`** |
| Per-conversation model, tools, instructions, cwd | Per session object | **Stored in `pi.agent`, changed with `configure()`** |
| Concurrent sessions, abort, list | Own map of sessions | **One harness; cascading `abort()`; `taskGraph()`** |
| Steer, follow-up | In memory | **Durable inbox** |
| Subagents, usage | Extension work, events | **Built in** |
| Interactive TUI | **`InteractiveMode`** | Build from components (~650 lines in the demo) |
| pi extensions, MCP, prompt templates, project trust | **Native** | None |
| API stability | Product, no backwards-compatibility promise | Experimental |

SDK sessions load extensions from `<cwd>/.pi/extensions` (subject to pi's project trust), MCP, skills and `AGENTS.md`
like the CLI, and keep JSONL history. The two runtimes can coexist in one process and could be split by job type,
but can't share a transcript. The PoC's conclusion: the daemon runs on pi-durable; the SDK supplies models, login,
settings, skills and context files.

### 2.3 Coexisting with the user's own pi

- Everything user-level lives in one agent dir, `~/.pi/agent`: `settings.json`, `auth.json`, `models.json`,
  `trust.json`, `extensions/`, `skills/`, `prompts/`, `sessions/`.
- bob can use its own agent dir (`agentDir` option or `PI_CODING_AGENT_DIR`) and still share the login with
  `authPath`. Session JSONL goes under `<agentDir>/sessions/` unless `sessionDir` or `PI_CODING_AGENT_SESSION_DIR`
  moves it.
- Per working directory pi reads `AGENTS.md` always, and `.pi/` resources plus `.agents/skills` only if trusted in that
  agent dir's `trust.json` or by `defaultProjectTrust`. `~/.agents/skills` is outside the agent dir and would still be
  shared; a custom `ResourceLoader` can leave it out (untested).
- pi has no tool permissions of its own; bob's policy is a bob extension either way.
- An OAuth refresh (under 5 minutes of validity left) rewrites `~/.pi/agent/auth.json` in pi's format. Sharing the
  login means sharing that file with the user's pi.
- Tests isolate by pointing `PI_CODING_AGENT_DIR` at an empty directory.

### 2.4 Settings don't flow by themselves

- pi's `settings.json` doesn't reach the harness. In the PoC the harness ignored the user's `transport: "sse"` and
  used the codex provider's cached WebSocket, whose un-`unref`'d timer kept a process alive after `close()`.
- Map every setting explicitly into `HarnessSettings`, with a test per mapping. The PoC maps transport, retry, steering
  and follow-up modes; compaction and stream timeouts are still unmapped.
- On shutdown, close cached provider sessions (`closeOpenAICodexWebSocketSessions()`).
- pi's HTTP dispatcher (`configureHttpDispatcher`) is internal. Without it SSE works; it matters for proxies and very
  long silent streams (the demo README warns some streams "end early"). Replicate with `undici`'s `EnvHttpProxyAgent`
  and a long `bodyTimeout` if needed.

---

## 3. Sessions, conversations and what the model sees

### 3.1 Vocabulary

| Concept | pi CLI | pi-durable | Proposed bob meaning |
|---|---|---|---|
| Whole store | a folder of files | **Session**: one database | one bob instance or trust boundary |
| One transcript | **session**: one JSONL file | **conversation** | bob's "session" |
| Agent | the live loop, set up from flags and settings | the `pi.agent` document | an agent profile applied to a conversation |
| Work in flight | the running process | tasks | — |

### 3.2 Facts

- **A session is data, not a process.** An idle conversation is rows on disk; a busy one is tasks in the same
  process. Listing, aborting and inspecting are calls on one Harness.
- **A conversation never sees another conversation's entries.** Shared knowledge between conversations must come from
  files, `AGENTS.md`, skills, agent `instructions`, or prompt sections that read documents.
- **The root conversation** (id 1) exists only if something calls `harness.root()`. It is an ordinary ownerless
  conversation, not a parent of others.
- **The agent is resolved before every generation** from `pi.agent`, the installed registry and the host settings.
  `configure()` changes it from the next turn and survives restarts; forks and subagents copy it. Agent profiles are
  therefore cheap.
- **`root()` applies its `agent` only when it creates the root conversation.** A restart with another model must call
  `configure()`, and only with the changed fields, because each change appends `pi.system` entries.
- **Context derivation:** from the latest compaction head to the tail; tool results after their calls; aborted or
  failed replies dropped.
- **Compaction is on by default.** It summarises the older part and adds a summary entry whose head points to the
  first entry kept. After a compaction the next request writes a full system-prompt baseline. Defaults: keep about 20k
  recent tokens; start in the background about 48k tokens before the window is full; block the run 16k before.
- **Storage only grows.** Each run's model context stays bounded, but a long-lived job conversation carries a summary
  of all its earlier runs forward. Needs a memory and retention policy.
- **Three ways to start a context:** continue (submit to the same conversation), fork (`fork(at)`, inherits entries
  up to `at`, like pi's `/fork`), fresh (`createConversation`, like `/new`).
- **A second database** (a second daemon with its own state dir, which works today) is only for a hard wall: other
  policy, credentials or data.

---

## 4. Extensions

### 4.1 pi agent extensions vs pi-durable extensions

| | pi agent extension | pi-durable extension |
|---|---|---|
| Shape | A factory receiving `ExtensionAPI`, registering with `pi.registerTool`, `pi.registerCommand`, `pi.on(event)` | A plain value from `defineExtension({ name, tools, sections, hooks, wraps, tasks })` |
| Can add | Tools, slash commands, shortcuts, CLI flags, providers, MCP servers, TUI, renderers, ~30 lifecycle events | Tools, prompt sections, hooks on built-in tasks, tool and section wrappers, **durable task definitions**. No UI, commands or providers |
| Loaded by | pi, from `~/.pi/agent/extensions/`, the project's `.pi/extensions/` (gated by project trust), settings paths, `--extension`; via `jiti`, with `@earendil-works/*` imports aliased to pi's copies | **Nobody.** The host imports the module and calls `registry.install(ext)` |
| Lifetime | One session runtime; replaced on `/reload` | Process-wide registry, changeable at runtime; `install` under an existing name replaces in place; `uninstall()` removes |
| Stored | State via `pi.appendEntry` | Names only. After a restart the host must install the same names again, or pending tasks of the missing extension wait, blocked (`harness.inspect()`) |
| Selection | Every session that loads it | Default: **every installed extension, in install order**. `settings.extensions` sets the default list; `configure({ extensions })` selects per conversation |
| Survives a crash | No | Tools and tasks are checkpointed |

To reuse pi extension logic, move it into a shared core with thin adapters on each side (durable-pi's
`jev-damage-control` is a hand port of `jev-bash`). A shim for pi's whole `ExtensionAPI` isn't worth it.

### 4.2 Loading extensions from a folder

Technically about 50 lines: scan for `*.ts` or folders with `index.ts`; import with `jiti` and an alias pointing
`@earendil-works/pi-durable` and `typebox` at the host's copies (or have files export a factory that receives the API);
`registry.install`; re-import with cache-busting on change (each re-import leaves the old module in memory); on start,
re-scan and install **before** `harness.resume()`.

### 4.3 Why discovered extensions must never load

- Importing a module runs its code inside the daemon before any policy check, with full uid power and access to the
  harness, storage and every conversation. `beforeTool` sees tool calls, never module imports.
- The agent can write that folder itself, and so can a prompt-injected email or attachment.
- Default selection is every installed extension, and a same-name tool replaces an earlier one, so a dropped-in file
  defining `bash` would take over `bash` for every agent.

### 4.4 A safe design, if dynamic extensions are wanted

1. Discovery is separate from loading: the agent may only propose (path plus content hash recorded in a document).
2. A human approves and pins the hash. The daemon imports only approved hashes, from a folder the agent can't write
  (policy denies writes there), and re-checks the hash on every load and restart.
3. Opt in per conversation: explicit `settings.extensions`; new extensions are selected nowhere until configured.
4. Policy denies new tool names by default.

For capabilities found while working, prefer **skills plus CLI tools**: a skill is markdown, the CLI runs as a
separate process through `bash` under the policy gate, and a prompt section that scans skill folders picks up a new
skill on the next request (cost: one missed prompt cache). Durable extensions are for what only in-process code can do
(hooks, durable tasks, wrappers) and ship as reviewed code.

---

## 5. Proof of concept results

The PoC (`~/projects/the-intern-ts-poc`, pi-durable 1.2.0, Node 24) asked one question: does pi-durable make bob
simpler and more robust, enough to justify a TypeScript rewrite? **So far, yes.** A daemon with chat, scheduled jobs,
a policy gate with approvals, skills and real models is about 1,665 lines of TypeScript (1,167 lines of tests), with
**zero lines of recovery or supervision code**. For scale, about 8k of the old service's ~39k Rust lines existed only
to drive pi as a black box (supervisor 4.7k, extension IPC 2.2k, persistence 0.9k, plus the 650-line `bob.ts`
courier), and that subsystem produced most process-lifecycle bugs (duplicate extension connections, periodic queue
starvation, run end inferred from `agent_end`, orphaned sessions when bob died).

### 5.1 Setup that worked

- Exact pins, with a lockfile: `@earendil-works/pi-durable`, `pi-ai`, `chord`, `pi-coding-agent` all `1.2.0` (they
  ship in lockstep); `croner` 10.0.1 (cron); `smol-toml` 1.9.1 (TOML); dev: TypeScript 5.9.3, Biome 2.3.8,
  `@types/node` 24.
- Node 24 runs `.ts` directly (type stripping): no build step, `tsc --noEmit` plus Biome for checks, `node:test` for
  tests. Formatting follows pi-mono (tabs, width 3, 120 columns).
- Global npm packages can't be imported from ESM, so the SDK must be a project dependency.
- SQLite through `node:sqlite`.
- Real models verified with `openai-codex/gpt-5.6-terra` over the subscription OAuth login; `~/.pi` stayed
  byte-identical; no credential in the project or state dir.

### 5.2 Acceptance checks

| # | Check | Result |
|---|---|---|
| 1 | Scheduled skill-driven job end to end, with audit records | Job works with a real model (read a bob-skills `SKILL.md`, ran its commands, answered in the prescribed format). Audit module from `watchEvents()` not built |
| 2 | `kill -9` during a long `bash`, restart | **Pass.** The result is the "interrupted and may have partially run" error, the run continues, the submission settles `done`; resubmitting the same `requestId` returns the original submission. No bob code involved |
| 3 | `kill -9` during a replay-safe read tool, only that call reruns | Not done |
| 4 | Denied call blocked; throwing policy blocks | **Pass.** No matching rule → `Tool call blocked: policy denied: …`; a throwing evaluator blocks; an unparsable configured policy file stops `serve` |
| 5 | `ask` waits, survives restart, nobody asked twice | **Pass.** One approval record; after restart the hook reruns, finds it and waits again; the CLI decision lets the call run; aborting the conversation marks a pending approval `cancelled` |
| 6 | Steer a running scheduled session from the CLI | Not done (the durable inbox queues follow-ups already) |
| 7 | 20+ idle conversations, bounded memory | Not done |
| 8 | Credentials from the pi login, no secrets in the project | **Pass** |

### 5.3 What the PoC built and how

- **Daemon** (~220 lines of wiring): one Harness on SQLite; registry = `CodingTools` + `bob-prompt` + `bob-policy`;
  scheduler; control socket. A storage error closes the Harness; `serve` exits 1 and relies on an OS supervisor; the
  restart resumes the work (not tested end to end). Shutdown closes the Harness and cached model connections; nothing
  to drain.
- **Control socket**: NDJSON request/response on a Unix socket in a 0700 directory (88 lines). Commands: `serve`,
  `chat`, `submit`, `transcript`, `abort`, `schedule list|run|reload`, `approvals list|decide`, `status`, `version`.
  Requests without a conversation id go to root; `--conversation <id>` or `--job <id>` select another.
- **Chat**: a 114-line REPL on a daemon conversation. Survives a `kill -9` of the daemon mid-turn and resumes; lines
  typed while busy queue as follow-ups; Ctrl-C aborts. Lacks pi's TUI polish, slash commands and MCP.
- **Scheduler** (~200 lines, croner): reads the existing `schedules.json` format unchanged
  (`{ "version": 1, "entries": [{ id, cron, prompt | file, cwd? }] }`) with the same validation. Each fire submits with
  `requestId = job:<id>:<fireTime>` (deduplicated, tested) and `whenBusy: "reject"`, so a fire that finds the previous
  run busy is skipped. Missed fires are skipped. One conversation per job; the job → conversation map is a Session
  document (`bob.jobs`) written in the same commit that creates the conversation (`createConversation({ init })`), so
  a crash can't leave an unmapped conversation. cwd and model are read from the live entry at fire time and synced
  into the conversation's agent. A missing cwd skips the fire.
- **Policy**: the old allow-only TOML (`[[policy.action_rules]]`, `tool` plus `arg_matchers = [{ field_path,
  pattern }]`) plus an agreed `verdict = "allow" | "ask"` per rule (default `allow`). Among matching rules the most
  cautious wins; no match denies; `tool` is a glob. Without a configured policy file a built-in allow-all
  (`tool = "*"`) applies and is logged; a configured file that is missing or invalid stops startup. Runs as a
  `beforeTool` hook calling a pure `evaluate()`. The guard extension is **selected explicitly** in
  `settings.extensions`, so it can't fall out of a default selection.
- **Approvals**: a record in a Session document (`bob.approvals`) keyed by the asking tool task, not a durable task:
  the task id is stable across restarts and the task's abort signal covers cancellation. Two memos keep reruns stable:
  `bob-policy.verdict` (a policy reload doesn't change a call already waiting) and `bob-policy.decision` (a crash after
  the decision doesn't ask again). A durable task would only pay off for timeouts or escalation. Open: the document
  grows without bound; untested: a crash after the decision memo but before the tool records intent.
- **System prompt** (`bob-prompt`): short bob preamble and rules (a local copy, since pi's builder is internal),
  `AGENTS.md`/`CLAUDE.md`, the skills listing (`loadSkills` + `formatSkillsForPrompt` from a skills path independent
  of cwd), and the cwd, as prompt sections. Byte-stable across turns (tested). `loadSkills` takes several paths, so an
  operator overlay or per-profile skill sets are easy. Context files and skills are loaded once per cwd; a change
  needs a restart (dynamic loading means reloading per run or watching).
- **`loadProjectContextFiles` walks up parent directories**, so a job whose cwd is inside a repository also gets that
  repository's `AGENTS.md`. Place operator working directories with that in mind.
- **Durable state owned by bob**: one approvals document, the job map and two memos. Everything else is pi-durable's.
  All history is read through the daemon, because only it holds the database.

### 5.4 Lessons

1. **Durability belongs to the runtime.** Resume, `requestId` dedup, the follow-up queue and the approval wait are
  library features. No intake table, retry loop or process supervision.
2. **A session is data, not a process.** Don't model sessions as workers.
3. **The agent is a stored configuration.** "Which agent runs this" becomes a per-conversation choice; named
  profiles are cheap.
4. **Chat can live in the daemon from the start.** No terminal passing; what's missing is presentation.
5. **An in-process policy gate is simpler and safer.** A throw blocks, so fail-closed is free. Under single-user,
  same-uid scope the old separate process was never a real boundary, because `bash` runs as the same uid.
6. **Conversations, not databases, separate context.** Named sessions with labels (topic, agent) on one database per
  instance.
7. **Long-lived conversations need a memory policy**, chosen per job: keep memory (one conversation plus compaction)
  or start fresh each fire (new conversation or fork of a set-up one), plus retention for old conversations and
  decided approvals.
8. **pi's settings don't reach the harness by themselves.** One settings module, tests per mapping.
9. **The public SDK surface is almost enough.** Own the system prompt; document the parent-directory `AGENTS.md`
  behaviour.
10. **The API is powerful but young.** Keep pi-durable behind a narrow host module and the extensions, pin exact
    versions, upgrade deliberately, keep restart tests on a deterministic fake model that kills the process.

### 5.5 Remaining risks and open items

| Item | Status / mitigation |
|---|---|
| One process for every session: a runaway session or crashing extension stops all | Not tested. A crash is a resume, not a loss; run under systemd/launchd; fork workers only if needed |
| Memory with many conversations (check 7) | Not measured; retention settings exist |
| API churn | Seen 1.0 → 1.2; narrow host module, exact pins, restart tests |
| Chat experience behind pi's TUI | Build a TUI from exported components when it matters (~650 lines in the demo) |
| Storage failure closes the Harness | Exit and supervisor restart; not tested end to end |
| Not yet built | Audit from `watchEvents()`, check 3, check 6, check 7, compaction and stream-timeout mapping, job memory policy, named sessions and agent profiles |

---

## 6. API footguns (pi-durable 1.2.0)

Read spec §12 before writing commits and hooks. Found in practice:

1. **Values read from a draft must not leave the commit.** Returning `{ ...existing }` from `commit()` leaked a nested
  draft proxy that later threw `Cannot use a settled overlay`. Return a JSON copy made inside the callback; mutate
  drafts in place.
2. **Close and abort look the same to a hook.** Read the tool task record afterwards: `abortRequested` with
  `abortReason !== "restart"` means the operator aborted.
3. **`HookApi` is read-only plus memos.** A hook that writes needs a host-side `Harness` handle attached after
  `Harness.open()`.
4. **pi-ai and pi-durable have different JSON types;** a JSON round trip converts a `ToolCall`'s arguments.
5. **Restart tests need a deterministic fake model** whose reply is a pure function of the transcript (a
  self-re-appending `FauxResponseFactory`); the default faux provider is queue-based.
6. **Guard extensions omitted from an array selection simply don't run.** Select them explicitly.
7. **`configure({ extensions: { add, remove } })` edits the host default,** not the conversation's current list;
  compute a child's array from the resolved agent.
8. **Never await models or the network inside a commit callback.**
9. **Unstable prompt sections defeat provider caching.** Keep section text byte-stable.
10. **Effects are checkpointed, not exactly-once.** Never mark an effectful tool `replay: "safe"`.

---

## 7. Version history that matters

Breaking changes 1.0 → 1.2 (full list in `packages/durable/CHANGELOG.md`):

- 1.1.0: storage scans take `order`; `runtime.context` signature changed.
- 1.2.0: `ToolExecutionResult.content` → `output` (plus `structuredOutput`); tool task inputs are a tagged union
  (`kind: "model" | "nested"`); a nonzero `bash` exit is an error result instead of a throw; any storage error fails
  and closes the whole Session; nested tool calls via `api.executeTool`.

The upstream demo targets 1.0.0 and durable-pi 1.0.3; both need these adjustments when used as templates. The demo is
also a single process with a lock file; bob's daemon is the single owner instead.

---

## 8. Reference hosts

### 8.1 Upstream demo (tag `v1.0.0`)

~1,350 lines: `tui.ts` 655, `runtime.ts` 367, `harness-setup.ts` 123, `prompt.ts` 74, `sessions.ts` 56,
`subagent.ts` 55, `main.ts` 20. `vacation.ts` (142) shows background subagents, replay-safe parallel tools and
report-back tasks, close to bob's scheduled work. It reused pi's TUI components, model auth and `settings.json`.

### 8.2 durable-pi (`disler/durable-pi`)

- `dpi-backend` (Express, ~3.8k lines): one Harness per session over `sessions/<id>/agent.sqlite`; an agent is a
  conversation (main, forks, subagents). Bearer-token REST plus SSE v1 API; streams are `hello → snapshot → deltas`
  built on `watchEvents()`/`viewState()`; `requestId` mandatory on sends.
- Hub plus Vue web client; `dpi-tui` on `pi-tui` (Ctrl+C detaches, the agent keeps running); `curl` one-shots with
  `waitMs`.
- Patterns: `conversationCreated` hook seeding app documents; live settings getters (compaction thresholds changed at
  runtime); shared app-state tools; durable jobs with named phases; an `Approval` task waiting in a durable
  `runtime.sleep` loop; a `beforeTool` guard calling an external classifier with the verdict memoized; a "read only"
  toggle via `configure({ tools })`.
- Proactive demo: a log watcher opens an incident and starts a durable agent with no human prompt; a durable
  `DeployTask` waits for approval across a backend kill ("human near the loop").
- Their stated limits: effects aren't exactly-once; a device token is effectively a shell; LAN uses plain HTTP; the
  hub holds every token; their external guard fails open.

---

## 9. Lessons carried from the old implementation

These are about the problem, not the old runtime, and stay valid:

- Policy is deterministic and invisible to the agent; fail closed on the membrane, fail open on content (a missing
  skill degrades with a diagnostic, a broken guard blocks).
- Single user, single machine, one OS account; filesystem permissions (0700 directories, owner-only files) are the
  security boundary; everything the agent reads from the operator (schedules, prompt files, cwd and its `AGENTS.md`,
  skills) is trusted input that must stay owner-only.
- Every channel ends in the same call; channel knowledge stays in adapters.
- One source of truth per fact: runtime state in the database, operator-edited inputs as files, never copied between
  the two.
- Release-owned content (shipped skills, manual) ships inside the package and is loaded by path, so it can't drift
  from the running version; operator customisation goes in an overlay.
- Simplicity before machinery.
- Earlier reversals worth remembering: the core was once taught channel names by an over-specified task breakdown; a
  uid allow-list sat behind a 0700 directory and could never reject anyone; schedules accepted at add time were denied
  at fire time; workers resolved context against `/` under systemd; skills depended on where a session happened to
  run; the worklog duplicated items daily because the same fact was written twice.
