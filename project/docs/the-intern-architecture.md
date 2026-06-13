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
- [Control plane / operability](#control-plane--operability)
- [Technology stack](#technology-stack)
- [Key decisions](#key-decisions)
- [Open items](#open-items)

-----

## Overview

the-intern is a persistent, always-on assistant service for a **single user on
their own machine**. The user reaches it through several channels — interactive
chat and asynchronous channels such as email and scheduled tasks. Because
asynchronous channels deliver events when no user is present, the system runs as
a long-lived service rather than a per-session program.

The agent itself is run by **pi-agent**, embedded as the Agent Harness. Every
deterministic responsibility from the logical model — identity, authorization,
monitoring — lives outside the agent, in a separate service that the agent
cannot bypass.

## Process topology

The system is split across a long-lived service, the agent processes it
supervises, and the short-lived `bob` CLI clients that drive it:

```text
   bob CLI  (operator commands, chat client)
        |
        | admin.sock — JSON-RPC 2.0, filesystem-perm + peer-cred gated
        v
+-------------------------------------------------------------+
| Rust service (single binary; Unix-likes: Linux and macOS)   |
|                                                             |
|  admin-rpc (control plane)                                  |
|                                                             |
|  Channel adapters -> Requests Handler -> Policy Control      |
|                              |              ^               |
|                              |              | verdict       |
|                       Monitoring            |               |
+----------+-------------------+---------------+---------------+
           | prompts                | extension.sock
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
- The **`bob` CLI** is the operator and chat client: a short-lived process that
  connects to the control plane over `admin.sock`. The same binary runs the
  service (`bob serve`) and every client subcommand.

## Components

### Rust service

A single binary that hosts the deterministic components from the logical model:

- **Channel adapters** — accept inbound traffic from the active channels
  (interactive chat over `admin.sock` and the scheduler in v1) and normalize each
  into a common internal event.
- **Requests Handler** — pulls events from the inbound queue, attaches user and
  channel identity, and runs pre-flight identity/access checks before any agent
  work begins.
- **Policy Control** — the action-authorization decision logic. It answers
  per-user authorization queries raised mid-run by the agent.
- **Monitoring** — an append-only audit log, plus an inbound interface that
  external CLI tools can call to register the actions they took.
- **Control plane (`admin-rpc`)** — the local JSON-RPC surface over `admin.sock`
  used to operate the running service; it also carries the chat and report
  interfaces. See [Control plane / operability](#control-plane--operability).

The Rust service also owns the inbound queue, identity, persistence, and
supervision of the pi-agent process pool.

### pi-agent processes

The Agent Harness. The Rust service runs **one pi-agent process per active
session**, which gives each session an isolated address space. A session is
keyed by the request's context (`context_id`), not by OS user: in the
single-user-local deployment every session belongs to the same person, so the
boundary isolates *concurrent contexts* — an interactive chat and a scheduled
job running at the same time each get their own agent process — rather than
separate people. Idle processes are reaped; a small pre-warmed pool absorbs
spawn latency. Prompts are delivered to each process from the Rust service over
pi-agent's `runRpcMode()` JSON-RPC channel.

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

An Action is an ordinary CLI run as the service-owner uid. Its only bob-specific
coupling is optional: to self-report, it reads the path to `admin.sock` from its
environment and calls `report.submit`. It needs no other wiring.

**Credentials.** bob custodies no secrets. Actions that need credentials (email,
calendar, …) use the user's own existing credential stores under the same uid —
the email skill, for instance, uses the email client's own configuration. Least
privilege is the uid boundary plus per-action Policy Control verdicts, not a
bob-managed secret vault. A dedicated secret-custody model is out of scope for
the single-user-local deployment and would be revisited only if the trust
boundary widens.

## How channels trigger the agent

the-intern is event-driven, not session-driven. All channels — synchronous and
asynchronous alike — normalize their input into internal events on a shared
inbound queue, classified by **delivery kind** (`sync`, `async`, `periodic`)
rather than by channel; the deterministic core never enumerates channel types
(ADR-004). The Requests Handler consumes that queue, so an emailed request, a
scheduled task, and a chat message all follow the same path. This is why the
system is a persistent service: asynchronous events must be handled even when no
user is connected.

**v1 ingress is local and pull-based.** The service exposes no inbound network
listener. Interactive chat arrives over `admin.sock`; asynchronous input is
obtained by *polling* on a schedule — email, for example, is the scheduler
firing a prompt that drives the email skill (S-009), not an inbound push. Push
channels that need a network listener (webhooks, inbound HTTP) are out of scope
for v1; adding one later means adding a channel adapter and a sanctioned ingress,
not changing the core.

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

**Local transport gate.** The control plane on `admin.sock` (and the
`extension.sock` channel) is gated by filesystem permissions: an owner-only
(`0700`) parent directory restricts connections to the service-owner uid, which
*is* the trust boundary. `SO_PEERCRED` is read only as an optional audit signal,
not as the gate (ADR-005).

**Request identity is self-asserted within that boundary.** The transport gate
establishes that the caller is the trusted service-owner uid; it does not by
itself say *which* application-level user or channel is acting. So every inbound
request carries its own application identity in its arguments, which the adapter
copies into `RequestContext.sender` for pre-flight admission, policy, and audit.
bob honors that asserted identity because the gate has already vouched for the
caller. The threat model is explicit: any process running as the service-owner
uid can assert any identity — acceptable because that uid *is* the system's
trust domain, and in the single-user-local deployment there is exactly one such
user. This is the simplest model that still gives policy and audit a stable,
named `sender`. If bob ever admits semi-trusted or remote callers, this decision
must be revisited and real end-user authentication introduced (ADR-005).

## Monitoring integration

Monitoring receives records from two sources:

- The JS extension forwards pi-agent's event stream — turns, tool calls,
  results, failures.
- External CLI tools (Actions) call Monitoring's inbound interface — the
  `report.submit` method on `admin.sock` (S-005) — to register the actions they
  performed. Same-uid access to the socket is the authentication boundary; bob
  issues no per-report token.

Monitoring writes an append-only JSONL audit log sufficient to reconstruct what
happened during a session or task; live records can be streamed to the operator
via `audit.tail` on the control plane.

## Control plane / operability

The data plane above turns a request into an effect. *Operating* the running
service — checking it is alive, inspecting and steering it, changing its
configuration without downtime — is a separate concern with its own surface: a
local **control plane**.

It is a single JSON-RPC 2.0 interface over a dedicated Unix-domain socket,
`admin.sock`, owned by the `admin-rpc` component inside `bob serve`. The `bob`
CLI is its only client today: each non-`serve` subcommand opens the socket,
makes one call (or opens one subscription), renders the result, and exits.

Several logically distinct interfaces are mounted on this one transport:

| Surface | Methods | Caller |
|---|---|---|
| Operator control | `service.status`, `sessions.list`/`kill`, `policy.reload`, `schedule.add`/`remove`/`list`/`reload` | operator, via `bob` |
| Live observability | `audit.tail.subscribe`/`unsubscribe` | operator, via `bob audit tail` |
| Interactive chat | `chat.open`/`send`/`close` (+ `chat.message` notifications) | user, via `bob chat` |
| External action reporting | `report.submit` | Action CLIs |

The operator and observability rows are genuinely new — they answer "how do you
run the thing," which the logical model deliberately did not ask. The chat and
report rows are **not** new architecture: they are the interactive-chat channel
and Monitoring's inbound report interface from the logical model, riding this
socket simply because it is the one local transport that already exists. `bob
chat` is a transport *into* the chat channel adapter, not a bypass — a chat
message still flows Requests Handler → Policy Control → Agent Harness like any
other channel (S-008).

**Configuration is live state.** Some methods mutate `bob.toml` and signal the
owning subsystem to reload. `schedule.*` is the worked example: the `[schedule]`
section is the source of truth, and `bob schedule add`/`remove` edits that file
and reloads the live job table (ADR-006). For these subsystems configuration is
not just startup input but runtime-mutable, persistent state.

The transport, framing, and trust boundary of this plane are fixed by ADR-001
(newline-delimited JSON-RPC), ADR-005 (the filesystem-permission gate and
self-asserted identity), and ADR-007 (the control plane as a whole); the client
lives in the `bob` binary by ADR-003.

## Technology stack

- **Rust** for the long-lived service — a single binary for Unix-likes (Linux
  and macOS), memory-safe for a long-running daemon, well suited to process
  supervision and concurrency.
- **pi-agent** (Node.js ≥20, TypeScript) as the Agent Harness, run as a
  supervised child process — never embedded in another language.
- **TypeScript** for the JS extension only — the minimum surface required,
  because pi-agent's hooks are an in-process API.
- **Two Unix sockets** — `extension.sock` for the extension-to-service channel
  (session-tagged, multiplexed) and `admin.sock` for the local control plane
  (JSON-RPC 2.0; operator, chat, and report surfaces); **`runRpcMode()`
  JSON-RPC** for prompt delivery.
- External **CLI tools** for Actions, selected to run on the supported
  Unix-likes.

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
- **A local control plane, not just config files and signals.** Operating a
  long-lived daemon — status, session control, runtime policy and schedule
  reload, audit tail — needs a request/response channel. bob exposes one
  JSON-RPC-over-UDS surface (`admin.sock`), filesystem- and peer-gated, shared by
  the operator, chat, and report interfaces. See ADR-001 (framing), ADR-003
  (client placement), ADR-005 (trust model), and ADR-007 (the plane itself).
- **Unix-likes only (Linux, macOS).** The trust model and both sockets rely on
  UDS, POSIX peer-credentials, and POSIX file permissions; Windows is out of
  scope (S-002).

## Open items

- Confirm against the pi-agent source that the `tool_call` hook accepts an
  **asynchronous** blocking verdict. This is load-bearing for the security
  design and must be verified before or early in implementation.
- Confirm the prompt-delivery path: whether `runRpcMode()` is the right channel
  for injecting prompts, or whether the extension must also carry prompt input.
- Inbound network channels (webhooks, HTTP) are deferred; v1 asynchronous
  ingress is pull-based via the scheduler. A future push channel needs a
  sanctioned ingress and a channel adapter, not core changes.
- `report.submit` shares `admin.sock` with the operator commands. Fine while
  every caller is the same-uid local user; revisit (a dedicated report socket or
  per-method authorization) only if external tools ever need a different trust
  level. Tracked in ADR-007.
