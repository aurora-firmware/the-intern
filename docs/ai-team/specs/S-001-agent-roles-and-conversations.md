---
title: Agent roles and conversations
version: '0.9'
status: approved  # draft | review | approved | superseded
created: '2026-10-15'
author: planner
id: S-001
---

# Agent roles and conversations

## Purpose

This spec covers the **Agents and roles** component of S-000. The-intern runs every conversation in one pi-durable
database, and all of its work is organised as jobs (S-000) that agents carry out in conversations. Before any way in,
schedule or client can be built, it has to be fixed what a conversation is, what the agent working in it is, and how
agents share the work of a job. This spec defines roles that agents are made from, one lead agent per job that can pass
the job's conversation to another role or invoke specialist agents to work on parts of the job in parallel, the
monitoring that shows which role works where, and the front desk, the one standing conversation that assists team
members and turns their requests into jobs. Success Criteria lists the observable outcomes.

## Definitions

### Project terms

| Term | Meaning in this spec |
|---|---|
| the-intern | The product. It runs as a daemon. |
| bob | The name of the default lead role (REQ-001) and of the CLI. |
| Team member | Anyone who can reach one of the-intern's ways in (S-000). All team members are equal: each can give jobs, follow and steer work, and configure the-intern. |
| Role | A set of parameters that an agent is made from: instructions (system prompt), tools and skills, plus default values for the pi-durable agent parameters: model, thinking level and workspace (the pi-durable `cwd`). If a role is a class, an agent is an object of that class. |
| Agent | The actor that interacts with the model and carries out a conversation. A conversation has one agent at a time and can be a succession of agents: each role change ends the current agent and seats a new one in the same conversation. An agent keeps its role for its whole life. It is not an operating-system process: the daemon runs every agent, and the current agent's configuration is the pi-durable agent of its conversation. |
| Seat | The place of the current agent in a conversation, with the role, model, thinking level and workspace it runs with: the role's defaults, or overrides given when the agent was seated or invoked. |
| Job | The product's unit of work (S-000): it has a description, a definition of done, a status, a Blocked reason while blocked, a resolution with its justification, a worklog, a history and Related jobs (S-004), kept in the job record. The job record and the job's steps belong to the Jobs component and its own spec. This spec defines only how agents and conversations work on a job. |
| Lead conversation, lead agent | Each job has one lead conversation. Its current agent is the job's lead agent, which carries the job from definition to verification and is the only agent that completes it (S-004 REQ-005). A handoff in the lead conversation passes the lead to the new agent, so a job has exactly one lead at a time. |
| Specialist agent | An agent invoked for a part of a job. It works in its own conversation, finishes its part and reports back. It never completes the job. |
| Handoff | The current agent passes its conversation to a new agent of another role. Same conversation, same worker thread. |
| Agent invocation | An agent starts one or more agents, each in a new conversation of the same job, with a role and a job prompt for its part. Neither agent owns the other. |
| Context mode | How a new agent's context starts, for a handoff or an invocation: **Full** (the existing context), **Compact** (a compaction of the existing context, guided by a note) or **Clean** (only the note or the job prompt). |
| Steerable, parked | The two ways an invoking agent can carry on. Steerable: it keeps running and can steer the agents it invoked. Parked: its conversation's state is kept, its worker thread is freed, and it continues when a report arrives. |
| Clean-up step | What runs when an agent decides its part is done: report a summary back to the invoking conversation, do nothing, and/or release the worker thread. Chosen programmatically by the type of conversation. |
| Agent run | The model turns an agent takes from picking up an input until its conversation is idle or parked. One agent run uses one worker thread. |
| Model turn | One model request and the tool calls it makes. A seat change applies from the next model turn, so it can take effect during an agent run. |
| Worker thread | A logical unit of capacity: one active agent run uses one. Their number is S-000's limit on how many agents work at once (REQ-010). Whether they are operating-system threads is the daemon spec's choice. |
| Thread | Only in the multi-threading sense. |
| Closed | The final status of a job's conversation once its job is Done (REQ-026). A closed conversation keeps its transcript as the record of the work and takes no input or control; only read operations act on it. The front desk never closes. |
| Reset | Clears what the model sees of a conversation. The conversation, its id and its stored entries stay. |
| Transcript, context | The transcript is every stored entry of a conversation. The context is what the model receives on the next request, after resets and compactions. |
| Workspace | A registered local folder that an agent works in. It supplies extra instructions and skills, and is where tools start. Agents work on the OS and filesystem with the account the-intern runs as; the workspace doesn't limit what they reach. |
| Job source, origin | A job source starts a job and its lead conversation: a request from a team member (command line, web interface, email), a schedule fire, a trigger, or a follow-up job created by an agent. The origin of a conversation records its job source, the invoking conversation for an agent invocation, or "front desk" for the front desk. |
| Front desk | The one standing conversation of an instance that assists team members (REQ-021). It belongs to no job. Team members reach it from the command line and the web interface; it answers questions about the work, creates jobs that agents take, and passes answers and steering to a job's conversations. It never does the work itself. |
| Front-desk tools | The tools offered only in the front desk: job tools that name the job they act on, reads of conversations, status and usage, and steering of a job's conversations (REQ-022). |

### pi agent and pi-durable terms

the-intern runs every conversation on pi-durable. It uses the pi agent (the `pi` coding agent and its SDK) only for
models, login, settings, skills and context files. Where a term exists in both, this spec writes "pi-durable X" or
"pi agent X". A term without a prefix has the project meaning above.

| Term | pi agent | pi-durable | In this spec |
|---|---|---|---|
| Session | One transcript: a JSONL file in pi agent's sessions folder | The whole store: one database with every conversation, task and document | Not used. A transcript is a conversation; the store is "the database". |
| Conversation | No separate term; the pi agent session plays this part | An ordered transcript of entries with its own pi-durable agent | The pi-durable meaning. |
| Agent | The agent loop running in the `pi` process, set up from flags and settings | What a conversation runs with: model, thinking level, extensions, tools, instructions, cwd. Stored in the conversation's `pi.agent` document and resolved before every model request. The harness runs it; no process belongs to it. | The current agent's seat is written into the pi-durable agent of its conversation. |
| Subagent | None built in; extensions provide it | A conversation owned by a task of its caller, aborted with it | Not used. Agent invocation replaces it (Alternatives Considered). |
| Root conversation | None | Conversation 1, created by the host's first `root()` call. Not a parent of other conversations. | Not used by the-intern. Every conversation belongs to a job, except the front desk (REQ-021), which is not a root conversation either. |
| Turn, run | A turn is one assistant message and its tool calls; a prompt runs until the agent ends | A turn is one model response and its tool calls; a run is the turns from an input to its final answer | Model turn and agent run, as defined above. |
| Task | Not a pi agent concept | A durable state machine: generation, tool call, compaction | Only the pi-durable meaning. The work the-intern does is a job. |
| Extension | A module pi agent loads from its agent folder, a trusted project's `.pi/extensions` or a flag | Tools, prompt sections and hooks that the host installs in its registry | Only the-intern's own pi-durable extensions. pi agent extensions are not loaded, neither the account's nor a workspace's, so an agent is offered exactly its role's tools (REQ-005). |
| Skills | Loaded from pi agent's agent folder, `~/.agents/skills` and trusted project folders. The prompt lists name and description, and the model reads the file when needed. | No skill loading of its own | The role's skills plus the workspace skills, listed the same way as in pi agent. The account's own pi agent skills are not loaded. |
| Context files | `AGENTS.md`/`CLAUDE.md` from pi agent's agent folder, the cwd and its parent directories | None; the host supplies prompt sections | Those of the workspace and its parent directories. |
| cwd | The working directory of the `pi` process | The `cwd` of the pi-durable agent | The seat's workspace. |
| New, fork, reset | `/new` starts a new pi agent session file; `/fork` copies one | A reset entry clears the model's context inside the same conversation; creating a conversation starts an empty one; a fork copies entries up to a point | A Clean handoff and a reset stay in the same conversation. Only job sources, agent invocations and the creation of the front desk (REQ-021) create conversations. A Full-context invocation may be built on a pi-durable fork. |
| Compaction | Summarises older messages near the context limit, or on `/compact` | The same, as a pi-durable task, on by default | Automatic compaction is unchanged by this spec, and it is what keeps the front desk's context bounded (REQ-024). The Compact context mode is an extra compaction guided by the agent's note. |
| Steer, follow-up | Messages queued during a run: a steer arrives after the current tool calls, a follow-up after the run ends. Held in memory. | The same, through a durable inbox | The same meanings (REQ-020), and durable. |
| Default model, thinking level | Chosen by pi agent's settings | None; the host passes them | "pi agent's default" (REQ-003) is what the pi agent settings of the account the-intern runs as select. |

## Users and Journeys

| Actor | Goal |
|---|---|
| Team member | Gives jobs, shapes the roles and workspaces agents are made from, follows which role works where, and steers, reseats or resets any conversation. Talks to the front desk to ask for work, ask what is going on, and answer or steer jobs. |
| Front desk agent | Assists team members in the front desk: creates jobs, reports on jobs and conversations, and passes answers and steering on. It does no work itself. |
| Lead agent | Carries its job from definition to verification, doing the work itself, handing the conversation to a better-suited role or invoking specialist agents. |
| Specialist (invoked) agent | Does one part of a job in its own conversation and reports back. It never completes the job. |
| Job sources (downstream systems) | The Jobs component, schedule fires and triggers start a job's lead conversation with a role and an origin. |
| Client specs (downstream systems) | The command line and the web interface build their views on the monitoring read operations. |

Journeys, in priority order:

1. **A job gets its lead.** A job source starts the job's lead conversation with the named role, or `bob`, its first
   input and its origin, and the lead works on it unattended. Delivered by REQ-012, REQ-013, REQ-014.
2. **The lead shares the work.** The lead hands its conversation to another role, or invokes agents that work in
   parallel and report back, steerable or parked, within the depth cap and the worker threads. Delivered by REQ-006,
   REQ-007, REQ-008, REQ-019, REQ-009, REQ-010, REQ-020.
3. **A team member follows and steers.** A team member lists conversations by job, reads transcripts with seat records,
   follows a run live, and steers, reseats or resets any conversation. Delivered by REQ-016, REQ-004, REQ-005, REQ-011,
   REQ-020.
4. **The team shapes roles and workspaces.** A team member creates, changes and removes roles, changes and restores the
   shipped roles, and registers and unregisters workspaces. Delivered by REQ-001, REQ-002, REQ-003, REQ-018.
5. **A blocked job waits without cost.** The lead conversation of a blocked job parks without a worker thread and
   continues when the answer arrives. Delivered by REQ-014, REQ-010.
6. **Nothing is lost on a crash.** Seats, links, parked state and reports survive a kill and restart. Delivered by
   REQ-017.
7. **A team member talks to the front desk.** From the command line or the web interface, a team member asks the
   front desk for work and it creates a job whose lead takes it as usual; asks what is going on and it answers from
   jobs, conversations, status and usage; asks it to pass an answer to a Blocked job or to stop or redirect a job's
   agents; and resets it to start clean, while compaction keeps it within its context. Delivered by REQ-021, REQ-022,
   REQ-023, REQ-024, REQ-025.

## Exclusions

What this specification explicitly does NOT cover:

- **The job record and the job's steps.** What a job records, its statuses, when it counts as blocked, how an answer
  resumes it, how the lead verifies and completes it, follow-up jobs, and export and import belong to the Jobs spec.
  This spec requires only that every conversation knows its job (REQ-012), except the front desk (REQ-021), that the
  lead conversation parks while its job is blocked (REQ-014), and the report-back clean-up step (REQ-019).
- **How a parked agent's continue rule is chosen.** Whether a parked agent continues on each report as it arrives, or
  stays parked until every agent it invoked has reported, and who chooses, is decided later (Open Questions). Both must
  be possible. Until then a parked agent continues on each report (REQ-019).
- **Continuing a closed conversation.** A job's conversations close for good when the job is Done (REQ-026). More
  work is a new job, which a team member or an agent creates and may relate to the first (S-004 REQ-009).
- **Approval rules for actions.** S-000 excludes per-action rules: what an agent can do is bounded by the account
  the-intern runs as and the tools its role is offered.
- **The mailbox, schedules and triggers themselves.** Reading the-intern's own mailbox belongs to the Email spec.
  When schedules and triggers fire, what their store accepts, the run history an entry passes on and when a fire is
  skipped belong to the schedules and triggers spec. This spec defines only the lead conversation each of them starts
  (REQ-013).
- **Command-line views and the job abort operation.** This spec delivers the read operations that monitoring needs
  (REQ-016). The command-line views built on them belong to the command-line spec. It delivers the capability that
  aborts every conversation of a job (REQ-008); the operation that aborts a job belongs to the Jobs spec.
- **Chat beyond the front desk.** There is no root conversation and no chat per team member, per way in or per job.
  An instance has one front desk (REQ-021), with no "new chat": a reset is how a team member starts clean (REQ-024).
  Team members also follow, answer and steer jobs directly through the command line, the web interface and email.
- **Email to the front desk.** Mail doesn't reach the front desk; the Email spec sorts mail into jobs and answers.
- **Work in the front desk.** The front desk invokes no agents, hands off to no role, changes no files and is offered
  no workspace tools (REQ-022). Real work always becomes a job. A team member who reseats the front desk with a role
  whose tool set names more tools makes that choice; the front desk can't make it itself.
- **A job record for the front desk.** The front desk is never on the board, has no definition of done, and the Jobs
  spec's turn-end rule, actions and repair rules don't apply to it (REQ-025).
- **How the front desk is presented.** `bob chat` belongs to the command-line spec, and the web chat to the Web
  interface spec. This spec delivers the conversation and its tools; the clients reach it through the service
  operations.
- **Telling team members apart in the front desk.** There are no logins, so the front desk doesn't know who wrote a
  message; each input records only its way in (REQ-023).
- **Model, thinking level or workspace per schedule entry.** Whether a schedule entry can name values other than its
  role's defaults is deferred (Open Questions). In v1 a fire runs with the named role's defaults.
- **Process and concurrency model.** Whether worker threads are operating-system threads, share one event loop or
  are spread over several processes belongs to the daemon and host-runtime spec. This spec uses worker threads only
  as a logical unit of capacity and states the observable caps (REQ-009, REQ-010).
- **Technology choices.** The control protocol, client transport, storage layout, config file format and process
  model belong to the daemon and control-endpoint specs and to S-000's Installation and service setup. This spec
  states behaviour only.

## Architecture

### Design Principles

- **One agent at a time per conversation.** A conversation can be a succession of agents, but at any moment it has
  exactly one, with one seat. Every model turn runs with that seat's model, thinking level, instructions, tools,
  skills and workspace. Nothing in a turn mixes two seats.
- **One lead per job.** Each job has one lead conversation, and its current agent is the job's only lead. Agents
  invoked for parts of the job work in their own conversations and report back; only the lead completes the job.
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
- **The front desk talks; jobs work.** The front desk assists team members and passes their requests, answers and
  steering on, but every piece of real work becomes a job with its own lead. The front desk owns no job, never waits
  for a job and never makes a job wait for it.
- **Bounded delegation.** Invocation depth and the number of worker threads are capped, so no chain of unattended
  agents can grow without limit. The worker-thread count also bounds how wide delegation can spread.

### Alternatives Considered

- **An overlord across jobs.** A single long-lived coordinator conversation that owns every job, or a `bob` that owns
  the agents it invokes. Rejected: each job has its own lead conversation, and the lead owns its job, not the agents
  it invokes. Invoked agents follow every rule in this spec and are peers in how they work. The front desk
  (REQ-021) isn't such a coordinator: it owns no job, invokes no agents and completes no job.
- **A new conversation per handoff.** Rejected: a handoff never creates a conversation. A clean start inside the same
  conversation is the Clean context mode, and only job sources, agent invocations and the creation of the front desk
  create conversations.
- **pi-durable subagents (task-owned conversations).** Rejected as the product concept: agent invocation replaces
  them, because an invoked agent is a peer that its invoker doesn't own. Whether invocation is built on pi-durable
  task-owned conversations is an implementation choice.
- **Loading pi agent extensions and the account's skills.** Rejected: neither the account's nor a workspace's pi agent
  extensions are loaded, nor the account's own pi agent skills, so an agent is offered exactly its role's tools and
  skills plus the workspace's (REQ-005).

### System Diagram

```
 job sources                        conversations (one database)                 roles (catalog)
┌──────────────────┐   new job   ┌────────────────────────────────────┐  seat   ┌──────────────────┐
│ request (CLI,    ├────────────►│ job A: lead conversation [bob]     │◄────────┤ bob  (default    │
│ web, email)      │             │   ├─ invokes #m      [role: gp]    │         │  lead), gp, desk,│
├──────────────────┤             │   │    └─ invokes …  [role: any]   │         │  team roles      │
│ schedule fire,   │──new job───►│   ├─ steerable or parked           │         │                  │
│ trigger          │             │   └─ handoff / reset: same conv,   │         │ each: instr.,    │
├──────────────────┤             │      next agent, context mode      │         │  tools, skills;  │
│ follow-up job    │──new job───►│ job B: lead conversation [gp]      │         │  default model,  │
│ (from an agent)  │             │ front desk [desk], no job          │         │  thinking,       │
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
| Role catalog | Holds the shipped roles (`bob`, `gp`, `desk`), the team's own roles, their instructions, tools, skills and defaults, and the registered workspaces, each checked when it is registered | Changed by team members through settings operations (REQ-003, REQ-018). Consumes the-intern's settings, its shipped tools and pi agent's default model and thinking level |
| Seating | Seats an agent of a role in a conversation, with optional model, thinking level and workspace overrides, so that later turns use that seat, and records who seated it | The only path that changes a conversation's seat. Consumes the role catalog and the pi-durable agent of each conversation |
| Role prompt | Builds what the model sees: the-intern's preamble, role instructions, role skills, workspace instructions (`AGENTS.md`/`CLAUDE.md`) and workspace skills | Must stay byte-stable while the seat and the role are unchanged (AC-005.4) |
| Agent coordination | Agent-callable handoff, agent invocation and steer capabilities; parking and continuing invoking conversations; the report-back clean-up step; the depth cap and the worker threads | Every role is offered the same coordination capabilities in a job's conversations, and none in the front desk (REQ-022). Consumes seating, conversation reset, compaction and fork, conversation creation, the inbox of the target conversation, and each conversation's own `intern.conversation` document (below) |
| Entry routing | Starts a job's lead conversation for each job source with the role it names (`bob` when it names none) and records its origin; at startup, makes sure the front desk exists and records its conversation id (REQ-021); serves team members' requests to reset conversations | Holds no channel knowledge beyond choosing the role and recording the origin. Called by the Jobs component when a job is created, and by startup for the front desk |
| Front-desk tools | The tools offered only in the front desk: the job tools that name a job, the state reads and the steering of a job's conversations (REQ-022) | Calls the job operations (S-004) and the same paths as `conversations.submit` and `conversations.abort`, recording the jobs and the input it passes on as from the front desk (REQ-023) |
| Monitoring | Lists conversations with their job, lead flag, front-desk mark, seats, origins, status, invocation links and live transcripts | Read-only. Abort, reset and steer go through other components |

**The conversation's own document.** Each conversation's `intern.conversation` document holds the conversation's
parked state, the messages held for it while it is parked, the invoked conversations whose reports it awaits, its
abort mark, which records that its invoker is owed an "aborted" report (REQ-019), and its closed mark (REQ-026). They
are facts the-intern owns, written in the commit that changes them, and the only recovery from them is redelivery
(ADR-001 decision 4). An abort's facts are written in one commit just before pi-durable's abort; when a job's abort
closes the conversation, the closed mark is written in that same commit. The document is internal to the daemon, not
an external contract.

## Interfaces

This spec's external contracts are the agent tools the model is offered, the service operations it contributes to the
S-002 catalogue, and the transcript entries clients read. The service-layer conventions (callers, actors, error
outcomes, idempotency keys) are S-002's (S-002 REQ-012, REQ-013).

### Exposed: agent tools

Every seat in a job's conversation is offered these three coordination tools and the job tools (S-004 REQ-013),
whatever its role's tool set names (REQ-003, REQ-005). A seat in the front desk is offered none of them, and the
front-desk tools instead (REQ-022).
**Contract** (tool names and parameters as the model sees them):

| Tool | Parameters | Result |
|---|---|---|
| `handoff` | `role`; optional `model`, `thinkingLevel`, `workspace`; `contextMode` (`full`, `compact`, `clean`); `note` (required for `compact` and `clean`) | The handing-off agent's work ends; an error result leaves the seat unchanged (REQ-006) |
| `invoke` | `agents`: one or more of { `role`; optional `model`, `thinkingLevel`, `workspace`; `contextMode`; `jobPrompt` }; `then` (`steerable`, `parked`) | The invoked conversation ids when steerable; the run ends when parked; an error result for a refused invocation, and the run continues (REQ-008, REQ-009) |
| `steer` | `conversationId`; `message`; `mode` (`steer`, `followUp`) | The message is injected or queued; an error result for an unknown conversation (REQ-020) |

The tools the-intern ships for a role's tool set are `read`, `write`, `edit` and `bash`; a tool set naming anything
else is refused (REQ-003).

The front-desk tools (REQ-022), offered only in the front desk:

| Group | Tools | Does |
|---|---|---|
| Jobs | `read_job`, `list_jobs`, `create_job`, `update_job`, `add_worklog`, `relate_jobs` | The job tools of S-004, each naming the job it acts on, and `list_jobs` with a status and origin-letter filter (S-004 REQ-021) |
| State | read a conversation's status, entries and invocations; read the daemon status; read usage | The same answers as `conversations.get`, `conversations.entries`, `conversations.invocations`, `daemon.status` and `usage.get` |
| Steering | send input to a job's conversation; stop a job's conversation | The same paths as `conversations.submit` and `conversations.abort`; the input is recorded as from the front desk (REQ-023) |

The names of the state and steering tools and the parameter layouts of all of them are not contract; the tasks fix
them.

### Exposed: service operations

These operations of the S-002 catalogue carry this spec's behaviour (S-002 REQ-012 lists the whole catalogue):

| Operation | Kind | Requirement |
|---|---|---|
| `conversations.seat` | control | Change a conversation's seat, optionally with a reset and a note (REQ-004, REQ-011) |
| `conversations.reset` | control | Reset a conversation and keep its seat (REQ-011) |
| `conversations.abort` | control | Abort a conversation and the invoked conversations it awaits (REQ-008) |
| `conversations.submit` | control | Steer or queue input, including to a parked conversation (REQ-020) |
| `roles.list`, `roles.create`, `roles.change`, `roles.restore`, `roles.remove` | read, control | Role settings (REQ-003) |
| `workspaces.list`, `workspaces.register`, `workspaces.unregister` | read, control | Workspace registration (REQ-018) |
| `conversations.list`, `conversations.get`, `conversations.invocations`, `conversations.entries`, `feed.subscribe` | read | Monitoring (REQ-016); `conversations.list` marks the front desk (REQ-021) |
| `desk.get` | read | The front desk's conversation id and seat (REQ-021) |

Two capabilities are offered in-process only, for S-004: `jobs.startLead`, which starts a job's lead conversation
with a role, optional overrides, a first input and an origin and is called by `jobs.create` (REQ-012); and the
capability that aborts and closes every conversation of a job, for S-004's complete and cancel actions and its repair
rule 4 (REQ-008, REQ-026).

### Exposed: transcript entries

Clients read these entry kinds through `conversations.entries` and the conversation feed (REQ-016):

- **`intern.seat`**, the seat record: previous and new seat, actor, and for a handoff the context mode and note
  (REQ-007).
- **`intern.report`**, a report from an invoked agent: the invoked conversation, its role and the text (REQ-019;
  ADR-004).
- **`intern.steer`**, a steer or held message: its sender, mode and text (REQ-020; ADR-004). Input the front desk
  sends to a job's conversation names the front desk as its sender (REQ-023).

Each assistant entry is returned with the seat that produced it (REQ-007).

### Consumed

- The configuration file's `[roles.<name>]` and `[workspaces]` tables, through S-002's configuration component (S-002
  REQ-021, REQ-022). The keys are documented in the user manual (`docs/manual/roles_and_agents.md`).
- The pi agent login, model registry and default model and thinking level of the account the-intern runs as (S-002
  REQ-018).
- A workspace's `AGENTS.md`/`CLAUDE.md` files, from the workspace and its parent directories, and its skills.
- Admission and worker threads from S-002 (S-002 REQ-010).

## Workflow

A job, from its source to delegated work:

```
Job source: request, schedule fire, trigger or follow-up (role named, default bob)          REQ-012, REQ-013
  ↓
Schedule fire skipped or refused? → the schedules and triggers spec; stop
  ↓
Unknown role or unresolvable override? → refused, nothing created                           REQ-012
  ↓
Jobs creates the job → entry routing starts its lead conversation, origin = job source      REQ-012
  ↓
Waits for a worker thread if all are busy (arrival order)                                   REQ-010
  ↓
The lead agent defines the job (Jobs spec)
  ↓
Information missing? → job blocked, lead conversation parked (no worker thread)             REQ-014
                       → answer arrives → continues on a free worker thread
  ↓
Either: does the work itself
    or: hands off (full / compact / clean) to another role                                  REQ-006, REQ-007
          → the new agent leads, on the same worker thread
          (unknown role, unregistered workspace or bad override → error result, seat unchanged)
    or: invokes agent(s) (full / compact / clean context)                                   REQ-008
          → they run in parallel on their own worker threads
          (beyond the depth cap, or a parked invoke sharing its turn → refused, run goes on)  REQ-009, REQ-008
          ├─ steerable: keeps running, may steer them                                       REQ-020
          └─ parked:    frees its worker thread
        each invoked agent finishes its part → report-back                                  REQ-019
          → report arrives as new input; a parked agent continues on a free worker thread
        an invoked conversation aborted on its own → "aborted" report;
        a cascading abort → no report, nothing left parked or awaiting                      REQ-008, REQ-019
  ↓
At any time: a team member reseats, resets or steers any conversation                       REQ-004, REQ-011, REQ-020
A seat's workspace folder disappears → tool errors, the daemon keeps running                REQ-015
  ↓
The lead verifies against the definition of done and completes the job, or anyone cancels it (Jobs spec)
  ↓
Job Done → every conversation of the job is aborted and closed: read only, for good          REQ-026
  (input, abort, reset, reseat or compaction of a closed conversation → refused conflict)    REQ-026
```

The front desk, from startup to a team member's request:

```
Startup: entry routing makes sure the front desk exists                                    REQ-021
  (missing → created seated as desk, no job, origin "front desk", id recorded)              REQ-021, REQ-023
  (crash during the creation → the next start finds or creates exactly one)                 REQ-021
  ↓
A team member writes from the command line or the web interface (way in C or W)            REQ-021, REQ-023
  ↓
Waits for a worker thread if all are busy, like any input                                   REQ-010, REQ-021
  ↓
The desk agent answers with the front-desk tools only                                       REQ-022
    ├─ asks for work → creates a job (way in's letter, front-desk origin detail);
    │                  the job's lead takes it as usual                                     REQ-022; S-004 REQ-021
    ├─ asks what is going on → reads jobs, conversations, status and usage                  REQ-022
    └─ answers or steers → input from the front desk to a job's conversation, or a stop     REQ-022, REQ-023
          (a Blocked job's lead resumes on the input)                                       REQ-020; S-004 REQ-006
  ↓
Context fills → pi-durable compacts it; a team member resets it → same id, clean context     REQ-024
A job-only operation given the front desk → refused "not a job conversation"                 REQ-025
The front desk never closes; steering a closed job conversation → error result               REQ-026
```

## Behavioral Requirements

Requirement identifiers before v0.5 were `R-n`. The number is kept, so `R-4` is now `REQ-004`, except for the three
suffixed identifiers:

| Before v0.5 | Now |
|---|---|
| R-1 to R-17 | REQ-001 to REQ-017 |
| R-3a | REQ-018 |
| R-8a | REQ-019 |
| R-10a | REQ-020 |

Requirements appear in reading order, so REQ-018 to REQ-020 follow the requirement they used to extend, REQ-021 to
REQ-025, the front desk, follow monitoring, and REQ-026, closed conversations, follows them. REQ-017 is under Quality
Requirements. The deterministic tests run on the fake model (S-002 Definitions), whose replies are a pure function of
the transcript.

### REQ-001 — Shipped roles

The-intern SHALL ship three roles, `bob`, `gp` and `desk`, and `bob` SHALL be the default lead role. `desk` is the
role the front desk is created with (REQ-021). Every role, shipped or created by a team member, MUST have a name,
instructions, a tool set (possibly empty), a skill set (possibly empty), a default model, a default thinking level and
a default workspace.

#### AC-001.1 — The shipped roles are bob, gp and desk

- **Given:** a daemon with no configuration file
- **When:** the roles are listed
- **Then:** exactly `bob`, `gp` and `desk` are listed, each valid with non-empty instructions, and `bob` is the
  default lead

**Verification:** test — `test/unit/shipped_roles.test.ts`, `test/service/agents_startup.test.ts`,
`test/service/role_operations.test.ts` ("lists the shipped roles bob and gp through roles.list").

### REQ-002 — What the shipped roles are for

The shipped roles' instructions MUST satisfy these descriptions:

- **`bob`** leads jobs. Its instructions direct the agent to define the job (goal, needs, plan and definition of
  done), ask for what is missing, then do the work itself, hand it to a better-suited role or invoke other agents
  for parts of it, and finally verify the result against the definition of done.
- **`gp`** is a general-purpose executor. Its instructions and shipped skills describe how to carry out a part of a
  job to completion and report back.
- Both roles are offered the coordination capabilities (REQ-006 to REQ-008, REQ-019).
- **`desk`** assists team members in the front desk. Its instructions direct the agent to answer questions about the
  work from jobs, conversations, status and usage, to turn every request for real work into a job instead of doing
  it, to report the new job's short number, and to pass answers and steering to a job's conversations when a team
  member asks. Its tool set names none of the tools the-intern ships, so in the front desk it is offered only the
  front-desk tools (REQ-022).

The shipped text of the instructions, the tool lists and `gp`'s skill content are set during implementation and may
change in later versions without amending this spec.

#### AC-002.1 — The shipped instructions match the descriptions

- **Given:** the shipped `bob`, `gp` and `desk` instruction files and `gp`'s skill
- **When:** a reviewer reads them against this requirement
- **Then:** `bob`'s text covers defining, asking, doing, delegating and verifying; `gp`'s text and skill cover
  carrying out a part to completion and reporting back; and `desk`'s text covers answering about the work, turning
  requests for work into jobs with their number, and passing answers and steering on

**Verification:** inspection — the shipped role files under `src/roles/shipped/`; `test/unit/shipped_roles.test.ts` checks
that `gp` has its skill folder, `bob` none and `desk` none, and that `desk`'s tool set is empty.

### REQ-003 — Role settings

The-intern SHALL let a team member, in its configuration or while the daemon runs (S-002 REQ-022):

- **create** a role with a name, instructions, a tool set chosen from the tools the-intern ships, skills, and
  optionally a default model, thinking level and workspace
- **change** any role's instructions, tool set, skills, default model, thinking level and workspace, including the
  shipped roles'. A change to a shipped role is kept in the-intern's settings and never edits the installed copy, and
  it can be undone to restore the shipped role.
- **remove** a role the team created. Removing a shipped role, `desk` included, is refused. Removing a role that a
  schedule entry or trigger names is refused, with an error naming them.
- **register and unregister** workspaces (REQ-018)

Defaults and changes MUST follow these rules:

- A role without a configured default model uses pi agent's default model, and one without a configured default
  thinking level uses pi agent's default thinking level.
- A role without a configured default workspace uses a default workspace that the-intern creates and registers for
  that role, owner-only, under the-intern's own data location.
- A tool set can name only tools the-intern ships. A change naming an unknown tool is refused.
- The coordination capabilities (REQ-006 to REQ-008, REQ-019, REQ-020) and the job tools (S-004 REQ-013) are part of
  every role in a job's conversations. A tool set can't leave them out. In the front desk they are replaced by the
  front-desk tools, whatever the role (REQ-022).
- A change to a role, or its removal, affects only agents seated after the change. Agents already seated keep
  their instructions, tools, skills, model, thinking level and workspace until their seat changes.

#### AC-003.1 — Create, change and remove a team role

- **Given:** a running daemon
- **When:** a team member creates a role, changes it and removes it
- **Then:** each change is written to the configuration file, listed at once and kept after a restart

**Verification:** test — `test/unit/role_catalog.test.ts`, `test/service/role_operations.test.ts`.

#### AC-003.2 — Change a shipped role and restore it

- **Given:** the shipped role `bob`
- **When:** a team member changes it, then restores it
- **Then:** the changed values are listed, the installed copy is untouched, and after the restore the shipped values
  are listed and the change is gone from the file

**Verification:** test — `test/unit/role_catalog.test.ts`, `test/service/role_operations.test.ts`.

#### AC-003.3 — Removals that are refused

- **Given:** a shipped role, and a team role that a schedule entry or trigger names
- **When:** a team member removes either
- **Then:** the removal is refused, the file is unchanged, and the refusal of the referenced role names the referrers

**Verification:** test — `test/unit/role_catalog.test.ts`, `test/service/role_operations.test.ts`.

#### AC-003.4 — An unknown tool is refused

- **Given:** a role definition whose tool set names a tool the-intern doesn't ship
- **When:** it is created or changed
- **Then:** the change is refused with an error naming the role, the field and the value, and nothing changes

**Verification:** test — `test/unit/role_catalog.test.ts`, `test/unit/role_model.test.ts`,
`test/service/role_operations.test.ts`.

#### AC-003.5 — Defaults

- **Given:** a role without a default model, thinking level or workspace
- **When:** an agent of it is seated
- **Then:** it runs with pi agent's default model and thinking level and with the role's own default workspace, which
  the-intern created owner-only

**Verification:** test — `test/unit/role_catalog.test.ts` ("seats a role without defaults on pi agent", "gives a
created role without a workspace its per-role default workspace"), `test/service/agents_startup.test.ts`.

#### AC-003.6 — The coordination capabilities can't be left out

- **Given:** a role whose tool set lists none of `handoff`, `invoke` and `steer`
- **When:** an agent of it is seated in a job's conversation
- **Then:** the agent is offered all three coordination tools

**Verification:** test — `test/service/steer.test.ts` ("offers steer, handoff and invoke to an agent of a role that
lists none of them"), `test/unit/role_model.test.ts`.

#### AC-003.7 — Seated agents keep their role

- **Given:** an agent seated in a conversation
- **When:** a team member changes or removes its role
- **Then:** the agent keeps the instructions, tools, skills, model, thinking level and workspace it was seated with

**Verification:** test — `test/unit/role_catalog.test.ts` ("leaves a seat already resolved unchanged by a later role
change"), `test/service/role_prompt_extension.test.ts`.

### REQ-018 — Workspace registration

A folder MUST be usable as a workspace only after a team member registers it. A workspace is a local folder: the
files an agent works on, extra instructions (`AGENTS.md`), workspace skills and scratch space.

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

#### AC-018.1 — Registration accepts a valid folder and refuses invalid ones

- **Given:** a valid owner-only folder, and a relative, missing, non-directory, and group- or world-accessible path
- **When:** each is registered
- **Then:** the valid folder is registered and usable at once; each other one is refused naming the path and the
  reason, and the file is unchanged

**Verification:** test — `test/unit/workspace_folder.test.ts`, `test/unit/workspace_registry.test.ts`,
`test/service/workspace_operations.test.ts`.

#### AC-018.2 — A failing registration at startup stops the daemon

- **Given:** a configuration file whose registered workspace fails the check, or a role naming an unregistered
  workspace
- **When:** the daemon starts
- **Then:** startup stops at step 6 naming the path and the reason or the role

**Verification:** test — `test/service/agents_startup.test.ts`.

#### AC-018.3 — Unregistering is refused for default workspaces

- **Given:** a workspace that is a role's default workspace, and a per-role default workspace the-intern created
- **When:** a team member unregisters either
- **Then:** the first is refused naming the role, the second is refused naming the reason, and the file is unchanged

**Verification:** test — `test/unit/workspace_registry.test.ts`, `test/service/workspace_operations.test.ts`.

#### AC-018.4 — After unregistering

- **Given:** an agent seated in a registered workspace
- **When:** the workspace is unregistered
- **Then:** the seated agent keeps running its tools there, the unregistration survives a restart, and a new seat
  naming the workspace is refused with the seat unchanged

**Verification:** test — `test/service/seat_operations.test.ts` ("keeps running the tools of a conversation in a
workspace that is then unregistered until its seat changes"), `test/service/workspace_operations.test.ts`.

### REQ-004 — Role change by a team member

The-intern SHALL let a team member change the seat of any conversation at any time.

- The new seat names a role, and may name a model, a thinking level and a registered workspace other than that
  role's defaults. A new agent of that role is seated, with the Full context mode.
- The change applies from the next model turn. A model turn already running finishes with the seat it started
  with, unless the team member also aborts or steers it.
- Changing the seat of a job's lead conversation changes the job's lead agent.
- A closed conversation can't be reseated (REQ-026).

#### AC-004.1 — The next turn runs with the new seat

- **Given:** a conversation seated as `bob`
- **When:** a team member seats `gp`, with or without a model, thinking level and workspace override
- **Then:** the next turn runs as `gp` with the named values, and a turn already running finishes with the old seat

**Verification:** test — `test/service/seat_operations.test.ts`, `test/service/seating.test.ts` ("lets a running
model turn finish with the old seat and runs the next turn with the new one").

#### AC-004.2 — Invalid seat changes are refused

- **Given:** a conversation
- **When:** a seat change names an unknown role, model, thinking level, workspace or conversation
- **Then:** it is refused and the seat is unchanged

**Verification:** test — `test/service/seat_operations.test.ts`.

#### AC-004.3 — Reseating a lead conversation changes the job's lead

- **Given:** a job's lead conversation seated as `bob`
- **When:** a team member seats `gp`
- **Then:** the conversation stays the job's lead conversation, and its agent, now `gp`, is the job's lead

**Verification:** test — `test/service/seat_operations.test.ts` ("keeps the lead conversation the job").

### REQ-005 — Seat effects

After a seat is applied, every model turn in that conversation MUST:

- use the seat's model and thinking level
- see the role's instructions and skills
- be offered exactly the role's tools, the coordination capabilities and the job tools (S-004 REQ-013) in a job's
  conversation, or exactly the role's tools and the front-desk tools in the front desk (REQ-022)
- run its tools in the seat's workspace
- see that workspace's instructions and skills

Nothing of the previous seat's instructions, skills or workspace stays in the system prompt. The transcript stays
visible to the new agent unless a Clean handoff or a reset (REQ-011) cleared the context.

#### AC-005.1 — The prompt carries the new seat only

- **Given:** a conversation seated as one role in one workspace
- **When:** it is reseated as another role in another workspace
- **Then:** the next system prompt holds the new role's instructions and skills and the new workspace's context files
  and skills, and nothing of the previous seat

**Verification:** test — `test/service/role_prompt_extension.test.ts`, `test/unit/role_prompt.test.ts`,
`test/unit/workspace_context.test.ts`.

#### AC-005.2 — Exactly the role's tools are offered

- **Given:** a role whose tool set is `read` plus the coordination tools
- **When:** an agent of it takes a turn
- **Then:** the model is offered `read`, the coordination tools and the job tools (S-004 REQ-013), and none of
  `write`, `edit` and `bash`; nothing is loaded from the pi agent folder

**Verification:** test — `test/service/shipped_tools.test.ts`, `test/unit/workspace_context.test.ts` ("returns no
context file or skill from the pi agent folder").

#### AC-005.3 — Tools run in the seat's workspace

- **Given:** a conversation seated in a workspace
- **When:** the agent calls `bash`
- **Then:** the command runs in that workspace

**Verification:** test — `test/service/shipped_tools.test.ts` ("runs bash in the workspace the conversation is seated
in").

#### AC-005.4 — The prompt is byte-stable

- **Given:** a conversation whose seat and role don't change
- **When:** it takes two consecutive turns
- **Then:** both turns send byte-identical system prompt sections

**Verification:** test — `test/service/role_prompt_extension.test.ts` ("sends the same system prompt on two
consecutive turns while the seat is unchanged"), `test/unit/role_prompt.test.ts`.

### REQ-006 — Handoff by an agent

The current agent SHALL be able to hand its conversation to a new agent of another role, and its own work ends there.
A handoff happens because a team member or another agent asked for it in a prompt, or because the agent decides to. No
human confirms it. A handoff in a job's lead conversation passes the lead to the new agent.

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

#### AC-006.1 — Full handoff

- **Given:** an agent in a conversation
- **When:** it hands off to another role with the Full context mode
- **Then:** the next turn runs in the same conversation with the new seat, the full context and no new input

**Verification:** test — `test/service/handoff.test.ts`.

#### AC-006.2 — Compact handoff

- **Given:** an agent in a conversation
- **When:** it hands off with the Compact context mode and a note
- **Then:** the context is compacted guided by the note before the new seat continues

**Verification:** test — `test/service/handoff.test.ts`.

#### AC-006.3 — Clean handoff

- **Given:** an agent in a conversation with earlier entries
- **When:** it hands off with the Clean context mode and a note
- **Then:** the model's context holds only the note, the stored transcript keeps every earlier entry, and the new
  agent runs on the same worker thread

**Verification:** test — `test/service/handoff.test.ts`.

#### AC-006.4 — A refused handoff leaves the seat unchanged

- **Given:** an agent in a conversation
- **When:** it hands off naming an unknown role, an unregistered workspace, an unresolvable override, or no note for
  Compact or Clean
- **Then:** it gets an error result and the seat is unchanged

**Verification:** test — `test/service/handoff.test.ts`.

### REQ-007 — Seat records

Every seat change MUST show in the transcript. The record names:

- the previous seat and the new seat (role, model, thinking level, workspace)
- the actor: a team member (with the way in they used), the agent that handed off (with its role), a job source, or
  the daemon, for input it sends under a job's rules (S-004 REQ-008) and for the front desk's first seat (REQ-021)
- for a handoff, the context mode, and the handoff note when there is one

Every assistant message MUST be attributed to the seat that produced it.

#### AC-007.1 — The seat record

- **Given:** a conversation
- **When:** its seat changes by a team member, a handoff or a job source, or the daemon creates the front desk
- **Then:** an `intern.seat` record names the previous and new seat, the actor (the team member's way in, or
  in-process when none is named; the agent's role; the job source; or the daemon for the front desk), and for a
  handoff the context mode and note

**Verification:** test — `test/service/seating.test.ts`, `test/service/seat_operations.test.ts` ("records the agent
with the role its own conversation is seated in", "seatActorFor").

#### AC-007.2 — Attribution

- **Given:** a transcript with several seat records and a reset
- **When:** it is read
- **Then:** each assistant entry carries the seat of the latest seat record before it, across pages and resets

**Verification:** test — `test/unit/attribution.test.ts`, `test/service/conversation_read_operations.test.ts`.

### REQ-008 — Agent invocation

Any agent SHALL be able to invoke one or more agents for parts of its job. Each invoked agent gets a new conversation
of the same job, a role, optionally a model, a thinking level and a registered workspace other than the role's
defaults, and a job prompt for its part.

- The invoking agent chooses a context mode for each invoked conversation: **Full** (a copy of the invoking
  conversation's context, then the job prompt), **Compact** (a compaction of that context guided by the job prompt,
  then the job prompt) or **Clean** (only the job prompt).
- Invoked agents follow every rule in this spec, so they can hand off and invoke agents of their own. They run in
  parallel, each on its own worker thread. An invoked agent finishes its part and reports; it never completes the job.
- The invoking agent then chooses how it carries on:
  1. **Steerable.** It keeps running on its worker thread and can steer the agents it invoked (REQ-020).
  2. **Parked.** Its conversation is parked: pi-durable keeps the state of the conversation and its agent, and the
     worker thread is freed. A parked agent can't steer. It continues as REQ-019 describes.
- An invocation that parks must be the only tool call of its model turn. One that shares its model turn with other
  tool calls is refused like an invocation past the depth cap (REQ-009): the invoking agent gets an error result that
  says why, no conversation is created, and its run continues.
- Aborting a conversation also aborts the invoked conversations whose report it is still waiting for, whether it
  is steerable or parked. Each of those aborts the conversations it waits for in turn. Aborting a job aborts every
  conversation of the job and closes them (REQ-026); the operation that does it belongs to the Jobs spec, and this
  spec delivers the capability it calls. A closed conversation can't be aborted (REQ-026).
- An abort leaves no aborted conversation parked or waiting for a report. Its held messages (REQ-020) are withdrawn,
  as an abort withdraws queued input. Whether its invoking conversation gets a report follows REQ-019.

#### AC-008.1 — Each context mode

- **Given:** an invoking conversation with a context
- **When:** it invokes agents with the Full, Compact and Clean context modes
- **Then:** the Full context is a copy of the invoking context then the job prompt, the Compact context is a
  compaction of it then the job prompt, and the Clean context is only the job prompt

**Verification:** test — `test/service/invocation.test.ts`.

#### AC-008.2 — Invoked agents run in parallel in the same job

- **Given:** an agent
- **When:** it invokes two agents
- **Then:** two seated conversations of the same job are created and run in parallel, each linked to the invoker

**Verification:** test — `test/service/invoke.test.ts`, `test/service/invocation.test.ts`.

#### AC-008.3 — Steerable and parked

- **Given:** an agent invoking agents
- **When:** it chooses steerable, or parked
- **Then:** steerable returns the invoked conversation ids and the run continues and can steer them; parked ends the
  run, parks the conversation and frees its worker thread

**Verification:** test — `test/service/invoke.test.ts`, `test/service/steer.test.ts`.

#### AC-008.4 — A parked invocation sharing its model turn is refused

- **Given:** a model turn with a parked `invoke` and another tool call
- **When:** the turn runs
- **Then:** the invocation gets an error result saying why, no conversation is created, and the run continues

**Verification:** test — `test/service/invoke.test.ts` ("refuses a parked invoke that shares its model turn").

#### AC-008.5 — Aborts cascade to awaited conversations

- **Given:** a steerable or parked conversation awaiting invoked conversations, which await their own
- **When:** it is aborted
- **Then:** every awaited conversation is aborted in turn, and one that has already reported is untouched

**Verification:** test — `test/service/abort_cascade.test.ts`.

#### AC-008.6 — Aborting a job's conversations

- **Given:** two jobs with several conversations each
- **When:** the job abort capability runs for one job
- **Then:** every conversation of that job is aborted and closed, and none of the other job

**Verification:** test — `test/service/abort_cascade.test.ts` ("abortJobConversations").

#### AC-008.7 — An abort leaves nothing parked or awaiting

- **Given:** a steerable or a parked invoker with report delivery running
- **When:** it is aborted, or its job's conversations are
- **Then:** no aborted conversation is parked, awaiting a report or holding messages

**Verification:** test — `test/service/abort_cascade.test.ts` ("an abort with report delivery running").

### REQ-019 — Clean-up step and reports

When an invoked agent decides its part is done, the report-back clean-up step SHALL run:

- An invoked agent's part is done when its agent run ends while its conversation is not parked and waits for no
  report from a conversation it invoked. A run that ends while either holds doesn't end the part; the report goes
  back when a later run ends that way.
- The invoked agent's summary, its last answer, is delivered into the invoking conversation as a new input the
  moment the invoked agent finishes.
- If the invoking conversation is running, the report arrives like a follow-up (REQ-020). If it is idle or parked, the
  conversation becomes ready, takes a free worker thread and continues with the report.
- The transcript records which invoked agent sent each report: the report is placed as an `intern.report` entry
  whose data names the invoked conversation and its role and carries the text (ADR-004).
- A parked conversation continues either on each report as it arrives or only when every agent it invoked has
  reported. Both behaviours must be possible. How the choice is made is decided later. Until then the continue rule
  is "continue on each report" (product owner ruling, 2026-10-31).
- When an invoked conversation is aborted on its own, not by an abort that cascades from its invoking conversation,
  the invoking conversation gets a report that says the invoked conversation was aborted, with the invoked agent's
  last answer when there is one. A parked invoking conversation then continues under its continue rule. An abort
  that cascades from the invoking conversation (REQ-008), or that aborts the whole job, delivers no report.

When the lead agent decides the job is done, completing the job follows the Jobs spec.

#### AC-019.1 — A report arrives as new input

- **Given:** an invoking conversation that is running, idle or parked
- **When:** an invoked agent finishes its part
- **Then:** its last answer arrives as a follow-up in the running one, and makes the idle or parked one run on it

**Verification:** test — `test/service/reports.test.ts`.

#### AC-019.2 — The report entry names its sender

- **Given:** a report delivered to a running, an idle or a parked invoker
- **When:** the transcript is read
- **Then:** the report is an `intern.report` entry naming the invoked conversation and its role, and several reports
  each name their own agent, in arrival order

**Verification:** test — `test/service/reports.test.ts` ("report entries").

#### AC-019.3 — Both continue rules

- **Given:** a parked invoker awaiting two reports
- **When:** the reports arrive
- **Then:** under "continue on each" it runs on each report; under "after every report" it runs only after the last

**Verification:** test — `test/service/reports.test.ts`.

#### AC-019.4 — A nested agent reports only when its part is done

- **Given:** an invoked agent that parks on, or steerably awaits, agents of its own
- **When:** its runs end while it still awaits a report
- **Then:** it reports only after its run on the last awaited report ends

**Verification:** test — `test/service/reports.test.ts`.

#### AC-019.5 — The "aborted" report

- **Given:** an invoked conversation, running, idle or parked
- **When:** it is aborted on its own
- **Then:** its invoker gets one report saying it was aborted, with its last answer when there is one, and a parked
  invoker continues; an invoked conversation aborted by the cascade from its invoker reports nothing

**Verification:** test — `test/service/abort_cascade.test.ts` ("a lone abort of an invoked conversation with report
delivery running").

### REQ-009 — Depth cap

Agent invocations MUST chain only to a maximum depth. A job's lead conversation has depth 0, and an invoked
conversation has the invoking conversation's depth plus one.

- An invocation that would exceed the cap is refused. The invoking agent gets an error result that names the cap,
  and its run continues.
- Handoffs, role changes by a team member and resets don't change depth.

#### AC-009.1 — An invocation past the cap is refused

- **Given:** an agent in a conversation at the depth cap
- **When:** it invokes an agent
- **Then:** it gets an error result naming the cap, nothing is created, and its run continues

**Verification:** test — `test/service/invoke.test.ts`, `test/service/invocation.test.ts`.

#### AC-009.2 — Seat changes keep the depth

- **Given:** an invoked conversation with a depth
- **When:** it is reseated with a reset
- **Then:** its depth and job links are unchanged

**Verification:** test — `test/service/seat_operations.test.ts` ("keeps the depth and the job links of the
conversation").

### REQ-010 — Worker threads

At most a fixed number of agent runs SHALL be active at the same time, one per worker thread, counted across every job
and every conversation. This is S-000's limit on how many agents work at once, and it also bounds how wide invocations
spread.

- Work beyond the cap waits in arrival order and starts when a worker thread frees. It is not dropped.
- A parked or idle conversation holds no worker thread, so the cap can never deadlock an invoking agent against
  the agents it waits for, and a blocked job never counts against it.
- A parked conversation that a report or an answer makes ready waits for a worker thread like any other work.
- Monitoring shows waiting work as "waiting for a worker thread".

#### AC-010.1 — A parked agent frees its worker thread

- **Given:** one worker thread
- **When:** an agent invokes an agent and parks
- **Then:** the invoked agent runs, and the parked agent then continues

**Verification:** test — `test/service/agents_capacity.test.ts` ("runs a parked agent").

#### AC-010.2 — Waiting work starts in arrival order

- **Given:** every worker thread busy
- **When:** more work arrives
- **Then:** it is reported as waiting for a worker thread and starts in arrival order as threads free

**Verification:** test — `test/service/agents_capacity.test.ts`, `test/service/admission.test.ts`.

### REQ-020 — Steering

The-intern SHALL let a team member, and any agent, steer a running conversation by injecting a message that the
running model turn picks up after its current tool round. The message can be queued as a follow-up instead.

- An agent steers through a coordination capability that names the target conversation. No agent can steer the
  front desk: only a team member's input, submitted through `conversations.submit` with the way in `command line` or
  `web interface`, reaches it. The `steer` tool aimed at the front desk returns an error result and the run goes on,
  and a submit to the front desk with any other way in is refused `invalid_input`; neither delivers anything.
- A message sent to a conversation parked for reports waits until it continues, whatever its busy mode: a message
  sent with the mode that refuses input while a run is active (reject, S-002 REQ-012) is held like any other message,
  not refused, and the conversation takes it as a follow-up when it continues. A message sent to a job's lead
  conversation parked because its job is Blocked continues it with that message (REQ-014; S-004 REQ-006).
- A closed conversation takes no message (REQ-026): a submit to it is refused `conflict`, and the `steer` tool or
  the front-desk steering tool aimed at it returns an error result and the run goes on; neither delivers anything.
- The transcript records who steered.

#### AC-020.1 — Steer and follow-up

- **Given:** a running conversation
- **When:** an agent steers it, or queues a follow-up
- **Then:** the steer is delivered after the current tool round and the follow-up only after the run ends, each
  recorded with the agent that sent it

**Verification:** test — `test/service/steer.test.ts`.

#### AC-020.2 — Steering by a team member

- **Given:** an idle conversation
- **When:** a team member steers it
- **Then:** the message is recorded with the team member and their way in

**Verification:** test — `test/service/steer.test.ts`.

#### AC-020.3 — An unknown target

- **Given:** a running agent
- **When:** it steers a conversation that doesn't exist
- **Then:** it gets an error result and its run continues

**Verification:** test — `test/service/steer.test.ts`.

#### AC-020.4 — Messages to a parked conversation are held

- **Given:** a conversation parked for reports
- **When:** a team member and an agent send it messages, in each busy mode including reject, and one request twice
- **Then:** each message is held once without a run and delivered as its own `intern.steer` entry with its sender when
  the conversation continues

**Verification:** test — `test/service/steer.test.ts` ("a parked conversation").

#### AC-020.5 — No agent steers the front desk

- **Given:** the front desk and a running agent in a job's conversation
- **When:** the agent calls `steer` naming the front desk, and an input is submitted to the front desk in-process with
  no way in named
- **Then:** the `steer` call returns an error result and the agent's run goes on, the submit is refused
  `invalid_input`, and the front desk's transcript gains no entry

**Verification:** test — a service test on the fake model.

### REQ-011 — Reset by a team member

The-intern SHALL let a team member reset any conversation: its context is cleared for the model, earlier entries stay
in the stored transcript, and the seat is kept unless the reset names a new one. A closed conversation can't be reset
(REQ-026).

#### AC-011.1 — Reset keeps the seat and the entries

- **Given:** a conversation with entries
- **When:** a team member resets it
- **Then:** the next context is empty, every earlier entry is stored, and the seat is kept

**Verification:** test — `test/service/seat_operations.test.ts` ("conversations.reset"),
`test/service/conversation_control_operations.test.ts`.

#### AC-011.2 — Reset with a new seat

- **Given:** a conversation
- **When:** a team member reseats it with a reset and a note
- **Then:** the context is cleared for the new seat, the note starts the new context, the earlier entries are kept and
  a clean seat change is recorded; a seat that doesn't resolve is refused and neither resets nor reseats

**Verification:** test — `test/service/seat_operations.test.ts` ("conversations.seat with a reset").

### REQ-012 — Lead conversation of a job

When a job is created (Jobs spec), entry routing SHALL start its lead conversation:

- with the role the job source names, or `bob` when it names none, with that role's defaults unless a team member's
  request names a model, a thinking level or a registered workspace
- with the job's first input as its first input
- with an origin that records the job source: the team member's request and its way in, the schedule entry and fire
  time, the trigger and its event, or the conversation that created the follow-up job

Every conversation except the front desk (REQ-021) MUST record the job it belongs to and whether it is the job's
lead conversation.

#### AC-012.1 — Role, first input and job links

- **Given:** a new job
- **When:** its lead conversation starts with no role named, and with a role and overrides a request names
- **Then:** it is seated as `bob` with its defaults, or as the named role with the named values, carries its job links
  and the first input

**Verification:** test — `test/service/job_operations.test.ts`.

#### AC-012.2 — The origin of each job source

- **Given:** each job source kind
- **When:** a lead conversation starts for it
- **Then:** its origin records the job source, and the job source is the seat actor

**Verification:** test — `test/service/job_operations.test.ts`.

#### AC-012.3 — Refusals create nothing

- **Given:** a start that names an unknown role, an unresolvable override, an override from a source other than a
  request, a follow-up from an agent whose conversation doesn't exist, or an origin of another kind than the
  caller's (S-002 AC-012.5)
- **When:** it is called
- **Then:** it is refused and nothing is created

**Verification:** test — `test/service/job_operations.test.ts`.

#### AC-012.4 — A repeated start creates one lead

- **Given:** a start that is repeated, or one interrupted by a crash
- **When:** it is called again
- **Then:** the original conversation is returned and the first input is submitted once

**Verification:** test — `test/service/job_operations.test.ts`, `test/service/agents_crash.test.ts`.

### REQ-013 — Schedule fires and triggers

Each fire of a schedule entry or of a trigger SHALL create a new job and so a new lead conversation (REQ-012). The
schedule entry or trigger may name a role, and the lead conversation starts with it. The schedules and triggers spec
defines the rest of a fire's behaviour (product owner ruling, 2026-10-31): refusing an entry that names an unknown
role when it is loaded or created, the history of its last runs an entry passes to its next run, skipping a fire whose
seat workspace folder no longer exists, and skipping a fire while the entry's previous job still works.

#### AC-013.1 — A fire starts a lead conversation with its role

- **Given:** a schedule fire or a trigger origin naming a role
- **When:** the lead conversation of its job starts
- **Then:** it is seated as the named role, with its defaults, and its origin records the fire or the trigger

**Verification:** test — `test/service/job_operations.test.ts` ("records the origin of each job source kind").

### REQ-014 — Unattended runs and blocked jobs

No conversation SHALL wait for a human, except a job's lead conversation while its job is blocked. Then the lead
conversation is parked: it holds no worker thread, and the answer to the job's question arrives as a new input that
makes it ready again. Handoffs and agent invocations have no confirmation step. Parking for reports waits for agents,
not for a human.

#### AC-014.1 — A blocked job holds no worker thread

- **Given:** one worker thread and a job whose lead conversation is parked
- **When:** another conversation has work, and later the answer arrives
- **Then:** the other conversation runs, and the lead continues once a worker thread is free

**Verification:** test — `test/service/agents_capacity.test.ts` ("a job").

#### AC-014.2 — Input continues a lead parked for its Blocked job

- **Given:** a lead conversation parked because its job is Blocked
- **When:** a team member submits input to it
- **Then:** it continues with that input on a free worker thread

**Verification:** test — a service test on the fake model.

### REQ-015 — Missing workspace during a run

If a seat's workspace folder disappears while a conversation uses it, tool calls that need the workspace MUST fail as
ordinary tool errors that the agent sees. The daemon keeps running.

#### AC-015.1 — A removed workspace gives a tool error

- **Given:** a conversation seated in a workspace
- **When:** the folder is removed and the agent calls a tool
- **Then:** the tool returns an error result, and the conversation answers the next input

**Verification:** test — `test/service/shipped_tools.test.ts` ("returns an error result and answers the next input
when the workspace folder is removed").

### REQ-016 — Monitoring

The-intern SHALL let a team member do all of the following through the read operations of the service layer (S-002
REQ-012, REQ-014), without the daemon interrupting any running work. The command-line views of them belong to the
command-line spec (product owner ruling, 2026-10-31).

- list all conversations with id, job, whether it is the job's lead conversation, whether it is the front desk,
  seat (role, model, thinking level, workspace), origin (job source, invoking conversation or front desk), status
  (running, idle, parked, waiting for a worker thread or closed, REQ-026) and last activity
- list the conversations of a job
- show the conversations a conversation invoked, recursively
- read a transcript with seat records and attribution (REQ-007), including entries from before a reset
- follow a running conversation live

#### AC-016.1 — List and filter by job

- **Given:** conversations of several jobs, in each status, `closed` included
- **When:** a team member lists them, and lists one job's
- **Then:** each is returned with its job, lead flag, seat, origin, status, last activity and depth, and the job filter
  returns only that job's

**Verification:** test — `test/service/conversation_read_operations.test.ts`.

#### AC-016.2 — Invocations

- **Given:** a conversation that invoked agents that invoked their own
- **When:** a team member reads its invocations
- **Then:** the invoked conversations are returned recursively

**Verification:** test — `test/service/conversation_read_operations.test.ts`.

#### AC-016.3 — Transcript content

- **Given:** a transcript with seat records, a reset, reports and steers
- **When:** a team member reads it
- **Then:** it holds the seat records, the entries before the reset, each assistant entry with its seat, and report
  and steer entries by their own data

**Verification:** test — `test/service/conversation_read_operations.test.ts`.

#### AC-016.4 — Follow live

- **Given:** a running conversation
- **When:** a team member subscribes to it
- **Then:** they get a snapshot and then each change, with seat changes and report and steer entries by their own data

**Verification:** test — `test/service/conversation_feed.test.ts`, `test/service/instance_feed.test.ts`.

### REQ-021 — The front desk

Each instance SHALL have exactly one front desk: a standing conversation that assists team members and belongs to no
job. At startup (S-002 REQ-002 step 6), entry routing SHALL make sure it exists:

- If the instance has none, entry routing creates one conversation seated as `desk` with that role's defaults, with
  no job, no first input and the origin "front desk" (REQ-023). The seat record names the daemon as actor. Its
  conversation id is recorded under a fixed creation key in the daemon's own creation-key record, in the commit that
  creates the conversation (ADR-001 decision 4), so a crash leaves neither or both.
- If the instance has one, entry routing keeps it: its id, seat and transcript are unchanged.
- No operation or tool creates a second front desk.

`desk.get` SHALL return the front desk's conversation id and seat, and `conversations.list` SHALL mark it as the
front desk. Team members reach it from the command line and the web interface with the existing operations:
`conversations.submit`, `conversations.entries`, the conversation feed, `conversations.abort` (which stops its current
run), `conversations.reset` and `conversations.seat`. Input from both ways in shares one transcript, in the order
pi-durable admits it; the daemon adds no lock of its own.

The front desk's runs take worker threads like any other work and count toward their limit (REQ-010). It never
parks, and no job waits on it. Its input, queueing, steering and crash survival come from pi-durable (ADR-001); the
only fact the daemon adds for it is its conversation id.

#### AC-021.1 — First start

- **Given:** a new instance
- **When:** the daemon starts
- **Then:** `desk.get` returns a conversation seated as `desk` with no job and the origin "front desk", and
  `conversations.list` lists it marked as the front desk, with no job and no lead flag

**Verification:** test — a service test on the fake model.

#### AC-021.2 — The same front desk after a restart

- **Given:** an instance whose front desk has entries
- **When:** the daemon stops and starts again
- **Then:** `desk.get` returns the same conversation id and seat, its entries are kept, and no second front desk
  exists

**Verification:** test — a service test on the fake model.

#### AC-021.3 — A kill during the creation

- **Given:** a new instance whose daemon is killed with `kill -9` just before the commit that creates the front desk,
  and another killed just after it
- **When:** each daemon starts again, and again after that
- **Then:** each instance has exactly one front desk, and `desk.get` returns the same conversation id on every later
  start

**Verification:** test — a service test killing the daemon at each point.

#### AC-021.4 — One history for both ways in

- **Given:** the daemon with both listeners
- **When:** a team member sends a message to the front desk over the network listener, and another team member then
  reads its entries over the local socket and sends a message there
- **Then:** the first message is in the entries read over the local socket, and both messages are in one transcript
  in the order they were admitted, each with its way in

**Verification:** test — a service test through both listeners on the fake model.

#### AC-021.5 — A kill during a turn

- **Given:** the front desk in the middle of a run on a team member's message
- **When:** the daemon is killed with `kill -9` and started again
- **Then:** the run resumes through pi-durable and the message is answered once

**Verification:** test — a service test on the fake model, killing the daemon during the run.

#### AC-021.6 — The front desk doesn't hold up job work

- **Given:** one worker thread and an idle front desk
- **When:** a job is created, and later a team member writes to the front desk while the job's lead runs
- **Then:** the lead runs at once, and the front desk's run waits for the worker thread in arrival order like any
  other work

**Verification:** test — a service test on the fake model with one worker thread.

### REQ-022 — The front-desk tools

In the front desk, every model turn SHALL be offered exactly the tools of its seat's role and the front-desk tools. It
SHALL NOT be offered the coordination tools (`handoff`, `invoke`, `steer`) or the job tools that act on a
conversation's own job (S-004 REQ-013), `block_job` and `complete_job` included. The front-desk tools are offered in no
other conversation. They are:

- **Jobs:** `read_job`, `list_jobs`, `create_job`, `update_job`, `add_worklog` and `relate_jobs`, each naming the job
  it acts on, as S-004 REQ-021 defines.
- **State:** read a conversation's status, entries and invocations; read the daemon status; read usage. Each returns
  what the matching read operation returns (REQ-016; S-002 REQ-012).
- **Steering:** send input to a conversation of a job, which acts as `conversations.submit` does: a steer or a
  follow-up for a running conversation, a held message for one parked for reports, and the input that continues a lead
  parked because its job is Blocked (REQ-020; S-004 REQ-006). The input takes the request id
  `steer:<frontDeskId>:<toolCallId>`, as the `steer` tool's input does, so a call repeated after a crash delivers it
  once. Stop a conversation of a job, which acts as `conversations.abort` does, with its cascade (REQ-008).

The front desk itself takes input only from team members (REQ-020). A steering tool that names the front desk itself
or a conversation that doesn't exist returns an error result, and the run goes on. Only a team member changes the
front desk's seat (REQ-004); the agent in it can't hand off or reseat itself. The `desk` role's tool set names none
of the tools the-intern ships (REQ-002), so an agent of it in the front desk changes no file and runs no command.

#### AC-022.1 — Exactly the front-desk tools

- **Given:** the front desk seated as `desk`
- **When:** it takes a turn
- **Then:** the model is offered exactly the front-desk tools, and none of `handoff`, `invoke`, `steer`, `block_job`,
  `complete_job`, `read`, `write`, `edit` and `bash`

**Verification:** test — a service test on the fake model.

#### AC-022.2 — A request for work becomes a job

- **Given:** the front desk
- **When:** a team member writes "please check why the nightly build is slow" over the local socket, and the fake
  model calls `create_job` and then replies
- **Then:** a job `C-n` exists with the front desk in its origin details (REQ-023; S-004 REQ-021), its lead
  conversation starts seated as `bob` as for any job, and the front desk's reply carries `C-n`

**Verification:** test — a service test on the fake model.

#### AC-022.3 — What is blocked

- **Given:** jobs in each status, two of them Blocked with their reasons
- **When:** a team member asks the front desk "what's blocked?" and the fake model calls `list_jobs` for Blocked jobs
  and `read_job` for each
- **Then:** the tool results hold exactly the two Blocked jobs with their Blocked reasons

**Verification:** test — a service test on the fake model.

#### AC-022.4 — An answer passed to a Blocked job

- **Given:** job `W-3` Blocked, its lead conversation parked
- **When:** a team member asks the front desk "tell W-3 to use the staging database", and the fake model sends that
  input to `W-3`'s lead conversation
- **Then:** the lead takes the input, recorded as from the front desk, and `W-3` is In progress again (REQ-020;
  S-004 REQ-006)

**Verification:** test — a service test on the fake model.

#### AC-022.5 — A stop passed to a job

- **Given:** a job whose lead runs with one invoked agent awaited
- **When:** the front desk stops the lead conversation
- **Then:** the lead and the invoked conversation are aborted as `conversations.abort` aborts them, and the front
  desk's own run goes on

**Verification:** test — a service test on the fake model.

#### AC-022.6 — Reseating the front desk

- **Given:** the front desk seated as `desk`
- **When:** a team member seats `gp` in it, and the agent in it calls a steering tool on the front desk itself
- **Then:** the next turn runs as `gp`, offered `gp`'s tools and the front-desk tools and none of the coordination
  tools, and the steering call returns an error result while the run goes on

**Verification:** test — a service test on the fake model.

#### AC-022.7 — A kill during a steering call

- **Given:** the front desk sending input to a job's lead conversation
- **When:** the daemon is killed with `kill -9` during the steering call and started again
- **Then:** the call resumes, and the lead's transcript holds the input exactly once, with request id
  `steer:<frontDeskId>:<toolCallId>`

**Verification:** test — a service test on the fake model, killing the daemon during the steering call.

### REQ-023 — The front desk's origin and attribution

The front desk's origin SHALL be "front desk", and it SHALL record no job and no lead flag. Every input to the front
desk SHALL record the way in it came through, as REQ-007 and REQ-020 record a team member's input: `command line` or
`web interface`. The front desk doesn't tell team members apart. Everything the front desk passes on SHALL record that
it came through the front desk:

- a job it creates, in its origin details (S-004 REQ-003, REQ-021)
- an input it sends to a job's conversation, as an `intern.steer` entry whose sender is the front desk (ADR-004)

A stop it sends records no front-desk actor: no record of who stopped a conversation exists, and the front desk adds
no new fact for it.

#### AC-023.1 — Each input records its way in

- **Given:** the daemon with both listeners
- **When:** a team member submits to the front desk over the local socket and another over the network listener
- **Then:** the front desk's entries hold both inputs, with way in `command line` and `web interface`

**Verification:** test — a service test through both listeners on the fake model.

#### AC-023.2 — What it passes on names the front desk

- **Given:** the front desk
- **When:** its fake model creates a job and sends input to a job's lead conversation
- **Then:** the job's origin details and the input's `intern.steer` entry each name the front desk

**Verification:** test — a service test on the fake model.

### REQ-024 — Compaction and reset of the front desk

The front desk's context SHALL be kept within the model's window by pi-durable's automatic compaction, as for every
conversation; the daemon starts no compaction of its own for it. A team member SHALL be able to reset the front desk
as any conversation (REQ-011): its context is cleared, its earlier entries stay stored, its seat is kept, and its
conversation id doesn't change, so `desk.get` keeps naming it. A reset is the only way to start the front desk clean.

#### AC-024.1 — Automatic compaction

- **Given:** the front desk on the fake model with a small context window and the default compaction settings
- **When:** team members write to it until its context nears the window
- **Then:** a `pi.compaction` entry appears, the next context starts from the summary, the next message is answered,
  and the daemon has called no compaction itself

**Verification:** test — a service test on the fake model with a small context window.

#### AC-024.2 — Reset keeps the front desk

- **Given:** the front desk with entries
- **When:** a team member resets it with `conversations.reset`
- **Then:** `desk.get` returns the same conversation id and seat, the next context is empty, and every earlier entry
  is stored

**Verification:** test — a service test on the fake model.

### REQ-025 — The front desk is not a job conversation

Every capability that acts on the job of a conversation SHALL refuse the front desk with an error saying that it is
not a job conversation, and change nothing. In this spec that is the capability that aborts every conversation of a
job (REQ-008); S-004 REQ-022 applies the same refusal to the job operations. The front desk never becomes a job's
lead conversation. Aborting and closing a job's conversations, by a cancel, a complete or a repair (S-004), never
reaches the front desk, and the front desk never closes (REQ-026). Removing the `desk` role is refused like removing
any shipped role (REQ-003), and changing it affects only seats made after the change.

#### AC-025.1 — Refused as not a job conversation

- **Given:** the front desk
- **When:** the job abort capability is called with the front desk's conversation id
- **Then:** it is refused with an error saying the front desk is not a job conversation, and nothing changes

**Verification:** test — a service test on the fake model.

#### AC-025.2 — Job aborts don't reach the front desk

- **Given:** the front desk in the middle of a run, and two jobs
- **When:** one job is cancelled and the other completed
- **Then:** the front desk's run goes on, its entries are unchanged, and it isn't closed

**Verification:** test — a service test on the fake model.

#### AC-025.3 — The desk role can't be removed

- **Given:** the front desk seated as `desk`
- **When:** a team member removes the `desk` role
- **Then:** the removal is refused as for a shipped role, and the front desk and its seat are unchanged

**Verification:** test — a service test.

### REQ-026 — Closed conversations

Every conversation of a job SHALL close when the job becomes Done, by a complete or a cancel (S-004 REQ-007), and stay
closed for good. A conversation belongs to at most one job for its whole life, and a Done job is never reopened, so a
closed conversation never works again. Its transcript stays as the record of what was done. More work is a new job,
which a team member or an agent of any job may create and may relate to the first, as it chooses (S-004 REQ-009).

- Closing is part of the job abort (REQ-008): every conversation of the job, whether running, idle, parked or waiting
  for a worker thread, is aborted, with no report sent (REQ-019), its queued input and held messages are withdrawn,
  and it is marked closed in the abort's own commit. That covers the lead conversation and every conversation invoked
  within the job, at any depth.
- A closed conversation keeps its id, seat, origin, job links, invocation links and every stored entry. Every read
  operation works on it (REQ-016; S-002 REQ-012). It lists with status `closed` from the commit that sets its mark,
  whatever else is true of it, and the instance feed publishes a `status_changed` delta to `closed` for it.
- Every operation that would change a closed conversation SHALL refuse it with `conflict`, naming the conversation as
  closed, and change nothing: submitting input in any busy mode, withdrawing one of its submissions
  (`submissions.withdraw`), abort, reset, reseat and compaction (REQ-004, REQ-008, REQ-011, REQ-020; S-002 REQ-012).
  The `steer` tool and the front-desk steering tools (REQ-022) aimed at a closed conversation return an error result,
  and the run goes on.
- From the job's complete or cancel, a conversation of the job counts as closed for every refusal of this
  requirement, even before its closed mark is committed. Input admitted before the complete or cancel is withdrawn or
  aborted by the job abort and settles `unanswered`. No input runs a model turn after the job is Done.
- A coordination or job tool called from a conversation whose job is Done, or that is closed, returns an error result
  and changes nothing: `invoke` creates no conversation, `handoff` changes no seat, `steer` delivers nothing. A lead
  start (`jobs.startLead`, REQ-012) is refused at whichever of its two commits finds the job Done: refused at the lead
  conversation's creation, it creates no conversation; refused at the first input, it submits no first input, and the
  conversation it created is closed by the job abort.
- A closed conversation runs no more model turns, after a restart too: it takes no automatic compaction, report or
  held message. A closed conversation whose abort a crash left unfinished is aborted by S-004 REQ-018 rule 4 before
  work resumes.
- The front desk belongs to no job and never closes (REQ-021, REQ-025).

#### AC-026.1 — Done closes every conversation of the job

- **Given:** job `C-4` whose lead is parked for an invoked agent that runs and has invoked its own, and job `W-5`
  whose lead is idle
- **When:** a team member cancels `C-4` and completes `W-5`
- **Then:** all four conversations list with status `closed`, no report is delivered, each keeps its stored entries
  and seat, `conversations.get`, `conversations.entries` and `conversations.invocations` return them, and the
  instance feed publishes a `status_changed` delta to `closed` for each

**Verification:** test — a service test on the fake model.

#### AC-026.2 — A closed conversation refuses changes

- **Given:** a closed conversation
- **When:** a team member submits input to it in each busy mode, withdraws one of its submissions, and aborts,
  resets, reseats it with a reset, reseats and compacts it
- **Then:** each call is refused `conflict` naming the conversation as closed, and its entries, seat and status are
  unchanged

**Verification:** test — a service test on the fake model.

#### AC-026.3 — Tools aimed at a closed conversation

- **Given:** a closed conversation, a running agent in another job's conversation, and the front desk
- **When:** the agent calls `steer` naming the closed conversation, and the front desk sends input to it and stops it
  with its steering tools
- **Then:** each call returns an error result, both runs go on, and the closed conversation gains no entry

**Verification:** test — a service test on the fake model.

#### AC-026.4 — Closed across a restart

- **Given:** a job's closed conversations, one of them closed while it was running, and one whose closed mark was
  committed when the daemon was killed before pi-durable's abort
- **When:** the daemon is killed with `kill -9` and restarted
- **Then:** each is still closed, runs no model turn and takes no compaction, and the front desk is not closed

**Verification:** test — a service test on the fake model.

#### AC-026.5 — A submit racing the job's cancel

- **Given:** a job's running lead, and a submit to it held between its closed check and its admission
- **When:** the job is cancelled
- **Then:** the submit is refused `conflict` or settles `unanswered`, and the lead runs no model turn after the cancel

**Verification:** test — a service test on the fake model, with the interleaving injected.

#### AC-026.6 — An invocation racing the job's complete

- **Given:** a job whose invoked agent has an `invoke` call in flight
- **When:** the lead calls the complete job tool
- **Then:** no conversation of the job is left unclosed: the `invoke` call returns an error result and creates no
  conversation, or the conversation it creates is closed with the others

**Verification:** test — a service test on the fake model, with the interleaving injected.

#### AC-026.7 — A lead start racing the job's cancel

- **Given:** a `jobs.create` whose lead start is held after the job write, before its lead conversation is created
- **When:** the job is cancelled
- **Then:** the start creates no conversation, `jobs.get` returns no `leadConversation`, and no conversation of the
  job is left unclosed

**Verification:** test — a service test on the fake model, with the interleaving injected.

#### AC-026.8 — A cancel between the lead's creation and its first input

- **Given:** a `jobs.create` whose lead start is held after its lead conversation is created, before its first input
  is submitted
- **When:** the job is cancelled
- **Then:** `jobs.create` returns the job Done with resolution `cancelled` and the cancel's justification, the lead
  conversation is closed and holds no first input, and the history records one cancel

**Verification:** test — a service test on the fake model, with the interleaving injected.

## Quality Requirements

### REQ-017 — Durability

Seats, seat records, resets, job links, invocation links, depth, origins, parked state, undelivered reports, the closed
mark (REQ-026) and the front desk's conversation id (REQ-021) MUST survive a daemon kill and restart. A seat change,
handoff, reset, invocation, park or report interrupted by a crash either completed before the crash or completes on
resume. It is never half-applied: never a new seat without its record, never an invoked conversation without its
invocation link, never a lead conversation without its job, and never a report lost or delivered twice. Work waiting
for a worker thread is still waiting after the restart, in the same order.

#### AC-017.1 — Kill during a seat change, a handoff, an invocation and a lead start

- **Given:** a daemon in the middle of a seat change, a Clean handoff, an agent invocation or a lead start
- **When:** it is killed with `kill -9` and restarted
- **Then:** each change is either complete with its record and links or not applied, and each first input and job
  prompt runs once

**Verification:** test — `test/service/agents_crash.test.ts`.

#### AC-017.2 — Kill while parked, delivering or waiting

- **Given:** a daemon with a parked conversation, a report being delivered, a held message, or work waiting for a
  worker thread
- **When:** it is killed with `kill -9` and restarted
- **Then:** the conversation stays parked without a worker thread and continues on its reports, each report and held
  message is delivered exactly once, and the waiting work keeps its order and runs once

**Verification:** test — `test/service/agents_crash_reports.test.ts`, `test/service/reports.test.ts` ("delivers a
report exactly once when the host closed before it was delivered").

## Configuration Requirements

- **Roles.**
  - **What:** the team's own roles, and the changes made to the shipped roles: instructions, tool set, skills,
    default model, thinking level and workspace (REQ-003).
  - **Where:** the-intern's configuration (described in the daemon spec), also changeable while the daemon runs
    (REQ-003, S-002 REQ-022).
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
    and unregistrations can also be made while the daemon runs (REQ-018, S-002 REQ-022).
  - **Constraints:** an absolute, existing directory accessible only to the account the-intern runs as (trusted
    input), checked at registration (REQ-018). Team members are responsible for what parent directories contribute,
    because `AGENTS.md` files are also read from parent directories.
  - **Missing:** only the per-role default workspaces exist. A registration that fails the check stops the daemon
    at startup.

A change to one of the settings above made while the daemon runs is checked as at startup. Where an invalid value in
the file stops the daemon at startup, an invalid runtime change is refused with the reason and nothing changes
(S-002 REQ-022).

- **Role in a schedule entry or trigger.**
  - **What:** an optional role name per schedule entry or trigger.
  - **Where:** the schedule and trigger store, which the schedules and triggers spec defines, together with each
    entry's run history (REQ-013).
  - **Constraints:** an existing role.
  - **Missing:** `bob` (REQ-012).
- **Invocation depth cap.**
  - **What:** the maximum invocation depth (REQ-009). It bounds runaway invocation chains that no human is watching.
  - **Where:** a built-in constant of the daemon (S-002 REQ-009), not a setting.
  - **Constraints:** **10**. It changes only with a release.
  - **Missing:** not applicable; the constant always applies.
- **Worker threads.**
  - **What:** the number of worker threads, which is the maximum number of active agent runs (REQ-010). It bounds
    local load.
  - **Where:** a built-in constant of the daemon (S-002 REQ-009), not a setting. Tests may set a smaller count
    through a test-only switch.
  - **Constraints:** **32**, the most concurrent agent runs the daemon is tested with. It changes only with a
    release, after load tests.
  - **Missing:** not applicable; the constant always applies.
- **Live test model.**
  - **What:** the model used by the live acceptance tests (Success Criteria).
  - **Where:** a test-only setting.
  - **Constraints:** a low-cost OpenAI model available through the existing pi agent login of the account running
    the tests. No credentials are stored in the repository or the state dir.
  - **Missing:** live tests are skipped with a visible notice. Deterministic tests still run.

## Assumptions and Dependencies

- **S-002, Daemon and host runtime.** Provides the database, startup, configuration file, service layer, admission
  and observation feed this spec builds on. Its built-in constants fix the depth cap and the worker-thread count.
- **S-004 (Jobs).** Creates jobs and calls `jobs.startLead`, which is in-process only, from `jobs.create` (REQ-012);
  decides when a job is blocked and delivers its answer (REQ-014); completes and cancels jobs, and its complete and
  cancel actions call this spec's abort capability (REQ-008); adds the job tools to every role (REQ-003, REQ-005).
- **The schedules and triggers spec, the command-line spec and the Email spec (not yet written).** They own the fire
  behaviour (REQ-013), the monitoring views (REQ-016) and the mailbox. This spec's live acceptance test 1 moved to the
  schedules and triggers spec (product owner ruling, 2026-10-31).
- **pi-durable** (the pinned version in `README.md`). Provides the durable conversations, inbox, reset, compaction,
  fork and task-owned abort that seating, handoff, invocation and steering use. The-intern's own facts about a
  conversation live in its own document, with redelivery as the only recovery (ADR-001 decision 4); host writes during
  a running turn are queued (ADR-003); inputs sent on someone's behalf are their own entry kinds (ADR-004). A pi-durable
  upgrade that changes these behaviours needs a review of REQ-006, REQ-008, REQ-019, REQ-020 and REQ-017.
- **pi agent login and settings** of the account the-intern runs as. They give the models, the default model and the
  default thinking level (REQ-003). A missing login fails model requests, not the daemon (S-002).
- **Assumption, confirmed by the implementation:** the account the-intern runs as is the boundary of what agents can
  reach; workspaces don't confine agents (S-000, ADR-002).
- **Assumption, confirmed in the pinned pi-durable 1.4.0: automatic compaction needs no job and no trigger from the
  daemon.** Compaction is on by default (`DEFAULT_COMPACTION_POLICY.enabled` is true) and runs for any conversation
  while a model request is prepared: in the background once the estimated context is within 32,768 tokens of the
  blocking threshold, blocking once it passes the model's window less 16,384 tokens, and once more after a provider
  "context too long" error. The front desk relies on it (REQ-024). The pi agent setting `compaction.enabled`, mapped
  by S-002 REQ-019, can turn it off for every conversation of the instance; the front desk then grows until a team
  member resets or compacts it (`conversations.compact`).
- **Assumption, confirmed in the pinned pi-durable 1.4.0 and `src/host/conversation_control.ts`: a reset keeps the
  conversation id.** `conversations.reset` calls the pi-durable conversation's `reset`, which writes a `pi.reset` entry
  into the same conversation, so `desk.get` names the same front desk after a reset (REQ-024).
- **The command-line spec and the Web interface spec (not yet written).** They present the front desk: `bob chat` and
  the web chat call `desk.get` and then the operations of REQ-021. S-003's listeners carry `desk.get` with no change,
  as they carry every catalogue operation.

## Success Criteria

1. With no configuration file, the daemon starts with exactly the roles `bob`, `gp` and `desk`, and a team member can
   create, change, restore and remove roles and register and unregister workspaces through the service operations, each
   change surviving a restart (REQ-001, REQ-003, REQ-018). Measured by `npm test`.
2. Live acceptance test 2: through `conversations.seat`, the seat of a job's lead conversation changes from `bob` to
   `gp`; the next answer is attributed to `gp`, and `gp`'s tools run in `gp`'s workspace (REQ-004, REQ-005, REQ-007).
   Measured by `npm run test:live:agents` (`test/live/live_agents.ts`) against a real model.
3. Live acceptance test 3: a `gp` agent invokes two `bob` agents and parks; both reports arrive as new input, and the
   `gp` agent continues (REQ-008, REQ-019). Measured by `npm run test:live:agents`.
4. Every requirement's acceptance scenarios pass in `npm test` on the fake model, with no network, including the
   kill-and-restart scenarios of REQ-017.
5. Every conversation the daemon lists shows its job and lead flag, or the front-desk mark for the front desk, and
   its seat, origin and status, and a parked conversation never holds a worker thread (REQ-010, REQ-014, REQ-016,
   REQ-021). Measured by `npm test`.
6. After any number of kills and restarts, an instance has exactly one front desk, `desk.get` names the same
   conversation, and that conversation is offered only the front-desk tools while seated as `desk` (REQ-021, REQ-022,
   REQ-024). Measured by `npm test`.
7. Live acceptance test 4: a team member asks the front desk on a real model for a piece of work; it creates a job
   with the front desk in its origin details and replies with the job's short number (REQ-022, REQ-023). Measured by
   a live check in `test/live/` against a real model.

## Implementation Order

Delivered: phases 1 to 5 are implemented (tasks up to T-091). Phase 6, the front desk, is broken down with the
command-line spec (S-005, tasks T-145 to T-159). Phase 7, closed conversations, comes with the v0.9 amendment and
is broken down in T-186 to T-196.

This spec relies on the daemon and host-runtime spec for the database, startup, configuration and process model,
on the control-endpoint spec for the surfaces the command line, the web interface and monitoring use, and on the
Jobs spec for creating jobs. Its phases can be developed against a minimal host until those exist.

| Phase | What | Depends On |
|---|---|---|
| 1 | Role catalog with shipped and team roles, workspace registration, seating with overrides and role prompt; team member changes the seat; resets; seat records and attribution | Daemon and host runtime |
| 2 | Handoff by agents in all three context modes | Phase 1 |
| 3 | Agent invocation (context modes, steerable and parked), report-back step, abort of awaited invoked agents, steering by agents, depth cap | Phase 1 |
| 4 | Worker threads, and parked conversations freeing them | Phase 3, daemon spec's process model |
| 5 | Job sources: the operation that starts a job's lead conversation for requests, schedule fires, triggers and follow-ups; the parking and continuing that blocked jobs use; the capability that aborts every conversation of a job. Monitoring read operations: list, job links, statuses, invocations, live transcript. The schedule behaviour, the command-line views and the job abort operation come with their own specs | Phases 1–3, S-002 phase 3 |
| 6 | The front desk: the shipped `desk` role, its creation and recovery at startup, `desk.get` and the front-desk mark in `conversations.list`, the front-desk tools, its attribution, and the refusals of REQ-025; live acceptance test 4 | Phases 1–5, S-004's job tools and `list_jobs` (S-004 REQ-021) |
| 7 | Closed conversations: the closed mark written with a job's abort, `closed` in the status, the `conflict` refusals of input and control, the error results of the steering tools, and the closed mark in repair rule 4 (S-004 REQ-018) | Phases 1–6, S-004's complete, cancel and repair rules |

## Open Questions

Both questions are deferred decisions with a specified interim behaviour, so neither blocks the implemented
behaviour. Deciding either one is a scope amendment of this spec.

- **How a parked agent's continue rule is chosen.** Owner: product owner. Interim: continue on each report (REQ-019);
  the "after every report" behaviour exists in the host and is tested. Resolved when the choice and who makes it are
  decided.
- **Model, thinking level or workspace per schedule entry.** Owner: product owner, with the schedules and triggers
  spec. Interim: a fire runs with the named role's defaults (REQ-013). Resolved when that spec is written.

## Amendment Log

| Date | What changed | Why | Affected tasks |
|------|-------------|-----|----------------|
| 2026-10-17 | The invocation depth cap (10) and the worker-thread count (32) became built-in constants instead of user settings. Role defaults and workspace registration can change while the daemon runs, and workspaces can be unregistered (R-3, R-3a, Configuration Requirements, Verification). Consistency review: the per-role settings entries name the runtime path too. | Decided with the daemon spec (S-002 R-9, R-22): the counts follow load tests, not user tuning; settings changed from clients apply without a restart. | None; S-001 isn't broken down yet |
| 2026-10-19 | Wording only: removed references to the earlier implementation and its prototype from the Purpose and the Exclusions. No requirement changed. | Project documents describe the-intern as it is specified, not what it replaces. | None |
| 2026-10-30 | Aligned with the rewritten S-000: the single user became equal team members; work is organised as jobs, each with one lead conversation and lead agent, and invoked agents do parts of a job and never close it; `bob` is the default lead role; team members can create, change and remove roles, including instructions and tool sets, and change shipped roles without editing the installed copy; the root conversation and interactive chat are removed; job sources (requests, schedule fires, triggers, follow-ups) replace entry points; schedule entries choose fresh runs or the history of their last runs; a blocked job's lead conversation parks; no approval rules; the worker-thread count is S-000's agent limit and bounds width (Purpose, Definitions, Exclusions, Design Principles, all components, R-1 to R-17, Workflow, Configuration Requirements, Verification, Implementation Order). Consistency review: the coordination capabilities are part of every role and a tool set can't leave them out (R-3, R-5); Installation named as S-000's component; wording in R-13 and live test 1; a Verification item for the coordination rule. | Product owner ruling: S-000 is the source of truth, and S-001 is aligned as part of creating S-000. | None; S-001 isn't broken down yet |
| 2026-11-01 | spec-truth reconciliation — FAIL | Abort, report timing, report sender and reject-hold defects; 2026-10-31 rulings and the interim continue rule not recorded; one question to the product owner | none |
| 2026-11-01 | R-8a: an invoked agent's part is done when its run ends while it is not parked and awaits no report; the continue rule is "continue on each report" until the choice is decided; an invoked conversation aborted on its own sends its invoker an "aborted" report with its last answer, and a parked invoker continues under its continue rule, while an abort that cascades from the invoker or aborts the job sends none; the transcript records which invoked agent sent each report, as an `intern.report` entry. R-8: a parked invocation that shares its model turn with other tool calls is refused like the depth cap; an abort leaves no aborted conversation parked or waiting for a report, and withdraws its held messages; the job abort operation belongs to the Jobs spec, and S-001 delivers the capability it calls (`abortJobConversations`). R-10a: a reject input to a parked conversation is held like any other message. Component 4 Interfaces: the conversation's own `intern.conversation` document (held messages, awaiting links). R-13, R-16, Component 6 Interfaces, Exclusions, Workflow, Configuration Requirements, Verification and Phase 5: R-13's schedule behaviour and live test 1 moved to the schedules and triggers spec; live test 2 runs through `conversations.seat`; the command-line monitoring views moved to the command-line spec, and S-001 delivers the read operations. Verification items for each change. | Spec-truth reconciliation of S-001 after T-071 to T-082 (findings F1 to F5, F7 to F9). Product owner decision on F3, 2026-11-01: a lone abort of an invoked conversation reports "aborted" with its last answer; a cascading abort reports nothing and leaves nothing parked or awaiting. Product owner rulings of 2026-10-31 (F7, F8). Driving ADRs: ADR-001 decision 4 (amended 2026-11-01) for the conversation's own document; ADR-004 for `intern.report`. | T-069, T-072, T-074, T-075, T-077, T-081 (built as amended); follow-ups T-083 to T-089 |
| 2026-11-01 | Component 4 Interfaces: the conversation's `intern.conversation` document also holds its parked state and its abort mark, which records that its invoker is owed an "aborted" report (R-8a); an abort's facts are written in one commit just before pi-durable's abort. | R-8 and R-8a as amended in v0.3 (product owner decision F3) need the abort recorded as a fact, so an idle or parked conversation's "aborted" report is delivered and a crash doesn't lose it (R-17). Driving ADR: ADR-001 decision 4, amended 2026-11-01. | T-084, T-085 |
| 2026-11-01 | spec-truth reconciliation — FAIL | Re-run after T-083 to T-089: the earlier findings are closed; the transcript read operations drop the sender of `intern.report` and `intern.steer` entries (R-16 with R-8a, R-10a) | none |
| 2026-11-01 | spec-truth reconciliation — PASS | Re-run after T-090 and T-091: finding N1 is closed; the transcript read and the conversation feed show `intern.report` and `intern.steer` by their own data, and the context read keeps the model message by product owner decision; ADR-004 amended | none |
| 2026-11-01 | v0.5, format only; no requirement changed meaning. Restructured to the ai-team 0.18.0 spec format: requirements renumbered `R-n` → `REQ-00n`, with R-3a → REQ-018, R-8a → REQ-019 and R-10a → REQ-020 (mapping table in Behavioral Requirements); each requirement got acceptance scenarios with a Verification method, taken from the former Verification section and naming the tests that cover them; Prompt stability became AC-005.4; R-17 moved to Quality Requirements; Components merged into Responsibility Separation; added Users and Journeys, Alternatives Considered (from Exclusions and Definitions), Interfaces (from the shipped tools and operations), Assumptions and Dependencies, Success Criteria (from the Purpose outcomes and the live acceptance tests) and Open Questions (the two deferred decisions already recorded). Earlier rows keep their `R-n` identifiers. | Product owner request: S-001 must match the ai-team 0.18.0 format, keeping its meaning so the implementation stays valid. | None; references in code, docs and ADRs updated to the new identifiers |
| 2026-11-01 | Gate 5 sign-off — product owner. No scope change. | The spec-truth reconciliation of 2026-11-01 passed against v0.4; v0.5 changed the format only, so the verdict carries over. Two accepted limits stay open as follow-up tasks and don't block the sign-off: T-092 (a Compact invocation repeated after a crash compacts again) and T-093 (`lastActivity` reads the whole transcript). | none |
| 2026-11-01 | v0.6. AC-012.3: the refused follow-up is one from an agent whose conversation doesn't exist, and an origin of another kind than the caller's is refused. | S-002 v0.7 builds a lead conversation's origin from the caller (S-002 AC-012.5); S-003 architecture consistency review, finding A. | Investigation task for the S-002 v0.7 deviations |
| 2026-11-02 | v0.7. REQ-020 and AC-020.4: only a message sent to a conversation parked for reports is held; a message sent to a job's lead conversation parked because its job is Blocked continues it (new AC-014.2). REQ-003, REQ-005, AC-005.2 and the agent tools in Interfaces: the job tools (S-004 REQ-013) are offered with the coordination tools whatever the tool set names. REQ-007: the daemon is a seat actor for input it sends under a job's rules. Definitions, Job: the fields S-004 defines. Interfaces: `jobs.startLead` leaves the service operations table and is offered in-process only, called by `jobs.create`. Assumptions: the Jobs spec is S-004. | S-004 architecture consistency review; product owner decisions 2026-11-02. Driving ADR: ADR-001, amended 2026-11-02 for the job store. | None yet; the code changes (the held-message rule in `src/host/steering.ts`, the job tools, `jobs.startLead` off the listeners) come in the S-004 breakdown |
| 2026-11-03 | v0.8. The front desk: one standing conversation per instance that assists team members and belongs to no job. Purpose, Definitions (Front desk, Front-desk tools, Job source and origin, Root conversation, New fork and reset, Compaction), Users and Journeys (journey 7), Design Principles, Alternatives Considered, System Diagram, Responsibility Separation (Role catalog, Agent coordination, Entry routing, new Front-desk tools, Monitoring), Interfaces (the front-desk tools, `desk.get`, the front-desk mark in `conversations.list`, the `intern.steer` sender) and Workflow follow. REQ-001, AC-001.1, REQ-002 and AC-002.1: the shipped `desk` role, with an empty tool set. REQ-003 and REQ-005: in the front desk the front-desk tools replace the coordination capabilities and the job tools. REQ-012: every conversation except the front desk records its job. REQ-016: the list marks the front desk. REQ-017: the front desk's id survives a crash. New REQ-021 (the front desk, its creation and recovery), REQ-022 (the front-desk tools), REQ-023 (origin and attribution), REQ-024 (compaction and reset) and REQ-025 (refusing job-only capabilities), with AC-021.1 to AC-025.3. Exclusions: "Interactive chat" became "Chat beyond the front desk"; added email to the front desk, work in it, a job record for it, its presentation and telling team members apart. Assumptions: the two pi-durable premises, confirmed. Success Criteria 6 and 7 and Implementation Order phase 6. This deliberately reverses part of the 2026-10-30 ruling that removed the root conversation and interactive chat: one standing conversation now assists team members, though it is not a root conversation and does no work. Architecture consistency review (findings F1 to F7), same version: Exclusions, every conversation knows its job except the front desk; REQ-007 and AC-007.1, the daemon is the actor of the front desk's first seat; REQ-020 and new AC-020.5, no agent steers the front desk and only a team member's submit with way in `command line` or `web interface` reaches it; REQ-022 and new AC-022.7, front-desk input takes request id `steer:<frontDeskId>:<toolCallId>` and arrives once after a crash; REQ-023 and AC-023.2, a stop records no front-desk actor; REQ-025 and AC-025.1, the untestable lead-start case removed; Success Criterion 5, the front-desk mark. | Product owner decisions of the front desk brainstorm, 2026-11-03, approved section by section; the command-line spec (S-005) and the web chat open the front desk. Architecture consistency review, 2026-11-03; product owner decisions on F4 and F7. | None yet; the front desk comes in the breakdown of this amendment |
| 2026-11-03 | v0.8, still. Success Criterion 1 names the three shipped roles `bob`, `gp` and `desk`, as REQ-001 and AC-001.1 do. | Gate 2 preflight of the S-005 plan, finding P6: the criterion still named two roles. | T-145 |
| 2026-11-03 | v0.9. Closed conversations: every conversation of a job closes when the job is Done and stays closed for good; it keeps its transcript and every read works on it, and input, abort, reset, reseat and compaction of it are refused `conflict`; the `steer` tool and the front-desk steering tools aimed at it return an error result; it runs no more model turns, after a restart too; the front desk never closes. New REQ-026 with AC-026.1 to AC-026.4. Definitions (Closed), Exclusions (continuing a closed conversation), Responsibility Separation (the closed mark in the conversation's own document, written in the job abort's commit), Interfaces (the job abort capability closes, and serves S-004's repair rule 4), Workflow, REQ-004, REQ-008, REQ-011, REQ-016 (status `closed`), REQ-017 (the closed mark survives a crash), REQ-020, REQ-025 and AC-025.2, and Implementation Order phase 7 follow. Architecture consistency review (findings F1 to F8, F10 to F13 and F15), same version: REQ-026, a conversation of the job counts as closed from the job's complete or cancel, input admitted before it is withdrawn or aborted and settles `unanswered`, and no input runs a model turn after the job is Done (new AC-026.5); a coordination or job tool called from a closed conversation, or from one whose job is Done, returns an error result and changes nothing (new AC-026.6), and a lead start is refused at whichever commit finds the job Done, creating no conversation or submitting no first input (new AC-026.7 and AC-026.8); the refusals include `submissions.withdraw` (AC-026.2, which also adds a reset that reseats); the conversation lists `closed` from the commit that sets its mark, and the instance feed publishes a `status_changed` delta to `closed` (AC-026.1, AC-016.1); S-004 repair rule 4 finishes an abort a crash left unfinished (AC-026.4). AC-008.6: the job abort also closes. Definitions, Users and Journeys, Exclusions, Design Principles, Alternatives Considered, REQ-008, REQ-019 and Assumptions: the lead completes the job rather than closes it. Long lines rewrapped. | Product owner decision of 2026-11-03, during the S-005 dev-loop (T-166): a Done job's conversations close and are kept only as the history of the work; a conversation belongs to at most one job; more work is a new job; the front desk never closes; only read operations act on a closed conversation. Architecture consistency review of the amendment, 2026-11-03; ADR-001 decision 4 amended with it. | T-166 (blocked on it); T-186 to T-196 (Gate 2 passed 2026-11-03; the amendment merged into `dev-pi-durable-s005` before the preflight, by the product owner's approval of the in-flight amendment) |
| 2026-11-03 | v0.9, same version. REQ-026: more work after a Done job is a new job, which a team member or an agent may relate to the first, as it chooses (S-004 REQ-009). | Product owner decision of 2026-11-03 (finding F9 of the S-001 v0.9 consistency review): relating a follow-up job is the agent's choice in the moment. | None |
