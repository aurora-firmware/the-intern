---
title: Channel Adapter Framework and Interactive-Chat Adapter
version: '0.1'
status: approved  # draft | review | approved | superseded
created: '2026-05-21'
author: planner
id: S-006
---

# Channel Adapter Framework and Interactive-Chat Adapter

## Purpose

S-001 Phase 6 calls for channel adapters that turn heterogeneous inbound
traffic into the single internal request model. Today no adapter exists: the
internal event queue, Requests Handler, and persistence are built (Phase 1b),
the core request type is correctly delivery-kind-typed (ADR-004, T-067), but
nothing feeds the queue from a real channel — `bob serve` constructs a
placeholder `RequestContext` and submits nothing.

This specification delivers the **first slice of Phase 6**: a reusable
in-process channel-adapter framework, plus one concrete adapter — the
interactive-chat adapter. When the work is done, a `bob chat` client can send a
chat message, the chat adapter normalizes it into a `Sync`-kind internal
request with its `RequestContext`, and the request lands on the bounded queue
and passes through the existing Requests Handler pre-flight. The remaining
S-001 Phase 6 channels (email, webhook, scheduler) follow in their own specs,
reusing the framework this spec establishes.

## Exclusions

What this specification explicitly does NOT cover:

- **Email, webhook, and scheduler adapters.** Only the framework and the chat
  adapter are in scope. Each remaining channel gets its own spec, built on this
  framework.
- **The external request-intake socket.** The intake handle is shaped so an
  external-process intake socket can wrap it later, but that socket — letting
  external programs act as adapters — is a separate future spec.
- **Webhook HTTP/TCP transport.** The collision between webhook intake and
  S-002's UDS-only stance is deferred to the webhook channel spec and an ADR.
- **The outbound response path.** ADR-004 specifies that a `Sync` request
  yields a receipt and, later, the agent's answer routed back to the caller.
  This spec wires only the inbound half: the receipt is produced, but the
  routed-back answer is not. Interactive chat is therefore inbound-only
  (effectively one-way) until the outbound-response spec lands.
- **Channel-specific feature depth.** Chat presence, history, and rich framing
  beyond a plain message are out of scope, per S-001's own exclusion.

## Architecture

### Design Principles

- **Channel identity lives only in adapters.** The deterministic core never
  enumerates channels; adapters are the sole channel-aware components and emit
  only delivery-kind-typed requests (ADR-004).
- **One doorway into the queue.** Adapters submit through a single typed intake
  handle and never touch the queue, persistence, or Requests Handler directly.
- **No unifying adapter trait.** Each adapter is a standard subsystem actor by
  the convention already used across `bob`; the framework is the intake handle,
  the configuration schema, and the supervision wiring — not a polymorphic
  contract.
- **Socket-ready intake.** The intake handle must be designed so a future
  external-intake socket can wrap it without reshaping the core or the handle's
  contract.
- **Explicit backpressure.** Submission is bounded; when the queue is full the
  intake handle reports rejection rather than blocking unboundedly, consistent
  with S-002's bounded-channel rule.
- **Safe-by-default channels.** A channel that is not configured is not run.
- **UDS-only.** All transport remains on Unix-domain sockets, per S-002.

### System Diagram

```
  bob chat (external client process)
        |  admin.sock — JSON-RPC chat subscription + user-input frames
        v
+-------------------------------------------------------------+
| bob service                                                 |
|                                                             |
|   Admin-RPC actor                                           |
|        |  chat-open call + each user-input frame            |
|        v                                                    |
|   Interactive-chat adapter ---- normalizes to -------+      |
|        |                        Sync InternalEvent   |      |
|        |                        + RequestContext     |      |
|        v                                             |      |
|   Channel intake handle  (the one doorway)            |      |
|        |  bounded submit, returns accept/reject       |      |
|        v                                             |      |
|   Internal event queue --> Requests Handler (pre-flight)     |
|                                                             |
|   bob serve: constructs + supervises enabled adapters       |
+-------------------------------------------------------------+
```

### Responsibility Separation

| Component | Responsibility | Notes |
|---|---|---|
| Channel intake handle | The single sanctioned API for submitting a delivery-kind-typed `(InternalEvent, RequestContext)` onto the bounded internal event queue; applies backpressure and returns an accept/reject receipt | In-process; the framework's core seam; designed to be wrappable by a future intake socket |
| Channel configuration | Declares which channels are enabled and carries each channel's settings | A section of `bob`'s existing layered config (ADR-002) |
| Adapter supervision wiring | Constructs every enabled adapter at `bob serve` startup, supervises it alongside existing subsystem actors, and shuts it down on graceful shutdown | Lives in `bob serve`; no new trait |
| Interactive-chat adapter | Consumes `admin.sock` chat subscriptions (chat-open + user-input frames), normalizes each input frame into a `Sync`-kind internal request with `RequestContext`, submits it through the intake handle | First concrete adapter; a standard subsystem actor |

## Components

### Component 1: Channel intake handle

**Purpose:** The one doorway every adapter uses to put a normalized request onto
the internal event queue.
**Estimated size:** Small–medium.
**Interfaces:** *Exposes* a submission operation taking an `InternalEvent` and
its `RequestContext` and returning an acceptance/rejection receipt; applies
bounded-queue backpressure. *Consumes* the existing internal event queue
(Phase 1b). The receipt it returns is the basis of the `Sync`/`async`
acknowledgement-or-error in ADR-004.

### Component 2: Channel configuration

**Purpose:** Tell `bob serve` which adapters to start and with what settings.
**Estimated size:** Small.
**Interfaces:** *Exposes* a per-channel configuration surface within `bob`'s
layered config; *consumed by* the adapter supervision wiring. An absent channel
entry means that channel is disabled.

### Component 3: Adapter supervision wiring

**Purpose:** Bring enabled adapters up at startup and down at shutdown.
**Estimated size:** Small.
**Interfaces:** *Consumes* the channel configuration and the intake handle;
*produces* running adapter actors integrated into `bob serve`'s existing
construction and graceful-shutdown sequence.

### Component 4: Interactive-chat adapter

**Purpose:** Turn `admin.sock` chat traffic into `Sync`-kind internal requests.
**Estimated size:** Medium.
**Interfaces:** *Consumes* chat-open calls and user-input frames handed over by
the Admin-RPC actor (the `chat` subscription described in S-002); *produces*
submissions through the intake handle. It carries no policy logic and never
short-circuits the Requests Handler.

## Workflow

End-to-end flow for one interactive-chat message (inbound half only):

```
bob chat opens a chat subscription on admin.sock (JSON-RPC call)
  ↓
Admin-RPC actor hands the chat-open, then each user-input frame,
to the interactive-chat adapter
  ↓
Chat adapter normalizes the frame into a Sync-kind InternalEvent
plus a RequestContext (sender, source channel, context id)
  ↓
Chat adapter submits via the channel intake handle
  ↓
Intake handle enqueues onto the bounded internal event queue and
returns an accept/reject receipt
  ↓
Requests Handler dequeues and runs the existing pre-flight
identity/access check (Phase 1b / ADR-004)
```

The receipt (accepted, or rejected for a full queue) is the inbound
acknowledgement-or-error of ADR-004. The agent's answer being routed back to the
`bob chat` subscriber is **out of scope** here (see Exclusions).

## Configuration Requirements

- **Per-channel enable flag.** Each channel must have an enable setting so an
  operator can run only the channels they want. It lives in a channels section
  of `bob`'s layered TOML config (ADR-002). When a channel's configuration is
  absent or the flag is unset, the channel **defaults to disabled** — an
  unconfigured channel is never started.
- **Whether the chat channel ships enabled by default** is `[TODO]` — chat is
  the primary interactive channel, so an enabled-by-default may be warranted;
  to be confirmed at Gate 1 or in task breakdown.
- **Chat adapter settings.** Any settings the chat adapter needs beyond the
  enable flag are expected to be minimal for this thin first slice; concrete
  keys are defined during task breakdown. The chat transport itself is the
  existing `admin.sock` (S-002) and introduces no new socket path.
- **Intake queue bounds.** The intake handle relies on the existing bounded
  internal event queue; its capacity is already a Phase 1b configuration
  concern and is not redefined here.

## Implementation Order

| Phase | What | Depends On |
|---|---|---|
| 1 | Channel intake handle (the doorway) and the per-channel configuration schema | Nothing (builds on the Phase 1b queue and the ADR-004/T-067 core types) |
| 2 | Adapter supervision wiring in `bob serve` — construct and gracefully shut down enabled adapters | Phase 1 |
| 3 | Interactive-chat adapter — consume `admin.sock` chat subscriptions, normalize to `Sync`-kind requests, submit through the intake handle | Phase 1, Phase 2 |

## Alternatives Considered

- **A unifying `ChannelAdapter` trait (Approach A).** A `bob-core` trait every
  adapter implements, with a uniform lifecycle and an adapter registry.
  *Rejected:* it would be designed against a single concrete adapter (chat),
  risking rework when email/webhook arrive, and no existing `bob` subsystem
  shares such a trait. Approach B — intake handle + config + supervision, with
  adapters as ordinary subsystem actors — matches the codebase and defers the
  polymorphic contract until two real adapters exist to generalize from.
- **Fully external adapters via an intake socket now.** Let external programs
  submit ready-made requests over a socket from day one. *Rejected for this
  spec:* it adds a security-relevant socket surface before it is needed. The
  intake handle is instead shaped so that socket can be added later without
  reshaping the core (see Exclusions).
- **Building all four Phase 6 channels at once.** *Rejected:* email, webhook,
  and scheduler each carry channel-specific transport concerns (webhook in
  particular collides with S-002's UDS-only stance). Establishing the framework
  with chat first keeps this spec small and lets each remaining channel be
  specified with its transport properly considered.
