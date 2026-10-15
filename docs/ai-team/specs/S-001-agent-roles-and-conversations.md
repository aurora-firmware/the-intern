---
title: Agent roles and conversations
version: '0.1'
status: review  # draft | review | approved | superseded
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
agents that act as interchangeable **roles**: each brings its own instructions, tools, model and workspace, and
any of them can take over a conversation whenever the state of the work calls for it.

When this spec is done:

- bob ships two predefined roles, **bob** and **gp**.
- Every conversation has exactly one seated role at a time.
- The user or an agent can hand a conversation to another role at any time.
- Any agent can spawn subagents seated by any role.
- Interactive chat and scheduled prompts are both entry points onto conversations.
- The operator can see which role is working where.

## Exclusions

What this specification explicitly does NOT cover:

- **Hierarchical agent architectures.** Rejected alternatives: an overlord bob that owns gp subagents, bob as a
  default that channels address around, and a single long-lived coordinator conversation. Roles are peers that take
  turns in a conversation. None of them owns another or owns the conversation.
- **What happens when work ends, and job tracking.** Completion criteria, what a finished job leaves behind, a job
  object that tracks ongoing work, and the worklog are left to a later spec. That spec will define a job object
  (possibly an internal database of ongoing tasks). This spec defines only that a subagent's result reaches the
  conversation that spawned it.
- **Policy rules of any kind.** v1 runs an allow-all policy. Rules per role and the allow/ask policy are left to the
  policy spec.
- **Email triage.** Covered by a later spec.
- **Operator edits to role instructions or tools.** In v1 the operator sets only each role's model and workspace.
  Editing instructions is planned for a later version.
- **Creating, removing or renaming roles.** v1 has exactly bob and gp.
- **Adding skills other than through a workspace.** Shipped role skills are fixed. Operator skills come only from a
  role's workspace. Other overlay mechanisms are out.
- **Other `bob chat` options.** In v1, chat is a window onto the root conversation. Opening a new conversation,
  attaching to another conversation and choosing the role at start are out. Switching the seated role inside the
  chat is in (see R-4).
- **Workspace overrides for autonomous work.** Whether a scheduled prompt may run in a workspace other than its
  role's is an open question, deferred. In v1 a conversation always works in the seated role's workspace.
- **Technology choices.** The control protocol, client transport, storage layout, config file format and process
  model belong to the daemon, control-endpoint and packaging specs. This spec states behaviour only.

## Architecture

### Design Principles

- **One seated role per conversation.** At any moment a conversation has exactly one role, and every model turn
  runs with that role's model, instructions, tools, skills and workspace. Nothing in a turn mixes two roles.
- **Roles are peers, not owners.** Any role can be seated in any conversation, hand off to any role and spawn
  subagents seated by any role. No role is privileged except that bob is the default seat.
- **A role is configuration, not a process.** Seating or switching a role changes stored per-conversation
  configuration only. No process, worker or connection is started per role or per conversation.
- **The role carries the workspace.** The workspace is part of the role's agent configuration, so switching the
  role switches the workspace. A conversation has no workspace of its own.
- **Every role change is visible and durable.** Each seat change, handoff and subagent spawn is recorded in the
  transcript or the conversation's metadata, survives a daemon restart, and appears in monitoring without a model
  having to describe it.
- **Unattended by default.** Outside interactive chat, no step waits for a human. Handoffs and subagents proceed on
  agent decisions alone.
- **Role content is release-owned.** The roles, their instructions, their tool sets and their shipped skills come
  with the installed bob version. Operator settings never alter them in v1 (model and workspace aside).

### System Diagram

```
 entry points                       conversations (one database)                 roles (catalog)
┌──────────────────┐   submit    ┌────────────────────────────────────┐  seat   ┌──────────────────┐
│ bob chat ────────┼────────────►│ root conversation    [seat: bob]   │◄────────┤ bob  (default)   │
│ (root only)      │             │                                    │         │  model*, instr., │
├──────────────────┤             │ conversation #k      [seat: gp]    │         │  tools, skills,  │
│ scheduled prompt │──new conv──►│   ├─ subagent #m     [seat: bob]   │         │  workspace*      │
│ (entry names a   │             │   │    └─ subagent … [seat: any]   │         ├──────────────────┤
│  role)           │             │   └─ handoff note ──► conv #n      │         │ gp               │
└──────────────────┘             └──────┬───────────────▲─────────────┘         │  model*, instr., │
                                        │ role-attributed│ seat change,         │  tools, skills,  │
                                        ▼ transcript     │ steer, spawn         │  workspace*      │
                                 ┌──────────────┐  ┌─────┴───────────────┐      └──────────────────┘
                                 │ monitoring   │  │ agent coordination  │   * operator-set in v1
                                 │ (list, tree, │  │ (handoff, subagent, │
                                 │  live view)  │  │  steer)             │
                                 └──────────────┘  └─────────────────────┘
```

### Responsibility Separation

| Component | Responsibility | Notes |
|---|---|---|
| Role catalog | Defines the predefined roles and resolves each one's effective model and workspace from the operator's settings | Read-only in v1, apart from the model and workspace settings |
| Seating | Applies a role to a conversation and records who seated it and when | The only path that changes a conversation's role |
| Role prompt | Builds what the seated role's model sees: bob's preamble, role instructions, role skills, workspace instructions and workspace skills | Must stay byte-stable while the seat and workspace are unchanged |
| Agent coordination | Agent-callable handoff, spawn-subagent and steer capabilities | Every role is offered the same coordination capabilities |
| Entry routing | Connects chat to the root conversation, and scheduled prompts to new conversations seated by the entry's role | Holds no channel knowledge beyond choosing the conversation and the role |
| Monitoring | Lists conversations, seats, origins, the subagent tree and live transcripts | Read-only. Abort and steer go through coordination |

## Components

### Component 1: Role catalog

**Purpose:** Hold the two predefined roles (bob, gp) and resolve each one's model and workspace from operator
settings, falling back to defaults.
**Estimated size:** Small.
**Interfaces:** Exposes role lookup by name and the list of roles. Consumes operator settings and pi's default
model.

### Component 2: Seating

**Purpose:** Seat a role in a conversation, so that later turns use that role's model, instructions, tools,
skills and workspace, and record the change.
**Estimated size:** Small to medium.
**Interfaces:** Exposes "seat role R in conversation C, by actor A". Consumes the role catalog and pi-durable's
per-conversation agent configuration.

### Component 3: Role prompt

**Purpose:** Render the seated role's system prompt: bob's preamble, the role's instructions, the role's shipped
skills, plus the workspace's `AGENTS.md`/`CLAUDE.md` and the workspace's skills.
**Estimated size:** Medium.
**Interfaces:** Exposes prompt sections to the harness. Consumes the role catalog and the files in the workspace.

### Component 4: Agent coordination

**Purpose:** Give every role three agent-callable capabilities: hand off the current conversation, spawn a
subagent, and steer another conversation.
**Estimated size:** Medium.
**Interfaces:** Exposes agent tools. Consumes seating, conversation creation and compaction, and the inbox of the
target conversation.

### Component 5: Entry routing

**Purpose:** Make sure the root conversation exists and is seated by bob. Attach chat to it. Turn each scheduled
fire into a new conversation seated by the entry's role.
**Estimated size:** Small.
**Interfaces:** Exposes "submit to root" and "start a conversation for an entry point with role R and origin O".
Consumes seating and the role catalog.

### Component 6: Monitoring

**Purpose:** Let the operator see every conversation: its seated role, origin, status, parent and subagents,
handoff links and transcript, live while it runs.
**Estimated size:** Medium.
**Interfaces:** Exposes list, tree, transcript and live-follow views to the CLI (and later a GUI). Consumes the
conversation store and its observation streams.

## Behavioural Requirements

Each requirement is checked as described in **Verification** below.

### Roles

- **R-1 Predefined roles.** bob ships exactly two roles, `bob` and `gp`. Each has a name, a model, instructions, a
  tool set, a shipped skill set (possibly empty) and a workspace. `bob` is the default seat.
- **R-2 Role differences in v1.** bob and gp differ only in their instructions, tool set and shipped skills.
  - **bob** is the conversational main entry point. Its instructions direct it to understand what the user or the
    prompt asks, identify the job to be done, and either do it or hand it to a better-suited role or subagent.
  - **gp** is a general-purpose task executor. Its instructions and shipped skills describe how to carry out a task
    to completion.
  - Both roles are offered the coordination capabilities (R-6 to R-9). The exact text of the instructions, the tool
    lists and gp's skill content are set during implementation and may change in later versions without amending
    this spec. They must satisfy the descriptions above.
- **R-3 Operator settings.** The operator can set each role's model and workspace, and nothing else about a role.
  - A role without a configured model uses pi's default model.
  - A role without a configured workspace uses a default workspace that bob creates for that role, owner-only,
    under bob's own data location.

### Seating and handoff

- **R-4 Switching by the user.** The user can change the seated role of any conversation at any time.
  - This includes the root conversation from inside `bob chat`.
  - The change applies from the next model turn. A turn already running finishes with the role it started with,
    unless the user also aborts or steers it.
- **R-5 Seat effects.** After a role is seated, every model turn in that conversation:
  - uses the role's model
  - sees the role's instructions and shipped skills
  - is offered exactly the role's tools
  - runs its tools in the role's workspace
  - sees that workspace's instructions and skills

  Nothing of the previous role's instructions, skills or workspace stays in the system prompt. The transcript
  carries over, which includes earlier tool results.
- **R-6 Handoff by an agent.** The seated agent can hand its conversation to another role. A handoff happens because
  the user or another agent asked for it in a prompt, or because the agent decides to. No human confirms it. The
  handing-off agent chooses one of three modes:
  1. **Continue.** The target role is seated in the same conversation and processes the full transcript.
  2. **Compact.** The conversation is compacted using a handoff note the agent writes, the target role is seated, and
     it continues from the compacted context.
  3. **Fresh.** A new conversation is created, seated by the target role, whose first input is the agent's handoff
     note. The original conversation records a link to the new one, and the new one records where it came from.

  In every mode the target role starts working without further input, in the same run where possible.
- **R-7 Handoff records.** Every seat change shows in the transcript. The record names the previous role, the new
  role, the actor (the user, the role that handed off, or an entry point), the mode and, when there is one, the
  handoff note. Every assistant message is attributed to the role that produced it.

### Subagents and steering

- **R-8 Subagents.** Any seated agent can spawn a subagent: a child conversation seated by any role, given a task
  prompt.
  - Subagents follow every rule in this spec. They can hand off and spawn their own subagents, and they always work
    in their seated role's workspace.
  - The spawning agent chooses either to **wait** for the result, which then comes back as the outcome of the spawn,
    or to **continue**, in which case the result is delivered into the spawning conversation as a new input when
    the subagent finishes.
  - Aborting a conversation aborts all of its subagents, recursively.
- **R-9 Steering.** The user, and any agent, can steer a running conversation by injecting a message that the
  running turn picks up after its current tool round. The message can be queued as a follow-up instead. An agent
  steers through a coordination capability that names the target conversation. The transcript records who
  steered.

### Entry points

- **R-10 Root conversation.** The root conversation exists from the first daemon start, seated by `bob`, and is
  never replaced. `bob chat` is an interactive window onto it: what you type is submitted to it, and its output is
  shown live. Several chat windows on the root see the same conversation.
- **R-11 Scheduled prompts.** Each fire of a scheduled prompt starts a new conversation.
  - The conversation is seated by the role the schedule entry names, or `bob` when the entry names none.
  - The prompt is its first input, and its origin records the schedule entry and the fire time.
  - An entry that names an unknown role is rejected when schedules are loaded, with the same validation error
    surface as other invalid entries, and never fires.
- **R-12 Unattended runs.** A conversation started by an entry point other than chat never waits for a human. In
  v1 there is no step that could make it wait, because the policy is allow-all and no confirmation exists for
  handoffs or subagents.

### Monitoring and durability

- **R-13 Monitoring.** The operator can do all of the following without the daemon interrupting any running work:
  - list all conversations with id, seated role, origin (root, schedule entry and fire, handoff from, subagent of),
    running or idle status, and last activity
  - show the subagent tree of a conversation
  - read a transcript with role attribution (R-7)
  - follow a running conversation live
- **R-14 Durability.** Seats, seat-change records, handoff links, subagent relationships and origins survive a
  daemon kill and restart. A handoff or spawn interrupted by a crash either completed before the crash or completes
  on resume. It is never half-applied: never a new role seated without its record, and never a fresh conversation
  without its link.

## Workflow

Scheduled prompt, from fire to delegated work:

```
Schedule entry fires (role named, default bob)
  ↓
Entry routing creates a new conversation, origin = schedule entry + fire time, seats the role
  ↓
Seated role reads the prompt and identifies the job
  ↓
Either: does the job itself
    or: hands off (continue / compact / fresh) to a better-suited role   → that role continues unattended
    or: spawns subagent(s) seated by any role, waits or continues        → results come back as outcome or new input
  ↓
Run ends (what "done" means and what is recorded beyond the transcript: later job spec)
```

Interactive chat:

```
★ User opens bob chat → attached to the root conversation (seated role shown)
  ↓
★ User types → submitted to root; while busy, input queues as follow-up or steers
  ↓
★ User may switch the seated role at any time (applies from the next turn)
  ↓
Seated agent may hand off or spawn subagents exactly as in the scheduled flow
```

## Configuration Requirements

- **Model per role.**
  - **What:** an optional model for `bob` and one for `gp`, so a cheaper or stronger model can be used per role.
  - **Where:** bob's operator configuration (described in the daemon spec).
  - **Constraints:** must name a model that the pi login and model registry can resolve.
  - **Missing:** falls back to pi's default model. A configured model that can't be resolved stops the daemon at
    startup with an error naming the role and the model.
- **Workspace per role.**
  - **What:** an optional folder for `bob` and one for `gp`, which is where that role's tools run and its workspace
    instructions and skills come from.
  - **Where:** bob's operator configuration.
  - **Constraints:** an absolute path, owner-only (trusted input). The operator is responsible for what parent
    directories contribute, because `AGENTS.md` files are also read from parent directories.
  - **Missing:** a default per-role workspace that bob creates, owner-only, under its data location. A configured
    path that doesn't exist or isn't a directory stops the daemon at startup with an error naming the role and the
    path.
- **Role in a schedule entry.**
  - **What:** an optional role name per schedule entry.
  - **Where:** the operator's schedule store.
  - **Constraints:** `bob` or `gp`.
  - **Missing:** `bob`. An unknown name rejects the entry (R-11).
- **Live test model.**
  - **What:** the model used by the live acceptance tests.
  - **Where:** a test-only setting.
  - **Constraints:** a low-cost OpenAI model available through the operator's existing pi login. No credentials are
    stored in the repository or the state dir.
  - **Missing:** live tests are skipped with a visible notice. Deterministic tests still run.

## Verification

- **Deterministic tests** use a fake model whose replies are a pure function of the transcript. They cover:
  - R-4 to R-9 mechanics: seat effects on model, tools, prompt and workspace; each handoff mode; records and links;
    wait and continue subagents; recursive abort; steering
  - R-10 and R-11: the root is seated by bob, and schedule fires create seated conversations with their origin
  - R-13: the list, tree and transcript content
  - R-14: a test kills the daemon during a handoff and during a subagent spawn, then checks the invariants after
    restart
- **Live acceptance tests** run against the operator's pi-configured OpenAI account with a low-cost model:
  1. A scheduled prompt seated by bob that asks for a simple file task in gp's workspace. bob hands off to gp or
     spawns a gp subagent, the file appears in gp's workspace, and the transcript shows the role change.
  2. In `bob chat`, switch the root conversation from bob to gp. The next answer is attributed to gp, and gp's tools
     run in gp's workspace.
  3. A gp agent spawns a bob subagent with "continue" and later receives the result as new input.
- **Prompt stability:** with the seat and workspace unchanged, two consecutive turns produce byte-identical system
  prompt sections.

## Implementation Order

This spec relies on the daemon and host-runtime spec for the database, startup and configuration, and on the
control-endpoint spec for the surfaces chat and monitoring use. Its phases can be developed against a minimal host
until those exist.

| Phase | What | Depends On |
|---|---|---|
| 1 | Role catalog, seating and role prompt: root conversation seated by bob; user switches the seat; model and workspace per role; role attribution in transcripts | Daemon and host runtime |
| 2 | Handoff by agents in all three modes, with records and links | Phase 1 |
| 3 | Subagents (wait and continue), recursive abort, steering by agents | Phase 1 |
| 4 | Entry points: chat as a window onto root; schedule entries name a role. Monitoring: list, tree, live transcript | Phases 1–3, control endpoint |

## Amendment Log
