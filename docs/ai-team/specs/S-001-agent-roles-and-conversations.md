---
title: Agent roles and conversations
version: '0.2'
status: approved  # draft | review | approved | superseded
created: '2026-10-15'
author: planner
id: S-001
---

# Agent roles and conversations

## Purpose

This spec covers the **Agents and roles** component of S-000. The-intern is a single daemon that runs every
conversation in one pi-durable database. All of its work is organised as jobs (S-000), and the work on a job is done
by agents working in conversations. Before any way in, schedule or client can be built, we need to define what a
conversation is, what the agent working in it is, and how agents share the work of a job.
That needs **roles** that agents are made from: each role brings its own instructions, tools and default model,
thinking level and workspace. Each job has exactly one lead agent at a time. The lead can pass the job's conversation
to an agent of another role whenever the state of the job calls for it, and can invoke agents of specialist roles to
work on parts of the job in parallel.

When this spec is done:

- the-intern ships two roles, `bob` (the default lead) and `gp` (a general-purpose executor), and team members can
  create, edit and remove their own roles.
- Every conversation has one agent at a time, and each agent has one role.
- Every job has one lead conversation, whose current agent is the job's lead agent.
- A team member or an agent can pass a conversation to an agent of another role at any time.
- Any agent can invoke other agents of any role, and either keep working and steer them, or park until they report.
- A waiting conversation, including one whose job is blocked, doesn't hold a worker thread.
- Every job source (a request, a schedule fire, a trigger, a follow-up) starts a job's lead conversation with a role.
- Team members can see which role is working where, and for which job.

## Definitions

### Project terms

| Term | Meaning in this spec |
|---|---|
| the-intern | The product. It runs as a daemon. |
| bob | The name of the default lead role (R-1) and of the CLI. |
| Team member | Anyone who can reach one of the-intern's ways in (S-000). All team members are equal: each can give jobs, follow and steer work, and configure the-intern. |
| Role | A set of parameters that an agent is made from: instructions (system prompt), tools and skills, plus default values for the pi-durable agent parameters: model, thinking level and workspace (the pi-durable `cwd`). If a role is a class, an agent is an object of that class. |
| Agent | The actor that interacts with the model and carries out a conversation. A conversation has one agent at a time and can be a succession of agents: each role change ends the current agent and seats a new one in the same conversation. An agent keeps its role for its whole life. It is not an operating-system process: the daemon runs every agent, and the current agent's configuration is the pi-durable agent of its conversation. |
| Seat | The place of the current agent in a conversation, with the role, model, thinking level and workspace it runs with: the role's defaults, or overrides given when the agent was seated or invoked. |
| Job | The product's unit of work (S-000): it has a definition, a status, open questions, evidence and follow-up jobs, kept in the job record. The job record and the job's steps belong to the Jobs component and its own spec. This spec defines only how agents and conversations work on a job. |
| Lead conversation, lead agent | Each job has one lead conversation. Its current agent is the job's lead agent, which carries the job from definition to verification and is the only agent that closes it. A handoff in the lead conversation passes the lead to the new agent, so a job has exactly one lead at a time. |
| Specialist agent | An agent invoked for a part of a job. It works in its own conversation, finishes its part and reports back. It never closes the job. |
| Handoff | The current agent passes its conversation to a new agent of another role. Same conversation, same worker thread. |
| Agent invocation | An agent starts one or more agents, each in a new conversation of the same job, with a role and a job prompt for its part. Neither agent owns the other. |
| Context mode | How a new agent's context starts, for a handoff or an invocation: **Full** (the existing context), **Compact** (a compaction of the existing context, guided by a note) or **Clean** (only the note or the job prompt). |
| Steerable, parked | The two ways an invoking agent can carry on. Steerable: it keeps running and can steer the agents it invoked. Parked: its conversation's state is kept, its worker thread is freed, and it continues when a report arrives. |
| Clean-up step | What runs when an agent decides its part is done: report a summary back to the invoking conversation, do nothing, and/or release the worker thread. Chosen programmatically by the type of conversation. |
| Agent run | The model turns an agent takes from picking up an input until its conversation is idle or parked. One agent run uses one worker thread. |
| Model turn | One model request and the tool calls it makes. A seat change applies from the next model turn, so it can take effect during an agent run. |
| Worker thread | A logical unit of capacity: one active agent run uses one. Their number is S-000's limit on how many agents work at once (R-10). Whether they are operating-system threads is the daemon spec's choice. |
| Thread | Only in the multi-threading sense. |
| Reset | Clears what the model sees of a conversation. The conversation, its id and its stored entries stay. |
| Transcript, context | The transcript is every stored entry of a conversation. The context is what the model receives on the next request, after resets and compactions. |
| Workspace | A registered local folder that an agent works in. It supplies extra instructions and skills, and is where tools start. Agents work on the OS and filesystem with the account the-intern runs as; the workspace doesn't limit what they reach. |
| Job source, origin | A job source starts a job and its lead conversation: a request from a team member (command line, web interface, email), a schedule fire, a trigger, or a follow-up job created by an agent. The origin of a conversation records its job source, or the invoking conversation for an agent invocation. |

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
| Root conversation | None | Conversation 1, created by the host's first `root()` call. Not a parent of other conversations. | Not used by the-intern. Every conversation belongs to a job. |
| Turn, run | A turn is one assistant message and its tool calls; a prompt runs until the agent ends | A turn is one model response and its tool calls; a run is the turns from an input to its final answer | Model turn and agent run, as defined above. |
| Task | Not a pi agent concept | A durable state machine: generation, tool call, compaction | Only the pi-durable meaning. The work the-intern does is a job. |
| Extension | A module pi agent loads from its agent folder, a trusted project's `.pi/extensions` or a flag | Tools, prompt sections and hooks that the host installs in its registry | Only the-intern's own pi-durable extensions. pi agent extensions are not loaded, neither the account's nor a workspace's, so an agent is offered exactly its role's tools (R-5). |
| Skills | Loaded from pi agent's agent folder, `~/.agents/skills` and trusted project folders. The prompt lists name and description, and the model reads the file when needed. | No skill loading of its own | The role's skills plus the workspace skills, listed the same way as in pi agent. The account's own pi agent skills are not loaded. |
| Context files | `AGENTS.md`/`CLAUDE.md` from pi agent's agent folder, the cwd and its parent directories | None; the host supplies prompt sections | Those of the workspace and its parent directories. |
| cwd | The working directory of the `pi` process | The `cwd` of the pi-durable agent | The seat's workspace. |
| New, fork, reset | `/new` starts a new pi agent session file; `/fork` copies one | A reset entry clears the model's context inside the same conversation; creating a conversation starts an empty one; a fork copies entries up to a point | A Clean handoff and a reset stay in the same conversation. Only job sources and agent invocations create conversations. A Full-context invocation may be built on a pi-durable fork. |
| Compaction | Summarises older messages near the context limit, or on `/compact` | The same, as a pi-durable task, on by default | Automatic compaction is unchanged by this spec. The Compact context mode is an extra compaction guided by the agent's note. |
| Steer, follow-up | Messages queued during a run: a steer arrives after the current tool calls, a follow-up after the run ends. Held in memory. | The same, through a durable inbox | The same meanings (R-10a), and durable. |
| Default model, thinking level | Chosen by pi agent's settings | None; the host passes them | "pi agent's default" (R-3) is what the pi agent settings of the account the-intern runs as select. |

## Exclusions

What this specification explicitly does NOT cover:

- **An overlord across jobs.** A single long-lived coordinator conversation that owns every job, or a `bob` that
  owns the agents it invokes, is rejected. Each job has its own lead conversation. The lead owns its job, not the
  agents it invokes: invoked agents follow every rule in this spec and are peers in how they work.
- **A new conversation per handoff.** A handoff never creates a conversation. A clean start inside the same
  conversation is the Clean context mode. Only job sources and agent invocations create conversations.
- **The job record and the job's steps.** What a job records, its statuses, when it counts as blocked, how an answer
  resumes it, how the lead verifies and closes it, follow-up jobs, and export and import belong to the Jobs spec. This
  spec requires only that every conversation knows its job (R-12), that the lead conversation parks while its job is
  blocked (R-14), and the report-back clean-up step (R-8a).
- **When a parked agent continues.** Whether a parked agent continues on each report as it arrives, or stays parked
  until every agent it invoked has reported, is decided later. Both must be possible (R-8a).
- **Approval rules for actions.** S-000 excludes per-action rules: what an agent can do is bounded by the account
  the-intern runs as and the tools its role is offered.
- **The mailbox, schedules and triggers themselves.** Reading the-intern's own mailbox belongs to the Email spec, and
  when schedules and triggers fire belongs to the schedules and triggers spec. This spec defines only the lead
  conversation each of them starts (R-13).
- **Interactive chat.** There is no chat window and no root conversation. Team members follow, answer and steer jobs
  through the command line, the web interface and email.
- **Model, thinking level or workspace per schedule entry.** Whether a schedule entry can name values other than its
  role's defaults is an open question, deferred. In v1 a fire runs with the named role's defaults.
- **Process and concurrency model.** Whether worker threads are operating-system threads, share one event loop or
  are spread over several processes belongs to the daemon and host-runtime spec. This spec uses worker threads only
  as a logical unit of capacity and states the observable caps (R-9, R-10).
- **Technology choices.** The control protocol, client transport, storage layout, config file format and process
  model belong to the daemon and control-endpoint specs and to S-000's Installation and service setup. This spec
  states behaviour only.

## Architecture

### Design Principles

- **One agent at a time per conversation.** A conversation can be a succession of agents, but at any moment it has
  exactly one, with one seat. Every model turn runs with that seat's model, thinking level, instructions, tools,
  skills and workspace. Nothing in a turn mixes two seats.
- **One lead per job.** Each job has one lead conversation, and its current agent is the job's only lead. Agents
  invoked for parts of the job work in their own conversations and report back; only the lead closes the job.
- **Roles are starting points that the team shapes.** A role supplies instructions, tools and skills, plus a default
  model, thinking level and workspace. Team members can change all of them, and create and remove roles. Each seat
  may run a different model, thinking level or registered workspace than the role's defaults, and changing a role
  affects only agents seated after the change.
- **No agent owns another.** An agent of any role can hand its conversation to any role and invoke agents of any
  role. `bob` is only the default lead role, and no agent owns the agents it invokes.
- **A role is configuration, not a process.** Seating an agent changes stored per-conversation configuration only.
  No process or connection is tied to a role or to an agent.
- **The seat carries the workspace.** The workspace is part of the seat, so a new agent can work in another
  workspace. A conversation has no workspace apart from its current seat.
- **Workspaces are verified once, when registered.** Only registered workspaces can be used. Registration checks
  them, and use doesn't re-validate beyond noticing that a folder has disappeared.
- **Waiting costs no worker thread.** A parked or idle conversation, including the lead conversation of a blocked
  job, holds no worker thread. pi-durable keeps its state, and it takes a free worker thread again when it has input.
- **Every agent change is visible and durable.** Each seat change, reset, handoff, invocation, park and report is
  recorded in the transcript or the conversation's metadata, survives a daemon restart, and appears in monitoring
  without a model having to describe it.
- **Unattended except for a blocked job's question.** No step waits for a human, except a blocked job waiting for
  the answer to its question. Handoffs and agent invocations proceed on agent decisions alone.
- **Bounded delegation.** Invocation depth and the number of worker threads are capped, so no chain of unattended
  agents can grow without limit. The worker-thread count also bounds how wide delegation can spread.

### System Diagram

```
 job sources                        conversations (one database)                 roles (catalog)
┌──────────────────┐   new job   ┌────────────────────────────────────┐  seat   ┌──────────────────┐
│ request (CLI,    ├────────────►│ job A: lead conversation [bob]     │◄────────┤ bob  (default    │
│ web, email)      │             │   ├─ invokes #m      [role: gp]    │         │  lead), gp,      │
├──────────────────┤             │   │    └─ invokes …  [role: any]   │         │  team roles      │
│ schedule fire,   │──new job───►│   ├─ steerable or parked           │         │                  │
│ trigger          │             │   └─ handoff / reset: same conv,   │         │ each: instr.,    │
├──────────────────┤             │      next agent, context mode      │         │  tools, skills;  │
│ follow-up job    │──new job───►│ job B: lead conversation [gp]      │         │  default model,  │
│ (from an agent)  │             │                                    │         │  thinking,       │
│                  │             │ reports return as new input        │         │  workspace*      │
└──────────────────┘             └──────┬───────────────▲─────────────┘         └──────────────────┘
                                        │ role-attributed│ seat change, reset,   * team-set; a seat
                                        ▼ transcript     │ steer, invocation       may override them
                                 ┌──────────────┐  ┌─────┴───────────────┐      (registered workspaces)
                                 │ monitoring   │  │ agent coordination  │
                                 │ (list, jobs, │  │ (handoff, invoke,   │
                                 │ invocations, │  │  steer, report)     │
                                 │ live)        │  │ + caps, worker thr. │
                                 └──────────────┘  └─────────────────────┘
```

### Responsibility Separation

| Component | Responsibility | Notes |
|---|---|---|
| Role catalog | Holds the shipped roles, the team's own roles, their defaults, and the registered workspaces | Changed by team members through settings operations (R-3) |
| Seating | Seats an agent of a role in a conversation, with optional model, thinking level and workspace overrides, and records who seated it | The only path that changes a conversation's seat |
| Role prompt | Builds what the model sees: the-intern's preamble, role instructions, role skills, workspace instructions and workspace skills | Must stay byte-stable while the seat and the role are unchanged |
| Agent coordination | Agent-callable handoff, agent invocation and steer capabilities; parking; the report-back clean-up step; the depth cap and the worker threads | Every role is offered the same coordination capabilities |
| Entry routing | Starts a job's lead conversation for each job source, and handles reset requests from team members | Holds no channel knowledge beyond choosing the role and recording the origin |
| Monitoring | Lists conversations with their job, seats, origins, status, invocation links and live transcripts | Read-only. Abort, reset and steer go through other components |

## Components

### Component 1: Role catalog

**Purpose:** Hold the shipped roles (`bob`, `gp`) and the roles team members create, with their instructions, tools,
skills, default model, thinking level and workspace, and the registered workspaces, each checked when it is
registered.
**Estimated size:** Small to medium.
**Interfaces:** Exposes role lookup, listing, creation, change and removal, and workspace lookup and listing.
Consumes the-intern's settings, its shipped tools and pi agent's default model and thinking level.

### Component 2: Seating

**Purpose:** Seat an agent of a role in a conversation, with optional model, thinking level and workspace
overrides, so that later turns use that seat, and record the change.
**Estimated size:** Small to medium.
**Interfaces:** Exposes "seat an agent of role R in conversation C, by actor A, optionally with model M, thinking
level T and workspace W". Consumes the role catalog and the pi-durable agent of each conversation.

### Component 3: Role prompt

**Purpose:** Render the system prompt for the current seat: the-intern's preamble, the role's instructions, the
role's skills, plus the workspace's `AGENTS.md`/`CLAUDE.md` and the workspace's skills.
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

**Purpose:** For each job source, start the job's lead conversation with the role the source names (`bob` when it
names none) and record its origin. Serve team members' requests to reset conversations.
**Estimated size:** Small.
**Interfaces:** Exposes "start the lead conversation of job J with role R, origin O" and "reset conversation C".
Consumes seating and the role catalog. Called by the Jobs component when a job is created.

### Component 6: Monitoring

**Purpose:** Let team members see every conversation: its job and whether it is the job's lead conversation, its
current seat (role, model, thinking level, workspace), origin, status, the conversation that invoked it and the ones
it invoked, and its transcript, live while it runs.
**Estimated size:** Medium.
**Interfaces:** Exposes list, invocations, transcript and live-follow views to the command line and the web
interface. Consumes the conversation store and its observation streams.

## Behavioural Requirements

Each requirement is checked as described in **Verification** below.

### Roles and workspaces

- **R-1 Shipped roles.** the-intern ships two roles, `bob` and `gp`. Every role, shipped or created by a team member,
  has a name, instructions, a tool set, a skill set (possibly empty), a default model, a default thinking level and
  a default workspace. `bob` is the default lead role.
- **R-2 What the shipped roles are for.**
  - **`bob`** leads jobs. Its instructions direct the agent to define the job (goal, needs, plan and definition of
    done), ask for what is missing, then do the work itself, hand it to a better-suited role or invoke other agents
    for parts of it, and finally verify the result against the definition of done.
  - **`gp`** is a general-purpose executor. Its instructions and shipped skills describe how to carry out a part of a
    job to completion and report back.
  - Both roles are offered the coordination capabilities (R-6 to R-8a). The shipped text of the instructions, the tool
    lists and `gp`'s skill content are set during implementation and may change in later versions without amending
    this spec. They must satisfy the descriptions above.
- **R-3 Role settings.** A team member can, in the-intern's configuration or while the daemon runs (S-002 R-22):
  - **create** a role with a name, instructions, a tool set chosen from the tools the-intern ships, skills, and
    optionally a default model, thinking level and workspace
  - **change** any role's instructions, tool set, skills, default model, thinking level and workspace, including the
    shipped roles'. A change to a shipped role is kept in the-intern's settings and never edits the installed copy, and
    it can be undone to restore the shipped role.
  - **remove** a role the team created. Removing a shipped role is refused. Removing a role that a schedule entry or
    trigger names is refused, with an error naming them.
  - **register and unregister** workspaces (R-3a)

  Defaults and changes follow these rules:
  - A role without a configured default model uses pi agent's default model, and one without a configured default
    thinking level uses pi agent's default thinking level.
  - A role without a configured default workspace uses a default workspace that the-intern creates and registers for
    that role, owner-only, under the-intern's own data location.
  - A tool set can name only tools the-intern ships. A change naming an unknown tool is refused.
  - The coordination capabilities (R-6 to R-8a, R-10a) are part of every role. A tool set can't leave them out.
  - A change to a role, or its removal, affects only agents seated after the change. Agents already seated keep
    their instructions, tools, skills, model, thinking level and workspace until their seat changes.
- **R-3a Workspace registration.** A workspace is a local folder: the files an agent works on, extra instructions
  (`AGENTS.md`), workspace skills and scratch space. A folder can be used as a workspace only after a team member
  registers it.
  - Registration checks that the path is absolute, exists, is a directory and is accessible only to the account
    the-intern runs as.
  - A registration that fails the check is refused with an error naming the path and the reason. If the failure
    comes from configuration loaded at startup, the daemon doesn't start.
  - A role's default workspace must be a registered workspace.
  - **Unregistering** a workspace is refused while a role's default workspace is that workspace, with an error
    naming the role. The per-role default workspaces the-intern creates can't be unregistered.
  - After unregistering, agents already seated in the workspace keep working there until their seat changes. New
    seats, whether set by a team member, a handoff or an agent invocation, can't name it, and a seat change that
    names it is refused, leaving the seat unchanged.

### Seating, overrides and handoff

- **R-4 Role change by a team member.** A team member can change the seat of any conversation at any time.
  - The new seat names a role, and may name a model, a thinking level and a registered workspace other than that
    role's defaults. A new agent of that role is seated, with the Full context mode.
  - The change applies from the next model turn. A model turn already running finishes with the seat it started
    with, unless the team member also aborts or steers it.
  - Changing the seat of a job's lead conversation changes the job's lead agent.
- **R-5 Seat effects.** After a seat is applied, every model turn in that conversation:
  - uses the seat's model and thinking level
  - sees the role's instructions and skills
  - is offered exactly the role's tools and the coordination capabilities
  - runs its tools in the seat's workspace
  - sees that workspace's instructions and skills

  Nothing of the previous seat's instructions, skills or workspace stays in the system prompt. The transcript
  stays visible to the new agent unless a Clean handoff or a reset (R-11) cleared the context.
- **R-6 Handoff by an agent.** The current agent can hand its conversation to a new agent of another role, and its
  own work ends there. A handoff happens because a team member or another agent asked for it in a prompt, or because
  the agent decides to. No human confirms it. A handoff in a job's lead conversation passes the lead to the new
  agent.
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
  - the actor: a team member (with the way in they used), the agent that handed off (with its role), or a job source
  - for a handoff, the context mode, and the handoff note when there is one

  Every assistant message is attributed to the seat that produced it.

### Agent invocation, caps and steering

- **R-8 Agent invocation.** Any agent can invoke one or more agents for parts of its job. Each invoked agent gets a
  new conversation of the same job, a role, optionally a model, a thinking level and a registered workspace other
  than the role's defaults, and a job prompt for its part.
  - The invoking agent chooses a context mode for each invoked conversation: **Full** (a copy of the invoking
    conversation's context, then the job prompt), **Compact** (a compaction of that context guided by the job prompt,
    then the job prompt) or **Clean** (only the job prompt).
  - Invoked agents follow every rule in this spec, so they can hand off and invoke agents of their own. They run in
    parallel, each on its own worker thread. An invoked agent finishes its part and reports; it never closes the job.
  - The invoking agent then chooses how it carries on:
    1. **Steerable.** It keeps running on its worker thread and can steer the agents it invoked (R-10a).
    2. **Parked.** Its conversation is parked: pi-durable keeps the state of the conversation and its agent, and the
       worker thread is freed. A parked agent can't steer. It continues as R-8a describes.
  - Aborting a conversation also aborts the invoked conversations whose report it is still waiting for, whether it
    is steerable or parked. Each of those aborts the conversations it waits for in turn. Aborting a job aborts every
    conversation of the job.
- **R-8a Clean-up step and reports.** When an invoked agent decides its part is done, the report-back clean-up step
  runs:
  - The invoked agent's summary is delivered into the invoking conversation as a new input the moment the invoked
    agent finishes.
  - If the invoking conversation is running, the report arrives like a follow-up (R-10a). If it is idle or parked, the
    conversation becomes ready, takes a free worker thread and continues with the report.
  - A parked conversation continues either on each report as it arrives or only when every agent it invoked has
    reported. Both behaviours must be possible. Which one applies, and how it is chosen, is decided later.

  When the lead agent decides the job is done, closing the job follows the Jobs spec.
- **R-9 Depth cap.** Agent invocations may chain only to a maximum depth. A job's lead conversation has depth 0, and
  an invoked conversation has the invoking conversation's depth plus one.
  - An invocation that would exceed the cap is refused. The invoking agent gets an error result that names the cap,
    and its run continues.
  - Handoffs, role changes by a team member and resets don't change depth.
- **R-10 Worker threads.** At most a fixed number of agent runs are active at the same time, one per worker thread,
  counted across every job and every conversation. This is S-000's limit on how many agents work at once, and it
  also bounds how wide invocations spread.
  - Work beyond the cap waits in arrival order and starts when a worker thread frees. It is not dropped.
  - A parked or idle conversation holds no worker thread, so the cap can never deadlock an invoking agent against
    the agents it waits for, and a blocked job never counts against it.
  - A parked conversation that a report or an answer makes ready waits for a worker thread like any other work.
  - Monitoring shows waiting work as "waiting for a worker thread".
- **R-10a Steering.** A team member, and any agent, can steer a running conversation by injecting a message that the
  running model turn picks up after its current tool round. The message can be queued as a follow-up instead. An
  agent steers through a coordination capability that names the target conversation. A message sent to a parked
  conversation waits until it continues. The transcript records who steered.

### Job sources

- **R-11 Reset by a team member.** A team member can reset any conversation: its context is cleared for the model,
  earlier entries stay in the stored transcript, and the seat is kept unless the reset names a new one.
- **R-12 Lead conversation of a job.** When a job is created (Jobs spec), entry routing starts its lead conversation:
  - with the role the job source names, or `bob` when it names none, with that role's defaults unless a team member's
    request names a model, a thinking level or a registered workspace
  - with the job's first input as its first input
  - with an origin that records the job source: the team member's request and its way in, the schedule entry and fire
    time, the trigger and its event, or the conversation that created the follow-up job

  Every conversation records the job it belongs to and whether it is the job's lead conversation.
- **R-13 Schedule fires and triggers.** Each fire of a schedule entry or of a trigger creates a new job and so a new
  lead conversation (R-12).
  - The schedule entry or trigger may name a role. An entry that names an unknown role is rejected when it is loaded
    or created and never fires.
  - A schedule entry chooses whether each run starts fresh or sees the history of its last runs, up to a number the
    entry gives. A fresh run's lead conversation starts with only the job's first input. Otherwise its first input
    also carries the job records of the entry's last runs, as the schedules and triggers spec defines.
  - If the seat's workspace folder no longer exists at fire time, the fire doesn't run. The skip is recorded with
    the entry, the fire time and the missing path, and no job is created.
  - A fire while the entry's previous job is still working is skipped, as the schedules and triggers spec defines.
- **R-14 Unattended runs and blocked jobs.** No conversation waits for a human, except a job's lead conversation while
  its job is blocked. Then the lead conversation is parked: it holds no worker thread, and the answer to the job's
  question arrives as a new input that makes it ready again. Handoffs and agent invocations have no confirmation
  step. Parking for reports waits for agents, not for a human.
- **R-15 Missing workspace during a run.** If a seat's workspace folder disappears while a conversation uses it,
  tool calls that need the workspace fail as ordinary tool errors that the agent sees. The daemon keeps running.

### Monitoring and durability

- **R-16 Monitoring.** A team member can do all of the following without the daemon interrupting any running work:
  - list all conversations with id, job, whether it is the job's lead conversation, seat (role, model, thinking
    level, workspace), origin (job source or invoking conversation), status (running, idle, parked or waiting for a
    worker thread) and last activity
  - list the conversations of a job
  - show the conversations a conversation invoked, recursively
  - read a transcript with seat records and attribution (R-7), including entries from before a reset
  - follow a running conversation live
- **R-17 Durability.** Seats, seat records, resets, job links, invocation links, depth, origins, parked state and
  undelivered reports survive a daemon kill and restart. A seat change, handoff, reset, invocation, park or report
  interrupted by a crash either completed before the crash or completes on resume. It is never half-applied: never a
  new seat without its record, never an invoked conversation without its invocation link, never a lead conversation
  without its job, and never a report lost or delivered twice. Work waiting for a worker thread is still waiting after
  the restart, in the same order.

## Workflow

A job, from its source to delegated work:

```
Job source: request, schedule fire, trigger or follow-up (role named, default bob)
  ↓
Schedule fire: workspace of the seat missing, or previous job still working? → skipped and recorded; stop
  ↓
Jobs creates the job → entry routing starts its lead conversation, origin = job source
  ↓
Waits for a worker thread if all are busy
  ↓
The lead agent defines the job (Jobs spec)
  ↓
Information missing? → job blocked, lead conversation parked (no worker thread) → answer arrives → continues
  ↓
Either: does the work itself
    or: hands off (full / compact / clean) to another role   → the new agent leads, on the same worker thread
    or: invokes agent(s) (full / compact / clean context)    → they run in parallel on their own worker threads
          ├─ steerable: keeps running, may steer them
          └─ parked:    frees its worker thread
        each invoked agent finishes its part → report-back   → report arrives as new input; a parked agent
                                                               continues on a free worker thread
                                                               (invocations refused beyond the depth cap)
  ↓
The lead verifies against the definition of done and closes the job (Jobs spec)
```

## Configuration Requirements

- **Roles.**
  - **What:** the team's own roles, and the changes made to the shipped roles: instructions, tool set, skills,
    default model, thinking level and workspace (R-3).
  - **Where:** the-intern's configuration (described in the daemon spec), also changeable while the daemon runs
    (R-3, S-002 R-22).
  - **Constraints:** role names are unique; a tool set names only shipped tools; a model must be one that the pi
    agent login and model registry can resolve; a thinking level must be one pi-durable accepts; a default workspace
    must be registered.
  - **Missing:** only the shipped roles, with pi agent's default model and thinking level and their per-role default
    workspaces. A configured model that can't be resolved, an invalid thinking level, an unknown tool or a reference
    to an unregistered workspace stops the daemon at startup with an error naming the role and the value. An
    override at seat time that can't be resolved is refused, and the seat stays unchanged.
- **Registered workspaces.**
  - **What:** the folders that may be used as workspaces.
  - **Where:** the-intern's configuration, plus the per-role default workspaces the-intern creates. Registrations
    and unregistrations can also be made while the daemon runs (R-3a, S-002 R-22).
  - **Constraints:** an absolute, existing directory accessible only to the account the-intern runs as (trusted
    input), checked at registration (R-3a). Team members are responsible for what parent directories contribute,
    because `AGENTS.md` files are also read from parent directories.
  - **Missing:** only the per-role default workspaces exist. A registration that fails the check stops the daemon
    at startup.

A change to one of the settings above made while the daemon runs is checked as at startup. Where an invalid value in
the file stops the daemon at startup, an invalid runtime change is refused with the reason and nothing changes
(S-002 R-22).

- **Role in a schedule entry or trigger.**
  - **What:** an optional role name per schedule entry or trigger.
  - **Where:** the schedule and trigger store.
  - **Constraints:** an existing role.
  - **Missing:** `bob`. An unknown name rejects the entry (R-13).
- **Run history per schedule entry.**
  - **What:** whether each run starts fresh or sees the history of the entry's last runs, and how many (R-13).
  - **Where:** the schedule and trigger store.
  - **Constraints:** a whole number of runs, zero meaning fresh.
  - **Missing:** fresh.
- **Invocation depth cap.**
  - **What:** the maximum invocation depth (R-9). It bounds runaway invocation chains that no human is watching.
  - **Where:** a built-in constant of the daemon (S-002 R-9), not a setting.
  - **Constraints:** **10**. It changes only with a release.
  - **Missing:** not applicable; the constant always applies.
- **Worker threads.**
  - **What:** the number of worker threads, which is the maximum number of active agent runs (R-10). It bounds
    local load.
  - **Where:** a built-in constant of the daemon (S-002 R-9), not a setting. Tests may set a smaller count
    through a test-only switch.
  - **Constraints:** **32**, the most concurrent agent runs the daemon is tested with. It changes only with a
    release, after load tests.
  - **Missing:** not applicable; the constant always applies.
- **Live test model.**
  - **What:** the model used by the live acceptance tests.
  - **Where:** a test-only setting.
  - **Constraints:** a low-cost OpenAI model available through the existing pi agent login of the account running
    the tests. No credentials are stored in the repository or the state dir.
  - **Missing:** live tests are skipped with a visible notice. Deterministic tests still run.

## Verification

- **Deterministic tests** use a fake model whose replies are a pure function of the transcript. They cover:
  - R-3: creating, changing and removing a role; changing a shipped role and restoring it; removing a shipped role,
    or a role a schedule entry names, is refused; an unknown tool is refused; seated agents keep their role as it was
    when they were seated
  - seat effects (R-4, R-5), including overrides of model, thinking level and workspace, and a seat change of a lead
    conversation changing the job's lead
  - each handoff context mode (R-6): after Clean, the model's context contains only the handoff note while the
    stored transcript keeps every entry; the new agent runs on the same worker thread
  - seat records (R-7)
  - agent invocation (R-8): each context mode; several invoked agents running in parallel in conversations of the
    same job; steerable with steering of an invoked agent; parked, with the worker thread freed; an abort reaches
    the invoked agents whose report is awaited, recursively; aborting a job aborts all its conversations
  - reports (R-8a): a report arrives as new input in a running, an idle and a parked invoking conversation; a
    parked conversation continues on each report, and in the other behaviour only after the last report
  - steering (R-10a), including a message sent to a parked conversation
  - R-9 and R-10: an invocation at the depth cap is refused while the invoking agent continues; with one worker
    thread, a parked agent's invoked agent runs and the parked agent then continues; waiting work starts in arrival
    order
  - R-3a: registration accepts a valid folder and refuses a relative, missing, non-directory or group- or
    world-accessible path; unregistering is refused for a role's default workspace and for a per-role default
    workspace the-intern created; after unregistering, a seated agent keeps working there and a new seat naming it
    is refused
  - R-11 to R-13: reset; a new job's lead conversation gets the named role (or `bob`), its first input and its
    origin for each job source; a fire with fresh history and one with the last runs' history; a fire whose
    workspace is missing is skipped and recorded
  - R-14: a blocked job's lead conversation holds no worker thread, and an answer makes it continue
  - R-15: a removed workspace produces a tool error and the daemon keeps running
  - R-16: list, job links, statuses, invocations and transcript content
  - R-17: a test kills the daemon during a seat change, a Clean handoff, an agent invocation, while a conversation is
    parked, while a report is being delivered and while work waits for a worker thread, then checks the invariants
    after restart
- **Live acceptance tests** run against the pi agent-configured OpenAI account of the account running the tests,
  with a low-cost model:
  1. A scheduled job for the `bob` role that asks for a simple file task in `gp`'s workspace. The lead hands off to
     `gp` or invokes a `gp` agent, the file appears in `gp`'s workspace, and the transcript shows the seat change or
     the invocation.
  2. From the command line, change the seat of a job's lead conversation from `bob` to `gp`. The next answer is
     attributed to `gp`, and `gp`'s tools run in `gp`'s workspace.
  3. A `gp` agent invokes two `bob` agents and parks. Both reports arrive as new input, and the `gp` agent continues.
- **Prompt stability:** with the seat and the role unchanged, two consecutive turns produce byte-identical system
  prompt sections.

## Implementation Order

This spec relies on the daemon and host-runtime spec for the database, startup, configuration and process model,
on the control-endpoint spec for the surfaces the command line, the web interface and monitoring use, and on the
Jobs spec for creating jobs. Its phases can be developed against a minimal host until those exist.

| Phase | What | Depends On |
|---|---|---|
| 1 | Role catalog with shipped and team roles, workspace registration, seating with overrides and role prompt; team member changes the seat; resets; seat records and attribution | Daemon and host runtime |
| 2 | Handoff by agents in all three context modes | Phase 1 |
| 3 | Agent invocation (context modes, steerable and parked), report-back step, abort of awaited invoked agents, steering by agents, depth cap | Phase 1 |
| 4 | Worker threads, and parked conversations freeing them | Phase 3, daemon spec's process model |
| 5 | Job sources: lead conversations for requests, schedule fires and triggers with run history, follow-ups, the missing-workspace skip; blocked jobs parking. Monitoring: list, job links, statuses, invocations, live transcript | Phases 1–3, control endpoint, Jobs spec |

## Amendment Log

| Date | What changed | Why | Affected tasks |
|------|-------------|-----|----------------|
| 2026-10-17 | The invocation depth cap (10) and the worker-thread count (32) became built-in constants instead of user settings. Role defaults and workspace registration can change while the daemon runs, and workspaces can be unregistered (R-3, R-3a, Configuration Requirements, Verification). Consistency review: the per-role settings entries name the runtime path too. | Decided with the daemon spec (S-002 R-9, R-22): the counts follow load tests, not user tuning; settings changed from clients apply without a restart. | None; S-001 isn't broken down yet |
| 2026-10-19 | Wording only: removed references to the earlier implementation and its prototype from the Purpose and the Exclusions. No requirement changed. | Project documents describe the-intern as it is specified, not what it replaces. | None |
| 2026-10-30 | Aligned with the rewritten S-000: the single user became equal team members; work is organised as jobs, each with one lead conversation and lead agent, and invoked agents do parts of a job and never close it; `bob` is the default lead role; team members can create, change and remove roles, including instructions and tool sets, and change shipped roles without editing the installed copy; the root conversation and interactive chat are removed; job sources (requests, schedule fires, triggers, follow-ups) replace entry points; schedule entries choose fresh runs or the history of their last runs; a blocked job's lead conversation parks; no approval rules; the worker-thread count is S-000's agent limit and bounds width (Purpose, Definitions, Exclusions, Design Principles, all components, R-1 to R-17, Workflow, Configuration Requirements, Verification, Implementation Order). Consistency review: the coordination capabilities are part of every role and a tool set can't leave them out (R-3, R-5); Installation named as S-000's component; wording in R-13 and live test 1. | Product owner ruling: S-000 is the source of truth, and S-001 is aligned as part of creating S-000. | None; S-001 isn't broken down yet |
