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
their own machine** (ADR-008). The user reaches it through several channels — interactive
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
        | admin.sock — JSON-RPC 2.0, filesystem-permission gated
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

- **Channel adapters** — accept inbound traffic from the active queue-borne
  channels (the scheduler in v1) and normalize each into a common internal
  event. Interactive chat is *not* an adapter: it is a supervised,
  directly-launched `pi` session (CR-002, ADR-010) that never enters the
  queue.
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
session**, which gives each session an isolated address space. Under the
single-user-local scope (ADR-008) every session belongs to the same person, so
this boundary isolates *concurrent contexts of that user* — an interactive chat
and a scheduled job at the same time each get their own agent process — rather
than separate people. How a session is derived from an inbound request is an
**open design item**: the supervisor allocates its own `SessionId` per worker,
while a queue-borne request carries an optional `context_id` in its
`RequestContext` (ADR-004), and no mapping between the two is defined yet. Idle processes are reaped; a small pre-warmed pool
absorbs spawn latency. Prompts are delivered to each process from the Rust
service over pi-agent's `runRpcMode()` JSON-RPC channel.

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
the email skill, for instance, uses the email client's own configuration. Authorization is at invocation time — Policy Control issues a
verdict on the `bash` call — but there is no post-launch sandbox: an authorized
Action runs with the full authority of the service uid and can read anything
that uid can. This is an accepted single-user-local limitation (ADR-008), not
least-privilege isolation. A per-Action credential or capability sandbox would
be introduced only if the trust boundary widens.

## How channels trigger the agent

the-intern is event-driven, not session-driven. Queue-borne channels —
synchronous and asynchronous alike — normalize their input into internal
events on a shared inbound queue, classified by **delivery kind** (`sync`,
`async`, `periodic`) rather than by channel; the deterministic core never
enumerates channel types (ADR-004). The Requests Handler consumes that queue,
so an emailed request and a scheduled task follow the same path. This is why
the system is a persistent service: asynchronous events must be handled even
when no user is connected.

**Interactive chat is the exception (CR-002, ADR-010, ADR-011).** `bob chat`
does not feed the queue. It asks the service over `admin.sock` to open a
supervised interactive `pi` session, passing the client's terminal file
descriptors via `SCM_RIGHTS` so pi runs on the user's real TTY while remaining
a supervised child of `bob serve`. Chat turns therefore never traverse the
adapter → intake → Requests Handler path; the session's gates are socket
access and the per-action `tool_call` authorization hook.

**Ingress is local and pull-based (ADR-008).** The service exposes no inbound
network listener. Interactive sessions are opened over `admin.sock`;
asynchronous input is obtained by *polling* on a schedule — email, for
example, is the scheduler firing a prompt that drives the email skill (S-009),
not an inbound push. Because the deterministic core is typed by delivery kind
and never enumerates channels (ADR-004), any new channel is added as another
adapter behind its own ingress, without changing the core.

## Security integration

Authorization is deterministic and enforced outside the agent:

- **Pre-flight** — the Requests Handler applies each channel's admission model
  to queue-borne requests before any agent work begins. Two channels have
  explicit, recorded exceptions: interactive chat is exempt because it never
  traverses the queue — its gates are socket access and the action gate
  (ADR-010) — and scheduler jobs are admitted by trusted schedule-store
  membership rather than by a `UserId` allow-list entry (ADR-012).
- **Per-action** — when the agent attempts an action, the extension's
  `tool_call` hook blocks execution and asks Policy Control in the Rust service
  for a verdict. The agent cannot reach an external effect without a passing
  verdict, and it cannot modify the deterministic policy code. This gate
  applies to every supervised session, including interactive chat and
  scheduler-triggered runs.

This keeps the trust boundary intact: the extension inside the agent process is
only a courier; every decision is made in the Rust service.

**Local transport gate.** The control plane on `admin.sock` (and the
`extension.sock` channel) is gated by filesystem permissions: an owner-only
(`0700`) parent directory restricts connections to the service-owner uid, which
*is* the trust boundary. `SO_PEERCRED` is read only as an optional audit signal,
not as the gate (ADR-005).

**Request identity is established within that boundary.** The transport gate
establishes that the caller is the trusted service-owner uid; it does not by
itself say *which* application-level user or channel is acting. An inbound
request gets its application identity one of two ways, depending on the channel:

- *Externally asserted* — a request that crosses a socket carries its own
  application identity in its arguments; the adapter copies it into
  `RequestContext.sender`. bob honors it because the gate has already vouched
  for the caller (ADR-005). An interactive chat session likewise carries an
  application identity, though only for attribution and audit — its admission
  gate is the socket itself (ADR-010).
- *Adapter-assigned* — a request that originates in-process and crosses no
  socket (the scheduler) has no external caller to assert anything, so the
  channel adapter assigns a stable identity for attribution and audit.
  Since ADR-012 that identity plays no admission role: a scheduler job is
  admitted by its presence in the trusted schedule store, and derived
  identities must stay non-authoritative — a guessable identity must never
  confer authority.

Either way, pre-flight admission, policy, and audit operate on that application
`sender`. The threat model is explicit: any process running as the service-owner
uid can assert any externally-supplied identity — acceptable because that uid
*is* the system's single trust domain (ADR-008). "Single user" means one
OS/trust-domain account, not one application identity: multiple senders and
channels legitimately coexist behind that uid. If bob ever admits semi-trusted
or remote callers, this decision must be revisited and real end-user
authentication introduced (ADR-005).

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
| Interactive chat | `session.interactive.open` / attach lifecycle for a supervised `pi` session | user, via `bob chat` |
| External action reporting | `report.submit` | Action CLIs |

The operator and observability rows are genuinely new — they answer "how do you
run the thing," which the logical model deliberately did not ask. The chat and
report rows are **not** new architecture: they are the interactive-chat channel
and Monitoring's inbound report interface from the logical model, riding this
socket simply because it is the one local transport that already exists. `bob
chat` uses the plane as a control request to open and attach to a supervised
interactive `pi` session — the client's terminal fds cross as `SCM_RIGHTS`
ancillary data (ADR-011) — and chat turns do not traverse the queue-borne
Requests Handler → Policy Control path (ADR-010, CR-002).

**Configuration and persistent state are live.** Some methods apply operator
changes to running subsystems and signal the owner to reload. `policy.reload`
re-reads the policy section of static `config.toml`. `schedule.*` mutates the
dedicated schedule state store — a versioned JSON document at
`$XDG_STATE_HOME/bob/schedules.json` (ADR-012) — and reloads the live job
table; the scheduler itself stays bob-internal (ADR-006). Mutable runtime
state is kept out of `config.toml` unless an owning ADR says otherwise.

The transport, framing, and trust boundary of this plane are fixed by ADR-001
(newline-delimited JSON-RPC), ADR-005 (the filesystem-permission gate and
self-asserted identity), and ADR-007 (the control plane as a whole); the client
lives in the `bob` binary by ADR-003; terminal fd-passing for interactive chat
is fixed by ADR-011.

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
  (JSON-RPC 2.0; operator, interactive-session, and report surfaces);
  **`runRpcMode()` JSON-RPC** for prompt delivery to queue-borne sessions.
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
  JSON-RPC-over-UDS surface (`admin.sock`), filesystem-permission gated
  (peer-credential audited), shared by the operator, chat, and report
  interfaces. See ADR-001 (framing), ADR-003
  (client placement), ADR-005 (trust model), and ADR-007 (the plane itself).
- **Unix-likes only (Linux, macOS).** The trust model and both sockets rely on
  UDS, POSIX peer-credentials, and POSIX file permissions; Windows is out of
  scope (S-002).
- **Single-user-local scope.** the-intern targets one user on one machine; the
  OS account is the entire trust domain. This justifies the filesystem-only
  gate, local pull-based ingress, and no secret custody (ADR-008).
- **Interactive chat is a supervised direct `pi` session.** `bob chat` asks
  the service to launch pi on the user's real terminal (fds passed via
  `SCM_RIGHTS`, ADR-011); it is exempt from pre-flight admission and gated by
  socket access plus the `tool_call` hook (ADR-010, CR-002).
- **Bob-internal scheduler with a JSON state store.** Cron jobs live inside
  `bob serve` (no system cron, ADR-006); schedule entries persist in
  `$XDG_STATE_HOME/bob/schedules.json`, mutated only via `bob schedule` /
  `schedule.*`, and a job in the trusted store is admitted for firing
  (ADR-012).
- **XDG filesystem layout.** Config, data (extension), state (audit log,
  schedule store), and runtime (sockets) follow the XDG Base Directory
  specification on Linux (ADR-009).

## Open items

- `report.submit` shares `admin.sock` with the operator commands. Fine while
  every caller is the same-uid local user; revisit (a dedicated report socket or
  per-method authorization) only if external tools ever need a different trust
  level. Tracked in ADR-007.
