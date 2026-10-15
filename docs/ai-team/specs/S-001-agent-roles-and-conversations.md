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

The new bob is a single daemon that runs every conversation in one pi-durable database. Before any channel,
schedule or client can be built, we need to define what a conversation is and what "the agent" working in it is.
The old bob had a single kind of ephemeral agent with no history, and the hierarchical alternatives were rejected:
an overlord bob delegating to owned subagents, bob as a default that channels bypass, and a single long-lived
coordinator. bob's work comes from scheduled prompts that have to be turned into the right actions. That needs
agents that act as interchangeable **roles**: each brings its own instructions, tools and default model and
workspace, and any of them can take over a conversation whenever the state of the work calls for it.

When this spec is done:

- bob ships two predefined roles, **bob** and **gp**.
- Every conversation has exactly one seated role at a time.
- The user or an agent can hand a conversation to another role at any time.
- Any agent can spawn subagents seated by any role.
- Interactive chat, scheduled prompts and manually created conversations are the ways into conversations.
- The operator can see which role is working where.

## Exclusions

What this specification explicitly does NOT cover:

- **Hierarchical agent architectures.** Rejected alternatives: an overlord bob that owns gp subagents, bob as a
  default that channels address around, and a single long-lived coordinator conversation. Roles are peers that take
  turns in a conversation. None of them owns another or owns the conversation.
- **Memory across scheduled runs.** Every fire starts a new conversation. Continuing one conversation per schedule
  entry, as the proof of concept did, is rejected.
- **A new conversation per agent handoff.** A handoff never creates a conversation. A clean start inside the same
  conversation is the Fresh mode (R-6). Only subagents create conversations.
- **What happens when work ends, and job tracking.** Completion criteria, what a finished job leaves behind, a job
  object that tracks ongoing work, and the worklog are left to a later spec. That spec will define a job object
  (possibly an internal database of ongoing tasks). This spec defines only that a subagent's result reaches the
  conversation that spawned it.
- **Policy rules of any kind.** v1 runs an allow-all policy. Rules per role and the allow/ask policy are left to the
  policy spec.
- **Email triage.** Covered by a later spec.
- **Operator edits to role instructions or tools.** In v1 the operator sets only each role's default model and
  default workspace. Editing instructions is planned for a later version.
- **Creating, removing or renaming roles.** v1 has exactly bob and gp.
- **Adding skills other than through a workspace.** Shipped role skills are fixed. Operator skills come only from a
  workspace. Other overlay mechanisms are out.
- **Other `bob chat` options.** In v1, chat is a window onto the root conversation. Attaching chat to another
  conversation and choosing the role when chat starts are out. Switching the seated role inside the chat is in
  (R-4). Creating and resetting conversations is in, outside chat (R-11).
- **Model or workspace per schedule entry.** Whether a schedule entry can name a model or workspace other than its
  role's defaults is an open question, deferred. In v1 a fire runs with the named role's defaults.
- **Process and concurrency model.** Whether agent work runs on one event loop, a pool of workers or something
  else, and what a "slot" is technically, belong to the daemon and host-runtime spec. This spec states only the
  observable caps (R-9, R-10).
- **Technology choices.** The control protocol, client transport, storage layout, config file format and process
  model belong to the daemon, control-endpoint and packaging specs. This spec states behaviour only.

## Architecture

### Design Principles

- **One seated role per conversation.** At any moment a conversation has exactly one role, and every model turn
  runs with that seat's model, instructions, tools, skills and workspace. Nothing in a turn mixes two seats.
- **Roles are starting points.** A role supplies instructions, tools and shipped skills, which are fixed, plus a
  default model and a default workspace. Each seat may run a different model or registered workspace than the
  role's defaults, and changing a role's defaults affects only seats made after the change.
- **Roles are peers, not owners.** Any role can be seated in any conversation, hand off to any role and spawn
  subagents seated by any role. No role is privileged except that bob is the default seat.
- **A role is configuration, not a process.** Seating or switching a role changes stored per-conversation
  configuration only. No process or connection is tied to a role.
- **The seat carries the workspace.** The workspace is part of the seated agent's configuration, so changing the
  seat can change the workspace. A conversation has no workspace apart from its seat.
- **Workspaces are verified once, when registered.** Only registered workspaces can be used. Registration checks
  them, and use doesn't re-validate beyond noticing that a folder has disappeared.
- **Every role change is visible and durable.** Each seat change, reset, handoff and subagent spawn is recorded in
  the transcript or the conversation's metadata, survives a daemon restart, and appears in monitoring without a
  model having to describe it.
- **Unattended by default.** Outside interactive chat, no step waits for a human. Handoffs and subagents proceed on
  agent decisions alone.
- **Bounded delegation.** Subagent depth and the amount of simultaneous agent work are capped, so no chain of
  unattended agents can grow without limit.

### System Diagram

```
 entry points                       conversations (one database)                 roles (catalog)
┌──────────────────┐   submit    ┌────────────────────────────────────┐  seat   ┌──────────────────┐
│ bob chat ────────┼────────────►│ root conversation    [seat: bob]   │◄────────┤ bob  (default)   │
│ (root only)      │             │                                    │         │  instr., tools,  │
├──────────────────┤             │ conversation #k      [seat: gp]    │         │  skills, default │
│ scheduled prompt │──new conv──►│   ├─ subagent #m     [seat: bob]   │         │  model+workspace*│
│ (entry names a   │             │   │    └─ subagent … [seat: any]   │         ├──────────────────┤
│  role)           │             │   └─ handoff / reset: same conv,   │         │ gp               │
├──────────────────┤             │      new seat, clean or kept ctx   │         │  instr., tools,  │
│ user: new / reset│──new conv──►│                                    │         │  skills, default │
│ conversation     │             │                                    │         │  model+workspace*│
└──────────────────┘             └──────┬───────────────▲─────────────┘         └──────────────────┘
                                        │ role-attributed│ seat change, reset,   * operator-set; a seat
                                        ▼ transcript     │ steer, spawn            may override both
                                 ┌──────────────┐  ┌─────┴───────────────┐      (registered workspaces)
                                 │ monitoring   │  │ agent coordination  │
                                 │ (list, tree, │  │ (handoff, subagent, │
                                 │  live view)  │  │  steer) + caps      │
                                 └──────────────┘  └─────────────────────┘
```

### Responsibility Separation

| Component | Responsibility | Notes |
|---|---|---|
| Role catalog | Defines the predefined roles and their defaults, and holds the registered workspaces | Read-only in v1, apart from default models and workspace registration |
| Seating | Applies a role to a conversation, with optional model and workspace overrides, and records who seated it | The only path that changes a conversation's seat |
| Role prompt | Builds what the seated model sees: bob's preamble, role instructions, role skills, workspace instructions and workspace skills | Must stay byte-stable while the seat is unchanged |
| Agent coordination | Agent-callable handoff, spawn-subagent and steer capabilities, and enforcement of the nesting and concurrency caps | Every role is offered the same coordination capabilities |
| Entry routing | Connects chat to the root conversation, turns scheduled prompts into new conversations, and handles new and reset requests from the user | Holds no channel knowledge beyond choosing the conversation and the role |
| Monitoring | Lists conversations, seats, origins, the subagent tree and live transcripts | Read-only. Abort, reset and steer go through other components |

## Components

### Component 1: Role catalog

**Purpose:** Hold the two predefined roles (bob, gp) with their default model and default workspace, and the
operator's registered workspaces, each checked when it is registered.
**Estimated size:** Small.
**Interfaces:** Exposes role lookup and listing, and workspace lookup and listing. Consumes operator settings and
pi's default model.

### Component 2: Seating

**Purpose:** Seat a role in a conversation, with optional model and workspace overrides, so that later turns use
that seat, and record the change.
**Estimated size:** Small to medium.
**Interfaces:** Exposes "seat role R in conversation C, by actor A, optionally with model M and workspace W".
Consumes the role catalog and pi-durable's per-conversation agent configuration.

### Component 3: Role prompt

**Purpose:** Render the seated role's system prompt: bob's preamble, the role's instructions, the role's shipped
skills, plus the workspace's `AGENTS.md`/`CLAUDE.md` and the workspace's skills.
**Estimated size:** Medium.
**Interfaces:** Exposes prompt sections to the harness. Consumes the role catalog and the files in the workspace.

### Component 4: Agent coordination

**Purpose:** Give every role three agent-callable capabilities (hand off the current conversation, spawn a
subagent, steer another conversation) and enforce the nesting and concurrency caps.
**Estimated size:** Medium to large. The concurrency cap depends on the process model the daemon spec chooses.
**Interfaces:** Exposes agent tools. Consumes seating, conversation reset and compaction, conversation creation,
and the inbox of the target conversation.

### Component 5: Entry routing

**Purpose:** Make sure the root conversation exists and is seated by bob. Attach chat to it. Turn each scheduled
fire into a new conversation. Serve the user's requests to create and reset conversations.
**Estimated size:** Small.
**Interfaces:** Exposes "submit to root", "start a conversation with role R, origin O" and "reset conversation C".
Consumes seating and the role catalog.

### Component 6: Monitoring

**Purpose:** Let the operator see every conversation: its seat (role, model, workspace), origin, status, parent
and subagents, and transcript, live while it runs.
**Estimated size:** Medium.
**Interfaces:** Exposes list, tree, transcript and live-follow views to the CLI (and later a GUI). Consumes the
conversation store and its observation streams.

## Behavioural Requirements

Each requirement is checked as described in **Verification** below.

### Roles and workspaces

- **R-1 Predefined roles.** bob ships exactly two roles, `bob` and `gp`. Each has a name, instructions, a tool
  set, a shipped skill set (possibly empty), a default model and a default workspace. `bob` is the default seat.
- **R-2 Role differences in v1.** bob and gp differ only in their instructions, tool set and shipped skills.
  - **bob** is the conversational main entry point. Its instructions direct it to understand what the user or the
    prompt asks, identify the job to be done, and either do it or hand it to a better-suited role or subagent.
  - **gp** is a general-purpose task executor. Its instructions and shipped skills describe how to carry out a task
    to completion.
  - Both roles are offered the coordination capabilities (R-6 to R-8). The exact text of the instructions, the tool
    lists and gp's skill content are set during implementation and may change in later versions without amending
    this spec. They must satisfy the descriptions above.
- **R-3 Operator settings.** The operator can set each role's default model and default workspace, and register
  workspaces. Nothing else about a role can be set.
  - A role without a configured default model uses pi's default model.
  - A role without a configured default workspace uses a default workspace that bob creates and registers for that
    role, owner-only, under bob's own data location.
  - Changing a role's defaults affects only seats made after the change. Conversations already seated keep their
    model and workspace.
- **R-3a Workspace registration.** A workspace is a local folder: the files an agent can reach, extra instructions
  (`AGENTS.md`), workspace skills and scratch space. A folder can be used as a workspace only after the operator
  registers it.
  - Registration checks that the path is absolute, exists, is a directory and is owner-only.
  - A registration that fails the check is refused with an error naming the path and the reason. If the failure
    comes from configuration loaded at startup, the daemon doesn't start.
  - A role's default workspace must be a registered workspace.

### Seating, overrides and handoff

- **R-4 Switching by the user.** The user can change the seat of any conversation at any time, including the root
  conversation from inside `bob chat`.
  - The new seat names a role, and may name a model and a registered workspace other than that role's defaults.
  - The change applies from the next model turn. A turn already running finishes with the seat it started with,
    unless the user also aborts or steers it.
- **R-5 Seat effects.** After a seat is applied, every model turn in that conversation:
  - uses the seat's model
  - sees the role's instructions and shipped skills
  - is offered exactly the role's tools
  - runs its tools in the seat's workspace
  - sees that workspace's instructions and skills

  Nothing of the previous seat's instructions, skills or workspace stays in the system prompt. The transcript
  stays visible to the new seat unless a Fresh handoff or a reset (R-11) cleared the context.
- **R-6 Handoff by an agent.** The seated agent can hand its conversation to another role. A handoff happens because
  the user or another agent asked for it in a prompt, or because the agent decides to. No human confirms it.
  - The handing-off agent may name a model and a registered workspace other than the target role's defaults.
  - It chooses one of three modes. In every mode the conversation stays the same and only the seat and the
    context change:
    1. **Continue.** The target role is seated and processes the full context.
    2. **Compact.** The context is compacted using a handoff note the agent writes, the target role is seated, and
       it continues from the compacted context.
    3. **Fresh.** The conversation's context is reset, the target role is seated, and the model gets a clean
       context whose only input is the agent's handoff note. Earlier entries stay in the stored transcript and in
       monitoring, but the model no longer sees them.
  - In every mode the target role starts working without any new input from outside the conversation.
- **R-7 Seat records.** Every seat change shows in the transcript. The record names:
  - the previous seat and the new seat (role, model, workspace)
  - the actor: the user, the role that handed off, or an entry point
  - for a handoff, the mode, and the handoff note when there is one

  Every assistant message is attributed to the seat that produced it.

### Subagents, caps and steering

- **R-8 Subagents.** Any seated agent can spawn a subagent: a child conversation seated by any role, optionally with
  a model and a registered workspace other than the role's defaults, and given a task prompt.
  - Subagents follow every rule in this spec, so they can hand off and spawn their own subagents.
  - The spawning agent chooses either to **wait** for the result, which then comes back as the outcome of the spawn,
    or to **continue**, in which case the result is delivered into the spawning conversation as a new input when
    the subagent finishes.
  - Aborting a conversation aborts all of its subagents, recursively.
- **R-9 Nesting cap.** Subagents may nest only to a maximum depth. A conversation started by an entry point or by
  the user has depth 0, and a subagent has its parent's depth plus one.
  - A spawn that would exceed the cap is refused. The spawning agent gets an error result that names the cap, and
    its run continues.
  - Handoffs and resets don't change depth.
- **R-10 Concurrency cap.** At most a fixed number of agent runs are active at the same time, counted across every
  origin: root, schedule fires, user-created conversations and subagents.
  - Work beyond the cap waits in arrival order and starts when capacity frees. It is not dropped.
  - A conversation whose only activity is waiting for its own subagents doesn't count against the cap. This means
    the cap can never deadlock a parent against its children.
  - Monitoring shows waiting work as "waiting for capacity".
- **R-10a Steering.** The user, and any agent, can steer a running conversation by injecting a message that the
  running turn picks up after its current tool round. The message can be queued as a follow-up instead. An agent
  steers through a coordination capability that names the target conversation. The transcript records who
  steered.

### Entry points

- **R-11 Conversations created and reset by the user.** Outside chat, the user can:
  - create a new conversation, seated by a chosen role (default `bob`), optionally with a model and a registered
    workspace other than its defaults, and give it a first prompt
  - reset any existing conversation: its context is cleared for the model, earlier entries stay in the stored
    transcript, and the seat is kept unless the reset names a new one

  Resetting the root conversation is allowed and doesn't replace it.
- **R-12 Root conversation.** The root conversation exists from the first daemon start, seated by `bob`, and is
  never replaced. `bob chat` is an interactive window onto it: what you type is submitted to it, and its output is
  shown live. Several chat windows on the root see the same conversation.
- **R-13 Scheduled prompts.** Each fire of a scheduled prompt starts a new conversation. Scheduled runs keep no
  memory between fires.
  - The conversation is seated by the role the schedule entry names (`bob` when the entry names none), with that
    role's defaults.
  - The prompt is its first input, and its origin records the schedule entry and the fire time.
  - An entry that names an unknown role is rejected when schedules are loaded and never fires.
  - If the seat's workspace folder no longer exists at fire time, the fire doesn't run. The skip is recorded with
    the entry, the fire time and the missing path, and no conversation is created.
- **R-14 Unattended runs.** A conversation not attached to an interactive chat never waits for a human. In v1
  there is no step that could make it wait, because the policy is allow-all and no confirmation exists for
  handoffs or subagents.
- **R-15 Missing workspace during a run.** If a seat's workspace folder disappears while a conversation uses it,
  tool calls that need the workspace fail as ordinary tool errors that the agent sees. The daemon keeps running.

### Monitoring and durability

- **R-16 Monitoring.** The operator can do all of the following without the daemon interrupting any running work:
  - list all conversations with id, seat (role, model, workspace), origin (root, schedule entry and fire, user,
    subagent of), status (running, idle or waiting for capacity) and last activity
  - show the subagent tree of a conversation
  - read a transcript with seat records and attribution (R-7), including entries from before a reset
  - follow a running conversation live
- **R-17 Durability.** Seats, seat records, resets, subagent relationships, depth and origins survive a daemon kill
  and restart. A seat change, handoff, reset or spawn interrupted by a crash either completed before the crash or
  completes on resume. It is never half-applied: never a new seat without its record, and never a subagent without
  its parent link. Work waiting for capacity is still waiting after the restart, in the same order.

## Workflow

Scheduled prompt, from fire to delegated work:

```
Schedule entry fires (role named, default bob)
  ↓
Workspace of the seat missing? → fire skipped and recorded; stop
  ↓
Entry routing creates a new conversation, origin = schedule entry + fire time, seats the role with its defaults
  ↓
Waits for capacity if the concurrency cap is reached
  ↓
Seated role reads the prompt and identifies the job
  ↓
Either: does the job itself
    or: hands off (continue / compact / fresh) to another role  → that role continues unattended, same conversation
    or: spawns subagent(s), waits or continues                   → results come back as outcome or new input
                                                                   (refused beyond the nesting cap)
  ↓
Run ends (what "done" means and what is recorded beyond the transcript: later job spec)
```

Interactive chat:

```
★ User opens bob chat → attached to the root conversation (seat shown)
  ↓
★ User types → submitted to root; while busy, input queues as follow-up or steers
  ↓
★ User may switch the seat (role, model, workspace) at any time; applies from the next turn
  ↓
Seated agent may hand off or spawn subagents exactly as in the scheduled flow
```

## Configuration Requirements

- **Default model per role.**
  - **What:** an optional default model for `bob` and one for `gp`, so a cheaper or stronger model can be the
    starting point per role.
  - **Where:** bob's operator configuration (described in the daemon spec).
  - **Constraints:** must name a model that the pi login and model registry can resolve.
  - **Missing:** falls back to pi's default model. A configured model that can't be resolved stops the daemon at
    startup with an error naming the role and the model. A model override at seat time that can't be resolved is
    refused, and the seat stays unchanged.
- **Registered workspaces.**
  - **What:** the folders that may be used as workspaces.
  - **Where:** bob's operator configuration, plus the per-role default workspaces bob creates.
  - **Constraints:** an absolute, existing, owner-only directory (trusted input), checked at registration (R-3a).
    The operator is responsible for what parent directories contribute, because `AGENTS.md` files are also read
    from parent directories.
  - **Missing:** only the per-role default workspaces exist. A registration that fails the check stops the daemon
    at startup.
- **Default workspace per role.**
  - **What:** an optional registered workspace for `bob` and one for `gp`.
  - **Where:** bob's operator configuration.
  - **Constraints:** must be a registered workspace.
  - **Missing:** the per-role default workspace bob creates. A reference to an unregistered workspace stops the
    daemon at startup.
- **Role in a schedule entry.**
  - **What:** an optional role name per schedule entry.
  - **Where:** the operator's schedule store.
  - **Constraints:** `bob` or `gp`.
  - **Missing:** `bob`. An unknown name rejects the entry (R-13).
- **Subagent nesting cap.**
  - **What:** the maximum subagent depth (R-9). It bounds runaway delegation chains that no human is watching.
  - **Where:** bob's operator configuration.
  - **Constraints:** a positive integer.
  - **Missing:** a built-in default. The exact default value is decided later, before the task breakdown of
    Phase 3, and recorded in this spec through an amendment. An invalid value stops the daemon at startup.
- **Concurrency cap.**
  - **What:** the maximum number of active agent runs (R-10). It bounds model spend and local load.
  - **Where:** bob's operator configuration.
  - **Constraints:** a positive integer.
  - **Missing:** a built-in default, decided at the same point as the nesting cap and together with the daemon
    spec's process model. An invalid value stops the daemon at startup.
- **Live test model.**
  - **What:** the model used by the live acceptance tests.
  - **Where:** a test-only setting.
  - **Constraints:** a low-cost OpenAI model available through the operator's existing pi login. No credentials are
    stored in the repository or the state dir.
  - **Missing:** live tests are skipped with a visible notice. Deterministic tests still run.

## Verification

- **Deterministic tests** use a fake model whose replies are a pure function of the transcript. They cover:
  - seat effects (R-4, R-5), including overrides, and that changing a role's defaults leaves existing seats alone
  - each handoff mode (R-6): after Fresh, the model's context contains only the handoff note while the stored
    transcript keeps every entry
  - seat records (R-7)
  - wait and continue subagents, and recursive abort (R-8)
  - steering (R-10a)
  - R-9 and R-10: a spawn at the nesting cap is refused while the parent continues; with the concurrency cap set
    to 1, a parent waiting on its subagent doesn't deadlock; waiting work starts in arrival order
  - R-3a: registration accepts a valid folder and refuses a relative, missing, non-directory or group- or
    world-accessible path
  - R-11 to R-13: create and reset; the root is seated by bob; fires create seated conversations with their origin;
    a fire whose workspace is missing is skipped and recorded
  - R-15: a removed workspace produces a tool error and the daemon keeps running
  - R-16: list, tree and transcript content
  - R-17: a test kills the daemon during a seat change, a Fresh handoff, a subagent spawn and while work waits for
    capacity, then checks the invariants after restart
- **Live acceptance tests** run against the operator's pi-configured OpenAI account with a low-cost model:
  1. A scheduled prompt seated by bob that asks for a simple file task in gp's workspace. bob hands off to gp or
     spawns a gp subagent, the file appears in gp's workspace, and the transcript shows the seat change.
  2. In `bob chat`, switch the root conversation from bob to gp. The next answer is attributed to gp, and gp's tools
     run in gp's workspace.
  3. A gp agent spawns a bob subagent with "continue" and later receives the result as new input.
- **Prompt stability:** with the seat unchanged, two consecutive turns produce byte-identical system prompt
  sections.

## Implementation Order

This spec relies on the daemon and host-runtime spec for the database, startup, configuration and process model,
and on the control-endpoint spec for the surfaces chat and monitoring use. Its phases can be developed against a
minimal host until those exist.

| Phase | What | Depends On |
|---|---|---|
| 1 | Role catalog, workspace registration, seating with overrides and role prompt: root conversation seated by bob; user switches the seat; user creates and resets conversations; seat records and attribution | Daemon and host runtime |
| 2 | Handoff by agents in all three modes | Phase 1 |
| 3 | Subagents (wait and continue), recursive abort, steering by agents, nesting cap | Phase 1 |
| 4 | Concurrency cap | Phase 3, daemon spec's process model |
| 5 | Entry points: chat as a window onto root; schedule entries name a role, with the missing-workspace skip. Monitoring: list, tree, live transcript | Phases 1–3, control endpoint |

## Amendment Log
