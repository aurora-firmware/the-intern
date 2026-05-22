# the-intern — architecture

High-level description of how **the-intern** is built. It refines the logical
model in [system_overview.md](./system_overview.md) into concrete structural
and technology decisions. It is not an implementation specification — see
`project/specs/` for that.

## Table of Contents

- [Overview](#overview)
- [Process topology](#process-topology)
- [Components](#components)
  - [Rust service](#rust-service)
  - [pi-agent processes](#pi-agent-processes)
  - [JS extension](#js-extension)
  - [Actions](#actions)
- [How channels trigger the agent](#how-channels-trigger-the-agent)
- [Security integration](#security-integration)
- [Monitoring integration](#monitoring-integration)
- [Technology stack](#technology-stack)
- [Key decisions](#key-decisions)
- [Open items](#open-items)

-----

## Overview

the-intern is a persistent, always-on assistant service. Users reach it through
several channels — interactive chat and asynchronous channels such as email,
webhooks, and scheduled tasks. Because asynchronous channels deliver events when
no user is present, the system runs as a long-lived service rather than a
per-session program.

The agent itself is run by **pi-agent**, embedded as the Agent Harness. Every
deterministic responsibility from the logical model — identity, authorization,
monitoring — lives outside the agent, in a separate service that the agent
cannot bypass.

## Process topology

The system is split across three kinds of process:

```text
+-------------------------------------------------------------+
| Rust service (single OS-agnostic binary)                    |
|                                                             |
|  Channel adapters -> Requests Handler -> Policy Control      |
|                              |              ^               |
|                              |              | verdict       |
|                       Monitoring            |               |
+----------+-------------------+---------------+---------------+
           | prompts                | Unix socket
           | (runRpcMode JSON-RPC)  | (auth verdicts, events)
           v                        |
+----------+------------------------+---------------+
| pi-agent process (one per active user-session)    |
|                                                   |
|   pi-agent runtime  <-->  JS extension            |
|         |                                         |
|         | bash tool                               |
+---------+-----------------------------------------+
          |
          v
   External CLI tools (Actions)
```

- The **Rust service** is the deterministic core and the only long-lived
  component. It supervises the pi-agent processes.
- Each **pi-agent process** runs one user-session's agent. Processes are spawned
  on demand, reaped when idle, and drawn from a small pre-warmed pool to hide
  spawn latency.
- The **JS extension** is loaded inside each pi-agent process and is the only
  TypeScript in the system. It is a thin membrane — it carries no policy logic.

## Components

### Rust service

A single binary that hosts the deterministic components from the logical model:

- **Channel adapters** — accept inbound traffic from chat, email, webhooks, and
  the scheduler, and normalize each into a common internal event.
- **Requests Handler** — pulls events from the inbound queue, attaches user and
  channel identity, and runs pre-flight identity/access checks before any agent
  work begins.
- **Policy Control** — the action-authorization decision logic. It answers
  per-user authorization queries raised mid-run by the agent.
- **Monitoring** — an append-only audit log, plus an inbound interface that
  external CLI tools can call to register the actions they took.

The Rust service also owns the inbound queue, identity, persistence, and
supervision of the pi-agent process pool.

### pi-agent processes

The Agent Harness. The Rust service runs **one pi-agent process per active
user-session**, which gives each user an isolated address space — a real
per-user data boundary that a shared process cannot provide. Idle processes are
reaped; a small pre-warmed pool absorbs spawn latency. Prompts are delivered to
each process from the Rust service over pi-agent's `runRpcMode()` JSON-RPC
channel.

### JS extension

Loaded inside every pi-agent process. It is a forwarder, not a decision-maker:

- Hosts pi-agent's blocking `tool_call` hook. On each tool call it forwards
  `(tool, arguments, user)` to the Rust service over a Unix socket, awaits an
  asynchronous verdict, and returns an allow/block result to pi-agent.
- Subscribes to pi-agent's event stream and forwards events to Monitoring.
- Provides skills to the agent.

All extension instances connect to the same Unix socket; messages are tagged
with a session identifier so the Rust service can multiplex them.

### Actions

Actions are **external CLI tools**. They are described to the agent through
**skills** — markdown instruction files that tell the agent when and how to use
each tool — and executed through pi-agent's built-in `bash` tool. Every `bash`
invocation passes through the extension's `tool_call` hook, so every action is
subject to Policy Control. Tools may additionally self-report the actions they
took to Monitoring through the provided interface.

## How channels trigger the agent

the-intern is event-driven, not session-driven. All channels — synchronous and
asynchronous alike — normalize their input into internal events on a shared
inbound queue. The Requests Handler consumes that queue, so an emailed request,
a webhook, a scheduled task, and a chat message all follow the same path. This
is why the system is a persistent service: asynchronous events must be handled
even when no user is connected.

## Security integration

Authorization is deterministic and enforced outside the agent:

- **Pre-flight** — the Requests Handler checks identity and access before the
  agent is involved at all.
- **Per-action** — when the agent attempts an action, the extension's
  `tool_call` hook blocks execution and asks Policy Control in the Rust service
  for a verdict. The agent cannot reach an external effect without a passing
  verdict, and it cannot modify the deterministic policy code.

This keeps the trust boundary intact: the extension inside the agent process is
only a courier; every decision is made in the Rust service.

## Monitoring integration

Monitoring receives records from two sources:

- The JS extension forwards pi-agent's event stream — turns, tool calls,
  results, failures.
- External CLI tools call Monitoring's inbound interface directly to register
  the actions they performed.

Monitoring writes an append-only audit log sufficient to reconstruct what
happened during a session or task.

## Technology stack

- **Rust** for the long-lived service — a single OS-agnostic binary, memory-safe
  for a long-running daemon, well suited to process supervision and concurrency.
- **pi-agent** (Node.js ≥20, TypeScript) as the Agent Harness, run as a
  supervised child process — never embedded in another language.
- **TypeScript** for the JS extension only — the minimum surface required,
  because pi-agent's hooks are an in-process API.
- **Unix socket** for the extension-to-service channel (session-tagged,
  multiplexed); **`runRpcMode()` JSON-RPC** for prompt delivery.
- External **CLI tools** for Actions, OS-agnostic by selection.

## Key decisions

- **Split topology over a single embedded process.** Deterministic components
  live in a Rust service the agent cannot bypass; the agent runs in supervised
  child processes.
- **Process per active user-session.** Chosen over one multiplexing process so
  each user has an isolated address space, satisfying the data-boundary and
  least-privilege principles. Idle reaping and a warm pool bound the cost.
- **Skills + CLI tools for Actions, no MCP.** pi-agent has no MCP client; actions
  are skills describing external CLIs, executed via the `bash` tool.
- **Authorization via the extension's blocking `tool_call` hook.** pi-agent's
  interception hooks are in-process only, so a thin in-process extension is
  required; it forwards every decision to the Rust service.
- **Monitoring is reachable by external tools.** Actions are separate processes,
  so Monitoring exposes an inbound interface they can call directly.

## Open items

- Confirm against the pi-agent source that the `tool_call` hook accepts an
  **asynchronous** blocking verdict. This is load-bearing for the security
  design and must be verified before or early in implementation.
- Confirm the prompt-delivery path: whether `runRpcMode()` is the right channel
  for injecting prompts, or whether the extension must also carry prompt input.
