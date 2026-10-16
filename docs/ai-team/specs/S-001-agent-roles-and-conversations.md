---
title: Agent roles and conversations
version: '0.1'
status: approved  # draft | review | approved | superseded
created: '2026-10-15'
author: planner
id: S-001
---

# Agent roles and conversations

## Purpose

The new the-intern is a single daemon that runs every conversation in one pi-durable database. Before any channel,
schedule or client can be built, we need to define what a conversation is and what the agent working in it is.
The old the-intern had a single kind of ephemeral agent with no history, and the hierarchical alternatives were
rejected: an overlord `bob` delegating to agents it owns, `bob` as a default that channels bypass, and a single
long-lived coordinator. The-intern's work comes from scheduled prompts that have to be turned into the right actions.
That needs **roles** that agents are made from: each role brings its own instructions, tools and default model,
thinking level and workspace. A conversation can pass to an agent of another role whenever the state of the job
calls for it, and agents can invoke other agents to work in parallel.

When this spec is done:

- the-intern ships two predefined roles, `bob` and `gp`.
- Every conversation has one agent at a time, and each agent has one role.
- The user or an agent can pass a conversation to an agent of another role at any time.
- Any agent can invoke other agents of any role, and either keep working and steer them, or park until they report.
- A waiting conversation doesn't hold a worker thread.
- Interactive chat, scheduled prompts and manually created conversations are the ways into conversations.
- The user can see which role is working where.

## Definitions

### Project terms

| Term | Meaning in this spec |
|---|---|
| the-intern | The product. It runs as a daemon. |
| bob | The name of a role (R-1) and of the CLI (`bob chat`). |
| User | The single person who works with the-intern: talks to its conversations, configures it and monitors it. |
| Role | A set of parameters that an agent is made from: instructions (system prompt), tools and skills, plus default values for the pi-durable agent parameters: model, thinking level and workspace (the pi-durable `cwd`). If a role is a class, an agent is an object of that class. |
| Agent | The actor that interacts with the model and carries out a conversation. A conversation has one agent at a time and can be a succession of agents: each role change ends the current agent and seats a new one in the same conversation. An agent keeps its role for its whole life. It is not an operating-system process: the daemon runs every agent, and the current agent's configuration is the pi-durable agent of its conversation. |
| Seat | The place of the current agent in a conversation, with the role, model, thinking level and workspace it runs with: the role's defaults, or overrides given when the agent was seated or invoked. |
| Handoff | The current agent passes its conversation to a new agent of another role. Same conversation, same worker thread. |
| Agent invocation | An agent starts one or more agents, each in a new conversation, with a role and a job prompt. Neither agent owns the other, and the invoked agent can finish the job itself. |
| Context mode | How a new agent's context starts, for a handoff or an invocation: **Full** (the existing context), **Compact** (a compaction of the existing context, guided by a note) or **Clean** (only the note or the job prompt). |
| Steerable, parked | The two ways an invoking agent can carry on. Steerable: it keeps running and can steer the agents it invoked. Parked: its conversation's state is kept, its worker thread is freed, and it continues when a report arrives. |
| Job | The work an agent run is expected to complete. A job can pass between agents. |
| Clean-up step | What runs when an agent decides its job is done: report a summary back to the invoking conversation, do nothing, and/or release the worker thread. Chosen programmatically by the type of job or conversation. |
| Agent run | The model turns an agent takes from picking up an input until its conversation is idle or parked. One agent run uses one worker thread. |
| Model turn | One model request and the tool calls it makes. A seat change applies from the next model turn, so it can take effect during an agent run. |
| Worker thread | A logical unit of capacity: one active agent run uses one. Their number is the concurrency cap (R-10). Whether they are operating-system threads is the daemon spec's choice. |
| Thread | Only in the multi-threading sense. |
| Reset | Clears what the model sees of a conversation. The conversation, its id and its stored entries stay. |
| Transcript, context | The transcript is every stored entry of a conversation. The context is the part the model receives on the next request, after resets and compactions. |
| Workspace | A registered local folder that an agent works in. It supplies extra instructions and skills, and is where tools start. Agents work on the OS and filesystem with the user's account; the workspace doesn't limit what they reach. |
| Entry point, origin | An entry point starts a conversation: chat (root only), a schedule fire, a user request. The origin records which one, or the invoking conversation for an agent invocation. |

### pi agent and pi-durable terms

the-intern runs every conversation on pi-durable. It uses the pi agent (the `pi` coding agent and its SDK) only for
models, login, settings, skills and context files. Where a term exists in both, this spec writes "pi-durable X" or
"pi agent X". A term without a prefix has the project meaning above.

| Term | pi agent | pi-durable | In this spec |
|---|---|---|---|
| Session | One transcript: a JSONL file in pi agent's sessions folder | The whole store: one database with every conversation, task and document | Not used. A transcript is a conversation; the store is "the database". |
| Conversation | No separate term; the pi agent session plays this part | An ordered transcript of entries with its own pi-durable agent | The pi-durable meaning. |
| Agent | The agent loop running in the `pi` process, set up from flags and settings | What a conversation runs with: model, thinking level, extensions, tools, instructions, cwd. Stored in the conversation's `pi.agent` document and resolved before every model request. The harness runs it; no process belongs to it. | The current agent's seat is written into the pi-durable agent of its conversation. |
| Subagent | None built in; extensions provide it | A conversation owned by a task of its caller, aborted with it | Not used. Agent invocation replaces it. Whether invocation is built on pi-durable task-owned conversations is an implementation choice. |
| Root conversation | None | Conversation 1, created by the host's first `root()` call. Not a parent of other conversations. | The same conversation, whose first agent has the `bob` role and which `bob chat` shows (R-12). |
| Turn, run | A turn is one assistant message and its tool calls; a prompt runs until the agent ends | A turn is one model response and its tool calls; a run is the turns from an input to its final answer | Model turn and agent run, as defined above. |
| Task | Not a pi agent concept | A durable state machine: generation, tool call, compaction | Only the pi-durable meaning. The work an agent does is a job. |
| Extension | A module pi agent loads from its agent folder, a trusted project's `.pi/extensions` or a flag | Tools, prompt sections and hooks that the host installs in its registry | Only the-intern's own pi-durable extensions. pi agent extensions are not loaded, neither the user's nor a workspace's, so an agent is offered exactly its role's tools (R-5). |
| Skills | Loaded from pi agent's agent folder, `~/.agents/skills` and trusted project folders. The prompt lists name and description, and the model reads the file when needed. | No skill loading of its own | The role's shipped skills plus the workspace skills, listed the same way as in pi agent. The user's own pi agent skills are not loaded. |
| Context files | `AGENTS.md`/`CLAUDE.md` from pi agent's agent folder, the cwd and its parent directories | None; the host supplies prompt sections | Those of the workspace and its parent directories. |
| cwd | The working directory of the `pi` process | The `cwd` of the pi-durable agent | The seat's workspace. |
| New, fork, reset | `/new` starts a new pi agent session file; `/fork` copies one | A reset entry clears the model's context inside the same conversation; creating a conversation starts an empty one; a fork copies entries up to a point | A Clean handoff and a reset stay in the same conversation. Only entry points and agent invocations create conversations. A Full-context invocation may be built on a pi-durable fork. |
| Compaction | Summarises older messages near the context limit, or on `/compact` | The same, as a pi-durable task, on by default | Automatic compaction is unchanged by this spec. The Compact context mode is an extra compaction guided by the agent's note. |
| Steer, follow-up | Messages queued during a run: a steer arrives after the current tool calls, a follow-up after the run ends. Held in memory. | The same, through a durable inbox | The same meanings (R-10a), and durable. |
| Default model, thinking level | Chosen by pi agent's settings | None; the host passes them | "pi agent's default" (R-3) is what the user's pi agent settings select. |

## Exclusions

What this specification explicitly does NOT cover:

- **Hierarchical agent architectures.** Rejected alternatives: an overlord `bob` that owns `gp` agents, `bob` as a
  default that channels address around, and a single long-lived coordinator conversation. Agents of different roles
  take turns in a conversation, and agents that invoke each other are peers. No agent owns another or owns a
  conversation.
- **Memory across scheduled runs.** Every fire starts a new conversation. Continuing one conversation per schedule
  entry, as the proof of concept did, is rejected.
- **A new conversation per handoff.** A handoff never creates a conversation. A clean start inside the same
  conversation is the Clean context mode. Only agent invocations create conversations.
- **What happens when a job ends, and job tracking.** Completion criteria, the job and conversation types, which
  clean-up steps each type runs, what a finished job leaves behind, a job object that tracks ongoing work, and the
  worklog are left to a later job spec. That spec may define an internal database of ongoing jobs. This spec
  requires only the report-back clean-up step (R-8a).
- **When a parked agent continues.** Whether a parked agent continues on each report as it arrives, or stays parked
  until every agent it invoked has reported, is decided later. Both must be possible (R-8a).
- **Policy rules of any kind.** v1 runs an allow-all policy. Rules per role and the allow/ask policy are left to the
  policy spec.
- **Email triage.** Covered by a later spec.
- **User edits to role instructions or tools.** In v1 the user sets only each role's default model, thinking level
  and workspace. Editing instructions is planned for a later version.
- **Creating, removing or renaming roles.** v1 has exactly `bob` and `gp`.
- **Adding skills other than through a workspace.** Shipped role skills are fixed. The user's own skills come only
  from a workspace. Other overlay mechanisms are out.
- **Other `bob chat` options.** In v1, chat is a window onto the root conversation. Attaching chat to another
  conversation and choosing the role when chat starts are out. Changing the role inside the chat is in (R-4).
  Creating and resetting conversations is in, outside chat (R-11).
- **Model, thinking level or workspace per schedule entry.** Whether a schedule entry can name values other than its
  role's defaults is an open question, deferred. In v1 a fire runs with the named role's defaults.
- **Process and concurrency model.** Whether worker threads are operating-system threads, share one event loop or
  are spread over several processes belongs to the daemon and host-runtime spec. This spec uses worker threads only
  as a logical unit of capacity and states the observable caps (R-9, R-10).
- **Technology choices.** The control protocol, client transport, storage layout, config file format and process
  model belong to the daemon, control-endpoint and packaging specs. This spec states behaviour only.

## Architecture

### Design Principles

- **One agent at a time per conversation.** A conversation can be a succession of agents, but at any moment it has
  exactly one, with one seat. Every model turn runs with that seat's model, thinking level, instructions, tools,
  skills and workspace. Nothing in a turn mixes two seats.
- **Roles are starting points.** A role supplies instructions, tools and shipped skills, which are fixed, plus a
  default model, thinking level and workspace. Each seat may run a different model, thinking level or registered
  workspace than the role's defaults, and changing a role's defaults affects only agents seated after the change.
- **Agents are peers, not owners.** An agent of any role can hand its conversation to any role and invoke agents of
  any role. No role is privileged except that `bob` is the default role, and no agent owns the agents it invokes.
- **A role is configuration, not a process.** Seating an agent changes stored per-conversation configuration only.
  No process or connection is tied to a role or to an agent.
- **The seat carries the workspace.** The workspace is part of the seat, so a new agent can work in another
  workspace. A conversation has no workspace apart from its current seat.
- **Workspaces are verified once, when registered.** Only registered workspaces can be used. Registration checks
  them, and use doesn't re-validate beyond noticing that a folder has disappeared.
- **Waiting costs no worker thread.** A parked or idle conversation holds no worker thread. pi-durable keeps its
  state, and it takes a free worker thread again when it has input.
- **Every agent change is visible and durable.** Each seat change, reset, handoff, invocation, park and report is
  recorded in the transcript or the conversation's metadata, survives a daemon restart, and appears in monitoring
  without a model having to describe it.
- **Unattended by default.** Outside interactive chat, no step waits for a human. Handoffs and agent invocations
  proceed on agent decisions alone.
- **Bounded delegation.** Invocation depth and the number of worker threads are capped, so no chain of unattended
  agents can grow without limit.

### System Diagram

```
 entry points                       conversations (one database)                 roles (catalog)
┌──────────────────┐   submit    ┌────────────────────────────────────┐  seat   ┌──────────────────┐
│ bob chat ────────┼────────────►│ root conversation    [role: bob]   │◄────────┤ bob  (default)   │
│ (root only)      │             │                                    │         │  instr., tools,  │
├──────────────────┤             │ conversation #k      [role: gp]    │         │  skills; default │
│ scheduled prompt │──new conv──►│   ├─ invokes #m      [role: bob]   │         │  model, thinking,│
│ (entry names a   │             │   │    └─ invokes …  [role: any]   │         │  workspace*      │
│  role)           │             │   ├─ steerable or parked           │         ├──────────────────┤
├──────────────────┤             │   └─ handoff / reset: same conv,   │         │ gp               │
│ user: new / reset│──new conv──►│      next agent, context mode      │         │  instr., tools,  │
│ conversation     │             │                                    │         │  skills; default │
│                  │             │ reports return as new input        │         │  model, thinking,│
│                  │             │                                    │         │  workspace*      │
└──────────────────┘             └──────┬───────────────▲─────────────┘         └──────────────────┘
                                        │ role-attributed│ seat change, reset,   * user-set; a seat
                                        ▼ transcript     │ steer, invocation       may override them
                                 ┌──────────────┐  ┌─────┴───────────────┐      (registered workspaces)
                                 │ monitoring   │  │ agent coordination  │
                                 │ (list, invo- │  │ (handoff, invoke,   │
                                 │ cations, live│  │  steer, report)     │
                                 └──────────────┘  │ + caps, worker thr. │
                                                   └─────────────────────┘
```

### Responsibility Separation

| Component | Responsibility | Notes |
|---|---|---|
| Role catalog | Defines the predefined roles and their defaults, and holds the registered workspaces | Read-only in v1, apart from defaults and workspace registration |
| Seating | Seats an agent of a role in a conversation, with optional model, thinking level and workspace overrides, and records who seated it | The only path that changes a conversation's seat |
| Role prompt | Builds what the model sees: the-intern's preamble, role instructions, role skills, workspace instructions and workspace skills | Must stay byte-stable while the seat is unchanged |
| Agent coordination | Agent-callable handoff, agent invocation and steer capabilities; parking; the report-back clean-up step; the depth cap and the worker threads | Every role is offered the same coordination capabilities |
| Entry routing | Connects chat to the root conversation, turns scheduled prompts into new conversations, and handles new and reset requests from the user | Holds no channel knowledge beyond choosing the conversation and the role |
| Monitoring | Lists conversations, seats, origins, status, invocation links and live transcripts | Read-only. Abort, reset and steer go through other components |

## Components

### Component 1: Role catalog

**Purpose:** Hold the two predefined roles (`bob`, `gp`) with their default model, thinking level and workspace, and
the user's registered workspaces, each checked when it is registered.
**Estimated size:** Small.
**Interfaces:** Exposes role lookup and listing, and workspace lookup and listing. Consumes user settings and
pi agent's default model and thinking level.

### Component 2: Seating

**Purpose:** Seat an agent of a role in a conversation, with optional model, thinking level and workspace
overrides, so that later turns use that seat, and record the change.
**Estimated size:** Small to medium.
**Interfaces:** Exposes "seat an agent of role R in conversation C, by actor A, optionally with model M, thinking
level T and workspace W". Consumes the role catalog and the pi-durable agent of each conversation.

### Component 3: Role prompt

**Purpose:** Render the system prompt for the current seat: the-intern's preamble, the role's instructions, the
role's shipped skills, plus the workspace's `AGENTS.md`/`CLAUDE.md` and the workspace's skills.
**Estimated size:** Medium.
**Interfaces:** Exposes prompt sections to the harness. Consumes the role catalog and the files in the workspace.

### Component 4: Agent coordination

**Purpose:** Give every role three agent-callable capabilities (hand off the current conversation, invoke other
agents, steer another conversation). Park and continue invoking conversations, run the report-back clean-up step,
and enforce the depth cap and the number of worker threads.
**Estimated size:** Medium to large. The worker threads depend on the process model the daemon spec chooses.
**Interfaces:** Exposes agent tools. Consumes seating, conversation reset, compaction and fork, conversation
creation, and the inbox of the target conversation.

### Component 5: Entry routing

**Purpose:** Make sure the root conversation exists and its first agent has the `bob` role. Attach chat to it.
Turn each scheduled fire into a new conversation. Serve the user's requests to create and reset conversations.
**Estimated size:** Small.
**Interfaces:** Exposes "submit to root", "start a conversation with role R, origin O" and "reset conversation C".
Consumes seating and the role catalog.

### Component 6: Monitoring

**Purpose:** Let the user see every conversation: its current seat (role, model, thinking level, workspace), origin,
status, the conversation that invoked it and the ones it invoked, and its transcript, live while it runs.
**Estimated size:** Medium.
**Interfaces:** Exposes list, invocations, transcript and live-follow views to the CLI (and later a GUI). Consumes
the conversation store and its observation streams.

## Behavioural Requirements

Each requirement is checked as described in **Verification** below.

### Roles and workspaces

- **R-1 Predefined roles.** the-intern ships exactly two roles, `bob` and `gp`. Each has a name, instructions, a tool
  set, a shipped skill set (possibly empty), a default model, a default thinking level and a default workspace.
  `bob` is the default role.
- **R-2 Role differences in v1.** `bob` and `gp` differ only in their instructions, tool set and shipped skills.
  - **`bob`** is the conversational main entry point. Its instructions direct the agent to understand what the user
    or the prompt asks, identify the job to be done, and either do it, hand it to a better-suited role or invoke
    other agents for it.
  - **`gp`** is a general-purpose job executor. Its instructions and shipped skills describe how to carry out a job
    to completion.
  - Both roles are offered the coordination capabilities (R-6 to R-8a). The exact text of the instructions, the tool
    lists and `gp`'s skill content are set during implementation and may change in later versions without amending
    this spec. They must satisfy the descriptions above.
- **R-3 User settings.** The user can set each role's default model, thinking level and workspace, and register
  workspaces. Nothing else about a role can be set.
  - A role without a configured default model uses pi agent's default model, and one without a configured default
    thinking level uses pi agent's default thinking level.
  - A role without a configured default workspace uses a default workspace that the-intern creates and registers for
    that role, owner-only, under the-intern's own data location.
  - Changing a role's defaults affects only agents seated after the change. Agents already seated keep their model,
    thinking level and workspace.
- **R-3a Workspace registration.** A workspace is a local folder: the files an agent works on, extra instructions
  (`AGENTS.md`), workspace skills and scratch space. A folder can be used as a workspace only after the user
  registers it.
  - Registration checks that the path is absolute, exists, is a directory and is owner-only.
  - A registration that fails the check is refused with an error naming the path and the reason. If the failure
    comes from configuration loaded at startup, the daemon doesn't start.
  - A role's default workspace must be a registered workspace.

### Seating, overrides and handoff

- **R-4 Role change by the user.** The user can change the seat of any conversation at any time, including the root
  conversation from inside `bob chat`.
  - The new seat names a role, and may name a model, a thinking level and a registered workspace other than that
    role's defaults. A new agent of that role is seated, with the Full context mode.
  - The change applies from the next model turn. A model turn already running finishes with the seat it started
    with, unless the user also aborts or steers it.
- **R-5 Seat effects.** After a seat is applied, every model turn in that conversation:
  - uses the seat's model and thinking level
  - sees the role's instructions and shipped skills
  - is offered exactly the role's tools
  - runs its tools in the seat's workspace
  - sees that workspace's instructions and skills

  Nothing of the previous seat's instructions, skills or workspace stays in the system prompt. The transcript
  stays visible to the new agent unless a Clean handoff or a reset (R-11) cleared the context.
- **R-6 Handoff by an agent.** The current agent can hand its conversation to a new agent of another role, and its
  own work ends there. A handoff happens because the user or another agent asked for it in a prompt, or because the
  agent decides to. No human confirms it.
  - The handing-off agent may name a model, a thinking level and a registered workspace other than the target
    role's defaults.
  - It chooses a context mode. In every mode the conversation stays the same; only the agent, its seat and the
    context change:
    1. **Full.** The new agent processes the full context.
    2. **Compact.** The context is compacted using a handoff note the agent writes, and the new agent continues from
       the compacted context.
    3. **Clean.** The conversation's context is reset, and the model gets a clean context whose only input is the
       agent's handoff note. Earlier entries stay in the stored transcript and in monitoring, but the model no
       longer sees them.
  - In every mode the new agent starts working without any new input from outside the conversation, on the worker
    thread the conversation already holds.
- **R-7 Seat records.** Every seat change shows in the transcript. The record names:
  - the previous seat and the new seat (role, model, thinking level, workspace)
  - the actor: the user, the agent that handed off (with its role), or an entry point
  - for a handoff, the context mode, and the handoff note when there is one

  Every assistant message is attributed to the seat that produced it.

### Agent invocation, caps and steering

- **R-8 Agent invocation.** Any agent can invoke one or more agents. Each invoked agent gets a new conversation, a
  role, optionally a model, a thinking level and a registered workspace other than the role's defaults, and a job
  prompt.
  - The invoking agent chooses a context mode for each invoked conversation: **Full** (a copy of the invoking
    conversation's context, then the job prompt), **Compact** (a compaction of that context guided by the job prompt,
    then the job prompt) or **Clean** (only the job prompt).
  - Invoked agents follow every rule in this spec, so they can hand off and invoke agents of their own. They run in
    parallel, each on its own worker thread.
  - The invoking agent then chooses how it carries on:
    1. **Steerable.** It keeps running on its worker thread and can steer the agents it invoked (R-10a).
    2. **Parked.** Its conversation is parked: pi-durable keeps the state of the conversation and its agent, and the
       worker thread is freed. A parked agent can't steer. It continues as R-8a describes.
  - Aborting a conversation aborts every conversation it invoked, recursively.
- **R-8a Clean-up step and reports.** When an agent decides its job is done, a clean-up step runs. Which steps run
  (report back, do nothing, release the worker thread) depends on the type of job or conversation, defined in the
  later job spec. This spec requires the report-back step:
  - The invoked agent's summary is delivered into the invoking conversation as a new input the moment the invoked
    agent finishes.
  - If the invoking conversation is running, the report arrives like a follow-up (R-10a). If it is idle or parked, the
    conversation becomes ready, takes a free worker thread and continues with the report.
  - A parked conversation continues either on each report as it arrives or only when every agent it invoked has
    reported. Both behaviours must be possible. Which one applies, and how it is chosen, is decided later.
- **R-9 Depth cap.** Agent invocations may chain only to a maximum depth. A conversation started by an entry point
  or by the user has depth 0, and an invoked conversation has the invoking conversation's depth plus one.
  - An invocation that would exceed the cap is refused. The invoking agent gets an error result that names the cap,
    and its run continues.
  - Handoffs, role changes by the user and resets don't change depth.
- **R-10 Worker threads.** At most a fixed number of agent runs are active at the same time, one per worker thread,
  counted across every origin: root, schedule fires, user-created conversations and agent invocations.
  - Work beyond the cap waits in arrival order and starts when a worker thread frees. It is not dropped.
  - A parked or idle conversation holds no worker thread, so the cap can never deadlock an invoking agent against
    the agents it waits for.
  - A parked conversation that a report makes ready waits for a worker thread like any other work.
  - Monitoring shows waiting work as "waiting for a worker thread".
- **R-10a Steering.** The user, and any agent, can steer a running conversation by injecting a message that the
  running model turn picks up after its current tool round. The message can be queued as a follow-up instead. An
  agent steers through a coordination capability that names the target conversation. A message sent to a parked
  conversation waits until it continues. The transcript records who steered.

### Entry points

- **R-11 Conversations created and reset by the user.** Outside chat, the user can:
  - create a new conversation whose agent has a chosen role (default `bob`), optionally with a model, a thinking
    level and a registered workspace other than its defaults, and give it a first prompt
  - reset any existing conversation: its context is cleared for the model, earlier entries stay in the stored
    transcript, and the seat is kept unless the reset names a new one

  Resetting the root conversation is allowed and doesn't replace it.
- **R-12 Root conversation.** The root conversation exists from the first daemon start, its first agent having the
  `bob` role, and is never replaced. `bob chat` is an interactive window onto it: what you type is submitted to it,
  and its output is shown live. Several chat windows on the root see the same conversation.
- **R-13 Scheduled prompts.** Each fire of a scheduled prompt starts a new conversation. Scheduled runs keep no
  memory between fires.
  - The conversation's agent has the role the schedule entry names (`bob` when the entry names none), with that
    role's defaults.
  - The prompt is its first input, and its origin records the schedule entry and the fire time.
  - An entry that names an unknown role is rejected when schedules are loaded and never fires.
  - If the seat's workspace folder no longer exists at fire time, the fire doesn't run. The skip is recorded with
    the entry, the fire time and the missing path, and no conversation is created.
- **R-14 Unattended runs.** A conversation not attached to an interactive chat never waits for a human. In v1
  there is no step that could make it wait, because the policy is allow-all and no confirmation exists for
  handoffs or agent invocations. Parking waits for agents, not for a human.
- **R-15 Missing workspace during a run.** If a seat's workspace folder disappears while a conversation uses it,
  tool calls that need the workspace fail as ordinary tool errors that the agent sees. The daemon keeps running.

### Monitoring and durability

- **R-16 Monitoring.** The user can do all of the following without the daemon interrupting any running work:
  - list all conversations with id, seat (role, model, thinking level, workspace), origin (root, schedule entry and
    fire, user, invoked by), status (running, idle, parked or waiting for a worker thread) and last activity
  - show the conversations a conversation invoked, recursively
  - read a transcript with seat records and attribution (R-7), including entries from before a reset
  - follow a running conversation live
- **R-17 Durability.** Seats, seat records, resets, invocation links, depth, origins, parked state and undelivered
  reports survive a daemon kill and restart. A seat change, handoff, reset, invocation, park or report interrupted
  by a crash either completed before the crash or completes on resume. It is never half-applied: never a new seat
  without its record, never an invoked conversation without its invocation link, and never a report lost or
  delivered twice. Work waiting for a worker thread is still waiting after the restart, in the same order.

## Workflow

Scheduled prompt, from fire to delegated work:

```
Schedule entry fires (role named, default bob)
  ↓
Workspace of the seat missing? → fire skipped and recorded; stop
  ↓
Entry routing creates a new conversation, origin = schedule entry + fire time; its agent gets the role's defaults
  ↓
Waits for a worker thread if all are busy
  ↓
The agent reads the prompt and identifies the job
  ↓
Either: does the job itself
    or: hands off (full / compact / clean) to another role   → the new agent continues on the same worker thread
    or: invokes agent(s) (full / compact / clean context)    → they run in parallel on their own worker threads
          ├─ steerable: keeps running, may steer them
          └─ parked:    frees its worker thread
        each invoked agent finishes → report-back step       → report arrives as new input; a parked agent
                                                               continues on a free worker thread
                                                               (invocations refused beyond the depth cap)
  ↓
Job done → clean-up step (types and steps: later job spec)
```

Interactive chat:

```
★ User opens bob chat → attached to the root conversation (seat shown)
  ↓
★ User types → submitted to root; while busy, input queues as follow-up or steers
  ↓
★ User may change the seat (role, model, thinking level, workspace) at any time; applies from the next turn
  ↓
The agent may hand off or invoke agents exactly as in the scheduled flow
```

## Configuration Requirements

- **Default model per role.**
  - **What:** an optional default model for `bob` and one for `gp`, so a cheaper or stronger model can be the
    starting point per role.
  - **Where:** the-intern's configuration (described in the daemon spec).
  - **Constraints:** must name a model that the pi agent login and model registry can resolve.
  - **Missing:** falls back to pi agent's default model. A configured model that can't be resolved stops the daemon
    at startup with an error naming the role and the model. A model override at seat time that can't be resolved is
    refused, and the seat stays unchanged.
- **Default thinking level per role.**
  - **What:** an optional default thinking level for `bob` and one for `gp`.
  - **Where:** the-intern's configuration.
  - **Constraints:** a thinking level that pi-durable accepts.
  - **Missing:** falls back to pi agent's default thinking level. An invalid value stops the daemon at startup. A
    thinking-level override at seat time that isn't valid is refused, and the seat stays unchanged.
- **Registered workspaces.**
  - **What:** the folders that may be used as workspaces.
  - **Where:** the-intern's configuration, plus the per-role default workspaces the-intern creates.
  - **Constraints:** an absolute, existing, owner-only directory (trusted input), checked at registration (R-3a).
    The user is responsible for what parent directories contribute, because `AGENTS.md` files are also read from
    parent directories.
  - **Missing:** only the per-role default workspaces exist. A registration that fails the check stops the daemon
    at startup.
- **Default workspace per role.**
  - **What:** an optional registered workspace for `bob` and one for `gp`.
  - **Where:** the-intern's configuration.
  - **Constraints:** must be a registered workspace.
  - **Missing:** the per-role default workspace the-intern creates. A reference to an unregistered workspace stops
    the daemon at startup.
- **Role in a schedule entry.**
  - **What:** an optional role name per schedule entry.
  - **Where:** the user's schedule store.
  - **Constraints:** `bob` or `gp`.
  - **Missing:** `bob`. An unknown name rejects the entry (R-13).
- **Invocation depth cap.**
  - **What:** the maximum invocation depth (R-9). It bounds runaway invocation chains that no human is watching.
  - **Where:** the-intern's configuration.
  - **Constraints:** a positive integer.
  - **Missing:** a built-in default. The exact default value is decided later, before Phase 3 is planned in detail,
    and recorded in this spec through an amendment. An invalid value stops the daemon at startup.
- **Worker threads.**
  - **What:** the number of worker threads, which is the maximum number of active agent runs (R-10). It bounds model
    spend and local load.
  - **Where:** the-intern's configuration.
  - **Constraints:** a positive integer.
  - **Missing:** a built-in default, decided at the same point as the depth cap and together with the daemon
    spec's process model. An invalid value stops the daemon at startup.
- **Live test model.**
  - **What:** the model used by the live acceptance tests.
  - **Where:** a test-only setting.
  - **Constraints:** a low-cost OpenAI model available through the user's existing pi agent login. No credentials
    are stored in the repository or the state dir.
  - **Missing:** live tests are skipped with a visible notice. Deterministic tests still run.

## Verification

- **Deterministic tests** use a fake model whose replies are a pure function of the transcript. They cover:
  - seat effects (R-4, R-5), including overrides of model, thinking level and workspace, and that changing a role's
    defaults leaves seated agents alone
  - each handoff context mode (R-6): after Clean, the model's context contains only the handoff note while the
    stored transcript keeps every entry; the new agent runs on the same worker thread
  - seat records (R-7)
  - agent invocation (R-8): each context mode; several invoked agents running in parallel; steerable with steering
    of an invoked agent; parked, with the worker thread freed; recursive abort
  - reports (R-8a): a report arrives as new input in a running, an idle and a parked invoking conversation; a
    parked conversation continues on each report, and in the other behaviour only after the last report
  - steering (R-10a), including a message sent to a parked conversation
  - R-9 and R-10: an invocation at the depth cap is refused while the invoking agent continues; with one worker
    thread, a parked agent's invoked agent runs and the parked agent then continues; waiting work starts in arrival
    order
  - R-3a: registration accepts a valid folder and refuses a relative, missing, non-directory or group- or
    world-accessible path
  - R-11 to R-13: create and reset; the root's first agent has the `bob` role; fires create conversations with their
    role and origin; a fire whose workspace is missing is skipped and recorded
  - R-15: a removed workspace produces a tool error and the daemon keeps running
  - R-16: list, statuses, invocations and transcript content
  - R-17: a test kills the daemon during a seat change, a Clean handoff, an agent invocation, while a conversation is
    parked, while a report is being delivered and while work waits for a worker thread, then checks the invariants
    after restart
- **Live acceptance tests** run against the user's pi agent-configured OpenAI account with a low-cost model:
  1. A scheduled prompt for the `bob` role that asks for a simple file job in `gp`'s workspace. The agent hands off
     to `gp` or invokes a `gp` agent, the file appears in `gp`'s workspace, and the transcript shows the seat change
     or the invocation.
  2. In `bob chat`, change the root conversation's role from `bob` to `gp`. The next answer is attributed to `gp`,
     and `gp`'s tools run in `gp`'s workspace.
  3. A `gp` agent invokes two `bob` agents and parks. Both reports arrive as new input, and the `gp` agent continues.
- **Prompt stability:** with the seat unchanged, two consecutive turns produce byte-identical system prompt
  sections.

## Implementation Order

This spec relies on the daemon and host-runtime spec for the database, startup, configuration and process model,
and on the control-endpoint spec for the surfaces chat and monitoring use. Its phases can be developed against a
minimal host until those exist.

| Phase | What | Depends On |
|---|---|---|
| 1 | Role catalog, workspace registration, seating with overrides and role prompt: root conversation with the `bob` role; user changes the seat; user creates and resets conversations; seat records and attribution | Daemon and host runtime |
| 2 | Handoff by agents in all three context modes | Phase 1 |
| 3 | Agent invocation (context modes, steerable and parked), report-back step, recursive abort, steering by agents, depth cap | Phase 1 |
| 4 | Worker threads, and parked conversations freeing them | Phase 3, daemon spec's process model |
| 5 | Entry points: chat as a window onto root; schedule entries name a role, with the missing-workspace skip. Monitoring: list, statuses, invocations, live transcript | Phases 1–3, control endpoint |

## Amendment Log
