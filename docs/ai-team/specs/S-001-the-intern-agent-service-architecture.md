---
title: the-intern Agent Service Architecture
version: '0.1'
status: approved  # draft | review | approved | superseded
created: '2026-05-14'
author: planner
id: S-001
---

# the-intern Agent Service Architecture

## Purpose

the-intern is a persistent, always-on assistant service. Users reach it through
several channels — interactive chat and asynchronous channels such as email and
scheduled tasks. Because asynchronous channels deliver events when
no user is present, the system must run as a long-lived service rather than a
per-session program.

This specification defines the structural architecture of that service: how it
is split across processes, how the agent runtime is integrated and supervised,
how authorization and monitoring are enforced outside the agent, and how
external actions are triggered and constrained.

The expected outcome is an architecture that satisfies the logical model in
`project/docs/system_overview.md` — deterministic policy first, least
privilege, per-session data boundaries, and a complete audit trail — while running
the agent on pi-agent as the Agent Harness.

## Exclusions

What this specification explicitly does NOT cover:

- **MCP support.** pi-agent has no MCP client. Actions are external CLI tools
  described via skills; an MCP bridge is out of scope.
- **Typed per-CLI custom-tool wrappers.** v1 executes actions through pi-agent's
  generic `bash` tool. Wrapping each CLI as a typed pi tool is a possible later
  refinement, not part of this scope.
- **Single multiplexing pi-agent process.** Running all user-sessions inside one
  shared pi-agent process is explicitly rejected; it cannot provide a per-session
  data boundary.
- **Channel-specific feature depth.** Rich behaviour within a channel (email
  threading semantics, chat presence) is out of scope for this architecture spec
  and belongs to per-channel specs.
- **Action CLI implementations.** The external CLI tools themselves are separate
  deliverables; this spec only defines how they are invoked, authorized, and
  how they report.

## Architecture

### Design Principles

- **Deterministic policy outside the agent.** Identity, authorization, and
  monitoring are decided by a service the agent cannot bypass or modify.
- **Single-user-local scope.** the-intern runs for one user on one machine; the
  OS account is the whole trust domain (ADR-008). Each active session still runs
  in its own process, isolating the user's concurrent contexts rather than
  separating different people.
- **Thin in-agent surface.** The only component running inside the agent process
  is a forwarder with no policy logic.
- **Event-driven uniformity.** Every channel — synchronous or asynchronous —
  normalizes into the same internal request and follows the same path. The
  core request interface is typed by *delivery kind* (`sync`, `async`,
  `periodic`) — never by channel. Channel identity is confined to the adapters;
  the deterministic core never enumerates channel types. See ADR-004.
- **Unix-likes (Linux and macOS).** The long-lived service and all components
  run on Linux and macOS. Windows support is explicitly out of scope; see
  S-002 (Bob Service Shell Architecture), which fixes the shell on Unix-only
  primitives (UDS, POSIX peer-credentials, POSIX file permissions). A future
  Windows port would be a separately-justified amendment.

### System Diagram

```
+-------------------------------------------------------------+
| Rust service (single binary; Unix-likes: Linux and macOS)   |
|                                                             |
|  Channel adapters -> Requests Handler -> Policy Control     |
|                              |              ^               |
|                       Monitoring            | verdict       |
+----------+-------------------+---------------+---------------+
           | prompts                | Unix socket
           | (runRpcMode JSON-RPC)  | (auth verdicts, events)
           v                        |
+----------+------------------------+---------------+
| pi-agent process (one per active user-session)    |
|   pi-agent runtime  <-->  JS extension            |
|         | bash tool                               |
+---------+-----------------------------------------+
          v
   External CLI tools (Actions)
```

### Responsibility Separation

| Component | Responsibility | Notes |
|---|---|---|
| Rust service | Hosts the deterministic components; owns the inbound queue, identity, persistence, and supervision of pi-agent processes | Single long-lived binary on Linux + macOS; shell defined in S-002 |
| Channel adapters | Accept inbound traffic from external adapters such as email and scheduler; normalize each into a common internal request, classified by delivery kind (`sync`/`async`/`periodic`) per ADR-004 | Part of the Rust service; the only components that know adapter-specific protocols. Interactive chat is a supervised directly launched `pi` session and does not enter the queue |
| Requests Handler | Consume the inbound queue, attach user/channel identity, run pre-flight identity/access checks where the channel's admission model requires them | Part of the Rust service |
| Policy Control | Decide per-user authorization for actions raised mid-run by the agent | Part of the Rust service; never inside the agent |
| Monitoring | Maintain an append-only audit log; expose an inbound interface for external tools to report actions | Part of the Rust service |
| pi-agent process | Run one user-session's agent | Spawned on demand, idle-reaped, drawn from a warm pool |
| JS extension | Host the blocking `tool_call` hook, forward events to Monitoring, supply skill paths to pi-agent | Only component inside the agent process; carries no policy logic and reads no skill content — it supplies a path bob resolved (ADR-014) |
| Actions (CLI tools) | Perform external side effects | Separate processes invoked via the `bash` tool; may self-report to Monitoring |

## Components

### Component 1: Rust service

**Purpose:** The deterministic core and the only long-lived process; hosts
Channel adapters, Requests Handler, Policy Control, and Monitoring, and
supervises the pi-agent process pool.
**Estimated size:** Large — the bulk of the system.
**Interfaces:**
- *Inbound:* channel-specific endpoints (chat, email retrieval, scheduled
  triggers), each normalized by its adapter onto the internal event queue as a
  delivery-kind-typed request (`sync`/`async`/`periodic`, ADR-004).
- *To pi-agent processes:* delivers prompts over pi-agent's `runRpcMode()`
  JSON-RPC channel; spawns, supervises, and reaps the processes.
- *Extension channel (single Unix socket):* one socket shared by every
  pi-agent JS extension instance, carrying two message families on the same
  framed connection — *authorization requests* (`(session id, tool, arguments,
  user identity)` → allow/block verdict with optional reason) and *forwarded
  agent events* destined for Monitoring. Both families are tagged with a
  session identifier so the Rust service can multiplex them.
- *Monitoring report interface:* an inbound endpoint, reachable by external CLI
  tools, accepting action records. Transport is decided: the `report.submit`
  JSON-RPC method on `admin.sock` (S-005; ratified by ADR-007). No dedicated
  `report.sock` is introduced in v1.

### Component 2: pi-agent process

**Purpose:** Runs the Agent Harness for exactly one active user-session.
**Estimated size:** Small — mostly configuration and lifecycle wiring around
pi-agent.
**Interfaces:**
- *Consumes:* prompts from the Rust service via `runRpcMode()` JSON-RPC.
- *Loads:* the JS extension at startup.
- *Produces:* external effects only through the `bash` tool, each gated by the
  extension's `tool_call` hook.
- *Lifecycle:* spawned on demand by the Rust service, served from a small
  pre-warmed pool, reaped after a configurable idle period.

### Component 3: JS extension

**Purpose:** A thin membrane inside each pi-agent process; forwards decisions and
events, holds no policy logic.
**Estimated size:** Small.
**Interfaces:**
- *Hosts* pi-agent's blocking `tool_call` hook: on each tool call it sends an
  authorization request to the Rust service over the Unix socket, awaits an
  asynchronous verdict, and returns allow/block to pi-agent.
- *Subscribes* to pi-agent's event stream and forwards events to Monitoring over
  the Unix socket.
- *Supplies* skills to pi-agent: bob resolves a configured skill install path
  and the extension answers pi's resource-discovery event with it, so every
  session bob spawns carries the same skills regardless of its working
  directory (ADR-014). `AGENTS.md`/`CLAUDE.md` context files are still
  discovered from the working directory, which ADR-012 §7 records as a
  deliberate trust relaxation (the working directory is a trusted, un-checked
  input); the skill install path is a trusted, un-checked input on the same
  terms (ADR-014 §7). S-010 was the first concrete skill package; S-011
  restructures it and moves skill delivery here.
- All extension instances connect to the same Unix socket; every message is
  tagged with a session identifier so the Rust service can multiplex them.

### Component 4: Actions (external CLI tools)

**Purpose:** Perform the external side effects the agent requests.
**Estimated size:** Out of scope individually; this spec covers only the
invocation and reporting contract.
**Interfaces:**
- *Invoked* by the agent through pi-agent's `bash` tool, described to the agent
  by skills (markdown instruction files).
- *Authorized:* every `bash` invocation passes through the extension's
  `tool_call` hook and therefore through Policy Control.
- *Reporting:* a tool may call Monitoring's inbound report interface to register
  the action it performed.

## Workflow

End-to-end flow from an inbound event to a completed action:

```
Channel adapter normalizes inbound event -> internal queue
  ↓
Requests Handler attaches identity and applies the channel's admission model
  ↓
Rust service routes prompt to the user's pi-agent process
(spawning one from the warm pool if none is active)
  ↓
pi-agent runs; on each tool call the JS extension intercepts
  ↓
Extension asks Policy Control for a verdict (Unix socket)  [authorization gate]
  ↓
On allow: bash tool runs the external CLI; on block: the call is denied
  ↓
Extension forwards events to Monitoring; CLI tool may also self-report
  ↓
Response returned through the originating channel; audit log updated
```

A pre-flight denial stops an admission-gated request before any agent work
begins. Scheduler jobs are admitted under ADR-012 by trusted schedule-store
membership rather than by scheduler UUID allow-list membership. A per-action
denial stops the side effect while the session continues.

What returns to the caller depends on the request's delivery kind (ADR-004): a
`sync` request gets an immediate acknowledgement-or-error receipt and, later,
the agent's answer routed back over the originating connection; an `async`
request gets only the receipt; a `periodic` trigger gets nothing back.

## Configuration

Configuration is described here as behaviour; concrete formats and keys are
defined during task breakdown. The architecture assumes the following are
configurable:

- **Channel adapters** — which channels are enabled and their connection
  settings.
- **Process pool** — warm-pool size, maximum concurrent pi-agent processes, and
  idle-reap timeout.
- **Policy Control** — per-user authorization rules consulted for action
  verdicts.
- **Sockets and transports** — the Unix socket path for the extension channel
  and the transport for the Monitoring report interface.
- **Persistence** — locations for the audit log, the inbound queue, session
  state, and scheduler state.

## Implementation Order

| Phase | What | Depends On |
|---|---|---|
| 1a | Service shell per S-002: `bob` binary, single Tokio runtime, `admin.sock` (JSON-RPC 2.0) and `extension.sock` listeners, subsystem actor scaffolds with port traits in `bob-core`, graceful shutdown, `bob` client subcommands against `admin.sock` | Nothing |
| 1b | Working internal event queue, Requests Handler, and persistence — landing into the scaffolds created in Phase 1a | Phase 1a |
| 2 | pi-agent process supervision: spawn, warm pool, idle reaping, prompt delivery over `runRpcMode()` | Phase 1b |
| 3 | JS extension: event subscription and forwarding to Monitoring | Phase 2 |
| 4 | Policy Control: pre-flight checks and the blocking `tool_call` authorization path over the Unix socket | Phase 2, Phase 3 |
| 5 | Monitoring: append-only audit log and the inbound report interface for external tools (transport decision from S-002 must land before this phase starts) | Phase 1b, Phase 3 |
| 6 | Channel adapters: chat (interactive chat is a supervised, directly-launched `pi` session per CR-002 / ADR-010 — no longer an `admin.sock` chat subscription), email, scheduler | Phase 1b |
| 7 | Actions: skill definitions and the CLI invocation/reporting contract (skill definitions partially delivered by S-010; the CLI invocation/reporting contract remains open) | Phase 4, Phase 5 |

## Open Questions

All original open questions are resolved:

- **Async blocking verdict.** Resolved — pi-agent's `tool_call` hook accepts an
  asynchronous allow/block verdict; verified during S-004 delivery, where the
  blocking authorization path is implemented and in force.
- **Prompt-delivery path.** Resolved — `runRpcMode()` JSON-RPC is the prompt
  channel for supervised worker sessions, implemented by the pi-agent
  supervisor (Phase 2). Interactive chat uses a separate supervised direct
  `pi` session instead of prompt injection (CR-002 / ADR-011).
- **Monitoring report transport.** Resolved — `report.submit` on `admin.sock`
  (S-005, ADR-007).

## Amendment Log

| Date | What changed | Why | Affected tasks |
|------|-------------|-----|----------------|
| 2026-05-16 | OS scope narrowed from "OS-agnostic" to "Unix-likes (Linux + macOS)" in Design Principles and Component 1; extension-side Unix socket bullets merged into a single "Extension channel (single Unix socket)" description; Monitoring report interface transport candidates narrowed to UDS-only (extend `admin.sock` or dedicated `report.sock`); Implementation Order Phase 1 split into 1a (shell per S-002) and 1b (queue/handler/persistence), with downstream Depends-On cells updated accordingly; chat channel adapter clarified as consuming `admin.sock` chat subscriptions. | S-002 (Bob Service Shell Architecture) approved 2026-05-16; the shell decision fixes Unix-only primitives (UDS, peer-credentials, POSIX perms) and reshapes how Phase 1 is delivered. | None (no tasks in flight against S-001 yet). |
| 2026-05-21 | Event-driven-uniformity principle, Channel adapters responsibility row, Component 1 inbound interface, and Workflow response paragraph clarified: the core request interface is typed by delivery kind (`sync`/`async`/`periodic`), never by channel; channel identity is confined to adapters; per-kind response semantics stated. | ADR-004 accepted 2026-05-21. The shipped `InternalEvent` enum (per-channel variants from T-008) hardcoded channel identity the core should not know; this contradicted the spec's intent and is being corrected. | Corrective tasks to reshape `InternalEvent` and its `requests-handler`/`persistence` consumers (to be planned separately); Phase 6 channel-adapter design unaffected in scope but now builds on the corrected core type. |
| 2026-06-13 | Deployment scope narrowed to single-user-local: the "Per-user isolation" principle reframed to single-user (one OS/trust-domain account; per-session isolation of the user's concurrent contexts, not cross-user). Webhooks removed from the committed channel set (Purpose, Channel-adapters row, Component 1 inbound, Exclusions example, Phase 6). | ADR-008 (single-user-local deployment scope) accepted 2026-06-13, reconciling S-001 with the committed product and the trust model in ADR-005/ADR-007. The core stays delivery-kind-typed (ADR-004), so the narrowed channel set does not constrain future channel additions. | None (no tasks in flight against these sections). |
| 2026-06-23 | Phase 6 chat clause updated: interactive chat is a supervised, directly-launched `pi` session (CR-002 / ADR-010), not an `admin.sock` chat subscription. | CR-002 redefines `bob chat`; the S-002 interactive-chat-adapter path is superseded for interactive use (S-006 amended, S-008 archived as superseded). | T-103, T-104, T-105, T-106, T-107, T-108 |
| 2026-06-30 | Requests Handler language narrowed from universal pre-flight identity checks to per-channel admission models; scheduler admission now references ADR-012. | CR-004 / ADR-012 remove scheduler-derived UUID admission and use the Unix trust boundary plus trusted schedule store for scheduled work. | Scheduler amendment tasks TBD |
| 2026-07-04 | System diagram label corrected from "single OS-agnostic binary" to "Unix-likes (Linux and macOS)", matching the 2026-05-16 OS-scope amendment; Component 1 report-interface transport marked decided (`report.submit` on `admin.sock`, S-005/ADR-007); the three Open Questions marked resolved. | Documentation-consistency review: the diagram and Open Questions had not been updated after the amendments and after S-004/S-005 delivery answered them. | None (documentation reconciliation). |
| 2026-08-01 | Component 3's third bullet and the JS-extension Responsibility Separation row corrected: skills reach pi-agent through its own cwd-relative auto-discovery, not through the JS extension providing them. Implementation Order Phase 7 annotated: the skill-definitions half is now partially delivered by S-010; the CLI invocation/reporting contract half remains open. | Architecture Consistency Review of S-010 (draft) found this stale against ADR-012 §7, which already established cwd auto-discovery as the mechanism, and against S-003/S-004's Exclusions, which both parked "agent skills" as deferred to a later spec. S-010 is that later spec. | None (documentation reconciliation; no tasks in flight against this component). |
| 2026-08-06 | Component 3's third bullet and the JS-extension Responsibility Separation row corrected again: bob resolves a skill install path and its extension supplies it to pi, so skills no longer reach pi-agent through cwd-relative auto-discovery. Context-file discovery from the working directory is unchanged. | ADR-014 accepted 2026-08-06. The 2026-08-01 amendment recorded cwd-relative discovery as the mechanism; pi's extension API exposes a resource-discovery event that lets an extension supply skill paths, which S-011 adopts so a session's skills stop depending on its working directory. | S-011 breakdown tasks (Gate 2 pending). |
