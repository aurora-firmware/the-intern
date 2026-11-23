# Feature review for the rework

*Transcribed 2026-10-15 from the review page <https://claude.ai/artifact/4x9Pbk3pVhQuGrNcppKoU6> (verdicts and notes
as of 2026-10-15). Every feature of the old bob, with its verdict for the new version and the direction agreed in the
notes. The runtime facts behind the notes are in [pi-durable-knowledge.md](pi-durable-knowledge.md). Spec, ADR and CR
ids refer to the old documents, available in git history before the clean-slate commit.*

**Verdicts.** Keep · Rework · Drop. For the "Deliberately not built" section the meaning flips: **Keep** = stays out
of scope, **Drop** = the exclusion is lifted (in scope), **Rework** = partly in scope.

## Direction of the rework

- **No Rust.** bob becomes a single TypeScript/Node package; daemon and CLI share one entry point.
- **pi runs as a library inside bob on pi-durable**, not as supervised child processes. Conversations, runs, tool
  calls and approvals live in a database and resume after a crash.
- **Pattern:** everything that existed because pi was an external process goes (supervisor, extension socket and
  courier, extension by path, delivery kinds, pre-flight). Policy, schedules, skills, the XDG layout and the
  filesystem trust model stay. What changes most is what a session and an agent are: a session is a conversation in
  one database; an agent is a stored per-conversation configuration.

## Open decisions

| # | Decision | Suggested direction |
|---|---|---|
| 1 | **Agent architecture.** Today every interaction is an ephemeral agent with no history. How many agent profiles, and what each does? Does a main agent act as an overlord handing tasks to other agents (subagents or separate conversations), or do channels and schedules address agents directly? Which conversations are long-lived, which start fresh? | To be defined; the main design question of the rework |
| 2 | What replaces the task board for open items | Redefine tasks and email triage as **extensions loaded per agent profile**. Drop the worklog: everything is already recorded in the database |
| 3 | Control endpoint protocol (no JSON-RPC): plain NDJSON vs HTTP over the Unix socket | **HTTP**, with a future GUI in mind |
| 4 | Job memory: a conversation per job, or fresh each fire | **Redesign scheduled jobs as a whole**, together with the agent architecture |
| 5 | Packaging: npm tarball vs a bundle with Node | Open. A self-contained binary is the wish; research the npm and Node options first |
| 6 | Customisation (skill overlay) | Agents work in **known working directories** where the operator adds instructions (`AGENTS.md`), `.pi` extensions and skills, loaded dynamically. Caveat: pi coding-agent extensions use a different API from pi-durable extensions, so loading `.pi` extensions needs an adapter or a bob extension format |

## Principles

| Principle | Verdict | Direction |
|---|---|---|
| Deterministic policy lives outside the agent | Rework | Keep the intent: deterministic, and the agent can't see or change the ruleset. It now runs in the agent's process as a `beforeTool` hook calling a pure policy module; a throw blocks the call. Under single-user scope the separate process was never a real boundary (`bash` runs as the same uid) |
| One user, one machine, one OS account | Rework | Keep one machine, one account. Inputs come from several sources (chat, schedules, later email), not told apart by user. No pi process per session: sessions are conversations in one daemon, isolated in what the model sees but not in crashes (a crash becomes a resume). Hard wall = a second daemon with its own state dir |
| Filesystem permissions are the security boundary | Keep | Control socket in a 0700 dir; state dir 0700; the SQLite database is one more owner-only trusted file |
| Thin core, channel knowledge only in adapters | Rework | Holds, and comes free: every channel ends in `conversation.submit({ requestId, whenBusy })`. An adapter only picks the conversation and request id. Drop delivery-kind types and adapter-framework machinery |
| Membrane fails closed, content fails open | Rework | Fails closed: guard selected explicitly, a throw blocks, an invalid policy file stops startup. Fails open: missing or broken skills render no prompt section and log a diagnostic |
| Recording work never needs the service | Drop | No `bob task`, `worklog` or `init`. All conversation state is in the daemon's database, so reading history goes through the daemon |
| One source of truth per fact | Rework | Runtime state (conversations, approvals, job → conversation map, session names) in the database as documents; operator-edited inputs (config, policy, `schedules.json`, skills) stay files; never copy a fact between them. Whatever replaces task and worklog owns its own format |
| Release-owned content travels inside the binary | Keep | Skills ship inside the package and load by path: no copy step, no drift. Add an operator overlay directory |
| Simplicity before machinery | Keep | — |
| Unix-likes only | Keep | No reason to widen scope |

## Service core and runtime

| Feature | Verdict | Direction |
|---|---|---|
| `bob serve` daemon | Rework | One Node process holding a pi-durable Harness on SQLite, plus scheduler and control socket. No actors, no channels. Needs an OS supervisor (systemd/launchd): a storage error closes the Harness, serve exits 1, the restart resumes |
| Runtime-agnostic core crate | Drop | Keep the idea as module boundaries: pure modules (policy, schedule parsing, transcript mapping) tested without a harness; pi-durable behind the host module and the extensions |
| One binary, many subcommands | Keep | One entry point. Add sessions and agent profiles; task, worklog and init go |
| Requests typed by delivery kind | Drop | Replaced by submit options: `requestId` dedups, `whenBusy` decides overlap (queue, reject, steer); callers read the answer from the submission |
| Channel adapter framework | Rework | One thin way in. The durable inbox is the queue; an adapter maps its source to a conversation and request id and calls submit |
| Job-id correlator | Rework | `requestId = job:<id>:<fireTime>`; job → conversation map written in the same commit that creates it; cwd and model read from the live entry and synced into the agent at fire time |
| pi supervisor and worker pool | Drop | No process management. A concurrency cap, if wanted, is a small counter; a busy job already skips its next fire |
| pi process settings | Rework | Command, args, pool and cwd keys go. Model from pi's login and settings by default, stored per conversation (per-agent models possible). Map pi's settings into the harness explicitly, with tests |
| Graceful shutdown | Rework | Close the Harness and model connections (cached WebSockets otherwise hang the process). Nothing to drain. Audit flush remains |

## Control plane, trust and layout

| Feature | Verdict | Direction |
|---|---|---|
| `admin.sock` JSON-RPC control plane | Rework | A local endpoint stays (only the daemon holds the database). No JSON-RPC; NDJSON or HTTP over the Unix socket (open decision 3). Methods: sessions, agents, transcript, approvals, schedule, abort |
| Separate `extension.sock` | Drop | Policy hook and event stream are in-process |
| Socket trust gate | Keep | 0700 directory gate. Drop the `SO_PEERCRED` breadcrumb (not in plain Node) |
| Self-asserted application identity | Rework | No user differentiation. Keep source attribution (chat, `schedule:<id>`, cli) carried by conversation and request id; approvals record who decided. Drop identity as a policy input and intake requirement |
| XDG filesystem layout | Keep | Add the SQLite database under state; split database (state) and socket (runtime) |
| TOML config with layered loading | Rework | TOML and layering stay (figment is Rust-only). Keep mutable state out of config: agent profiles and session names belong in the database or a store file |

## Policy and authorization

| Feature | Verdict | Direction |
|---|---|---|
| Blocking tool-call authorization | Rework | Same rules plus `verdict = allow | ask` per rule; ask beats allow; no match denies; `tool` is a glob. Pure `evaluate()` in a `beforeTool` hook. Timeout and transport-loss modes gone. An `ask` waits on a stored approval that survives restarts |
| Pre-flight admission | Drop | Gates nothing; every intake path is owner-only |
| `bob policy reload` | Keep | Swap the snapshot; memoized verdicts keep waiting calls stable |
| Permissive first-run policy | Rework | Built-in allow-all when no policy file is configured, logged at startup; a configured file that is missing or invalid stops startup. No init step |
| Trusted, un-checked inputs | Keep | Same list; also document that pi's context loader reads `AGENTS.md`/`CLAUDE.md` from parent directories of a job's cwd |

## The old pi extension (`bob.ts`)

| Feature | Verdict | Direction |
|---|---|---|
| Event forwarding and authz hook | Rework | Becomes bob's own pi-durable extensions in the registry: `bob-policy` (`beforeTool`) and `bob-prompt` (system prompt, skills). Audit events from `watchEvents()` in-process |
| Extension supplied by path | Drop | Extensions are code in the package, selected explicitly in harness settings so the guard can't fall out of a default selection |
| Extension failure behaviour | Drop | No transport. A throwing hook blocks; a storage error exits and the supervisor restarts |

## Monitoring and operations

| Feature | Verdict | Direction |
|---|---|---|
| Append-only JSONL audit log | Keep | Same format; source is `watchEvents()`. The database already keeps full transcripts, so the audit can focus on verdicts, approvals, fires and aborts |
| `bob audit tail` | Keep | Transcript commands and live chat cover much of its old use |
| `report.submit` for external tools | Drop | If needed, a bob tool that writes an audit record |
| `bob status` and `bob sessions` | Rework | Sessions are conversations: list (named, labelled by topic and agent), transcript, abort (cascades to subagents). Kill becomes abort |

## Channels: chat and scheduler

| Feature | Verdict | Direction |
|---|---|---|
| `bob chat` | Rework | Thin client on a daemon conversation: survives a daemon kill mid-turn, queues lines typed while busy, Ctrl-C aborts. No terminal passing. Upgrade path: a TUI from pi's exported components |
| Internal cron scheduler | Keep | croner; dedup by request id; missed fires skipped; a fire finding the job busy is skipped |
| `bob schedule` commands | Rework | list, run (new: fire now), reload exist in the PoC; add and remove to build; same validation. Possible: per-entry agent profile and memory choice |
| `schedules.json` store | Keep | Same format, hand-editable |
| Working directory per job | Rework | cwd is a per-conversation agent setting synced at each fire; no dedicated worker; a missing directory skips the fire; mind parent-directory `AGENTS.md` loading |
| Email by polling | Keep | Still a scheduled job. Decide whether triage keeps memory across fires or starts fresh, and whether it runs on a cheaper-model profile |

## Skills

| Feature | Verdict | Direction |
|---|---|---|
| Skills supplied by path, independent of cwd | Keep | `loadSkills` + `formatSkillsForPrompt` from a path. New: different skill sets per agent profile |
| Skills package (bob-skills) | Rework | Canonical source shipped inside the package. himalaya, email-triage and the docs skill stay; tasks and worklog skills follow the drop of those commands |
| himalaya skill | Keep | Runs through `bash` as before |
| email-triage skill | Rework | Logic stays. Needs the task-board replacement for open items; categories must be customisable; may run on a cheaper-model agent with fresh context per fire; escalation could become an `ask` approval instead of an email |
| the-intern-docs skill | Keep | Content follows the new manual |
| Rules for skill content | Rework | Keep "no internal specs, ADRs or bugs in skill content". Replace "local edits unsupported" with a supported overlay |

## Work records

| Feature | Verdict | Direction |
|---|---|---|
| `bob task` board | Rework | The command goes, the need stays (triage parks open items). Options: (a) a pi-durable document exposed through bob tools (survives restarts, visible to a GUI, no file format to police), (b) markdown files following a skill. (a) fits better; see open decision 2 |
| `bob worklog` | Drop | Transcripts and usage per conversation already record what bob did; a daily summary can be generated |
| Worklog is a done-log only | Rework | Keep the rule (done and outstanding recorded once each, separately) for whatever replaces the board. The transcript is the done-log |
| tasks and worklog skills | Rework | Follow the board decision; with (a) the tools describe themselves and a short skill covers the discipline |

## Setup, distribution and docs

| Feature | Verdict | Direction |
|---|---|---|
| `bob init <path>` | Drop | Allow-all default is built in; serve creates its state dir (0700); no workspace to scaffold |
| `bob init --skills-only` | Drop | Skills load from inside the package |
| Install bundle per platform | Rework | Needs Node 24; pi pinned as npm dependencies. npm tarball vs bundle with Node (open decision 5). `node:sqlite` means no native addon per platform |
| `install.sh` owns the skill folder | Drop | No drift when skills load from the package; an operator overlay replaces the configurable path |
| mdBook user manual | Keep | Rewrite architecture and operator parts: sessions are conversations, agents are profiles |
| bob-companion plugin | Rework | Generic skills format, not Claude-specific; content follows the CLI |

## Deliberately not built (verdict meaning flips)

| Exclusion | Verdict | Direction |
|---|---|---|
| MCP support and typed tool wrappers | Keep (out) | MCP lives in pi's coding agent, not in pi-durable. A typed tool, if needed, is a pi-durable tool |
| Multiple users, remote callers, network ingress | Keep (out) | One process for all sessions is acceptable only because of single-user scope |
| GUI and HTTP API | Rework (partly in) | A GUI is another client; it needs live updates (stream `watch()`/`watchEvents()`); HTTP on the Unix socket suits it |
| Routed-back answers for sync requests | Rework (partly in) | No dedicated path needed: a submission settles with its answer; an adapter waits and replies. Add when a channel needs it (e.g. replying to an email) |
| Detachable or shared chat sessions | Drop (in) | Already true: chat lives in the daemon; two terminals can share a conversation |
| Replay of missed ticks, job chaining | Keep (out) | Chaining could later use pi-durable tasks |
| Audit queries, retention, redaction | Rework (partly in) | History is queryable from the database. Audit JSONL retention and redaction stay out. Retention of old conversations needs a decision |
| Per-user or role rules, deny rules | Rework (partly in) | `ask` added. Deny and per-user rules stay out. Per-agent-profile rules may become useful (e.g. a read-only triage agent) |
| Operator customisation of shipped skills | Drop (in) | Shipped skills must allow customisation, in particular new email-triage categories; an overlay loaded after the shipped skills (`loadSkills` takes several paths) |
| Windows, Linux arm64, Intel macOS | Keep (out) | — |
