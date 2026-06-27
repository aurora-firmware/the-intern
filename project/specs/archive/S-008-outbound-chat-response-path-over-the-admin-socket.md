---
title: Outbound chat response path over the admin socket
version: '0.1'
status: superseded  # draft | review | approved | superseded
created: '2026-06-11'
author: planner
id: S-008
---

# Outbound chat response path over the admin socket

<!--
This spec describes requirements and measurable criteria in prose.
It is not the implementation. Do not paste full configuration files,
build manifests, or implementation code into the sections below.
Concrete code belongs in the tasks the spec-breakdown skill produces
and in the Developer's output. See the Spec Authoring Guide for the
content contract this template implements.
-->

## Purpose

`bob chat` accepts messages but can never display a reply: `chat.open`
registers a subscription id without establishing a push channel, so no
notification is ever delivered to the client and the interactive session is
one-way (S-006 deferred this outbound path explicitly; it is bug 3 of the
GitHub issue #16 root-cause analysis, carried here from CR-001). With the
inbound fixes from B-008 merged, this is the last gap before chat can become
interactive, and later reply-producing work (pi-agent prompt delivery,
roadmap Phase 2) needs a stable delivery contract to land into. When this
spec is done, a chat-bound reply handed to the service's delivery interface
is printed by the subscribed `bob chat` process, demonstrated by automated
tests that inject replies at that interface and observe them on the client
side of the admin socket.

> **Superseded (CR-002, 2026-06-23).** This spec's purpose — delivering chat
> replies to a subscribed `bob chat` process over `admin.sock` — is obsoleted by
> CR-002, under which `bob chat` runs a supervised, directly-launched interactive
> `pi` session whose output reaches the user's terminal directly, not via an
> admin-socket reply router. The deferred reply producer this spec was designed to
> receive from (CR-001 / roadmap Phase 2) is likewise obsoleted for interactive
> chat. The chat reply router and `chat.message` push channel are retained in the
> codebase only as a possible basis for a future programmatic
> chat-over-`admin.sock` channel (none today). See ADR-010 and the amended S-006.

## Exclusions

What this specification explicitly does NOT cover:

- **Reply generation.** Nothing in this spec produces chat replies. The
  inbound pipeline today ends at policy preflight and persistence; prompt
  delivery to pi-agent sessions and routing of their output is roadmap
  Phase 2 work, which will plug into the delivery interface this spec
  defines. Until that lands, `bob chat` remains functionally one-way in
  production use; only tests exercise the outbound path end to end.
- **Cross-connection subscription use (per-service registry).** Rejected
  during CR-001 review. A `chat.send` is valid only on the connection that
  opened the chat subscription, exactly as today. The wire protocol does not
  encode this restriction, so a future spec (with an ADR) may relax it
  without breaking clients.
- **A first-class server-side session concept.** The CLI `--session` value
  maps onto the already-existing `context_id` carried by the inbound
  pipeline. No new session semantics, storage, or lifecycle are introduced,
  and the previously ignored `session` wire field is retired rather than
  implemented.
- **Reply replay and reconnect resume.** A subscription lives exactly as
  long as its connection. Replies that arrive when no subscription is open
  are dropped (observably, via log/audit), not buffered for later delivery.
- **Server-initiated JSON-RPC requests.** The server continues to send only
  responses and notifications to clients. The client-side frame classifier
  documented in the admin client keeps that assumption.

## Architecture

### Design Principles

- Replies for a chat subscription are delivered only on the connection that
  opened it; subscription ownership and delivery target are the same thing.
- One socket carries both directions without interference: a reply
  notification arriving while a `chat.send` response is pending must not be
  lost, reordered, or corrupted — on the server, on the wire, and in the
  client's concurrent read loop.
- The delivery contract is testable without any reply producer: replies
  enter through a service-scoped interface that tests can drive directly.
- Replies are addressed by the subscription id minted at `chat.open`; the
  address travels with each inbound chat frame so a future producer can
  reply without consulting any other component.
- A slow or stalled chat consumer must not block the service or other
  connections; outbound chat fan-out is bounded with an eviction behaviour
  consistent with the existing audit fan-out.
- Wire framing stays newline-delimited JSON-RPC 2.0, shape-compatible with
  the existing `audit.tail` notifications, so the existing client
  subscription machinery works unchanged.

### System Diagram

```
            bob chat CLI                          bob serve
 stdin ──► chat loop ── chat.open ───────► admin-rpc dispatch ──► reply router:
           │   ▲                                                  register sub-id
           │   │                                                       │ rx
           │   │                                                       ▼
           │   └── chat.message ◄── connection forwarder ◄────── per-sub queue
           │       notifications                                       ▲
           └────── chat.send ────────► dispatch ─► chat-adapter        │ deliver
                   (id, text,                        │            reply router
                    application_identity,            ▼                 ▲
                    context_id)                intake queue ─ ─ ─► [Phase-2
                                               preflight, store    producer]
```

### Responsibility Separation

| Component | Responsibility | Notes |
|---|---|---|
| Chat reply router (new) | Service-scoped registry of open chat subscriptions; accepts addressed replies and queues them per subscription; drops replies addressed to unknown/closed ids | Exposes a registration interface (used by dispatch on `chat.open`/`chat.close`) and a cloneable delivery handle (used by tests now, the Phase-2 producer later) |
| admin-rpc dispatch (modified) | `chat.open` registers with the router and returns a subscribed outcome so the connection spawns a forwarder; `chat.close` and connection drop deregister | Mirrors the existing `audit.tail.subscribe` outcome flow; per-connection send authorization unchanged |
| Connection forwarder (existing pattern) | Reads queued replies for one subscription and writes them to the owning connection as notification frames | Same cancellation discipline as the audit forwarder |
| chat-adapter (modified) | Carries the reply address (subscription id) on each inbound chat frame into the pipeline | Frame normalisation otherwise unchanged |
| bob CLI `chat` (modified) | Sends `context_id` derived from `--session`; stops sending the dead `session` field; prints reply notifications; reads concurrently with stdin without losing partial frames | Rendering (text vs `--json`) already exists |

### Wire Contract

The following frame shapes are externally observable protocol — **Contract**:

- `chat.send` params carry `id` (subscription id from `chat.open`), `text`,
  `application_identity`, and optionally `context_id`. The `session` key is
  no longer sent and remains ignored if received.
- Reply notifications use method `chat.message` with params `subscription`
  (the subscription id) and `data` (the reply payload). `data` contains at
  least a `text` string when the reply is human-readable text.

## Components

### Component 1: Chat reply router

**Purpose:** Single service-scoped entry point through which any producer can deliver a reply addressed to an open chat subscription.
**Estimated size:** Small–medium (new module in the admin-rpc crate plus tests).
**Interfaces:** Exposes subscription register/deregister (consumed by dispatch) and a delivery handle (consumed by tests now, Phase-2 producer later); consumes nothing else.

### Component 2: Subscribed chat.open dispatch

**Purpose:** Make `chat.open` produce a real push channel and forwarder, and make `chat.close`/disconnect tear it down.
**Estimated size:** Small (dispatch + connection loop changes following the audit pattern, plus tests).
**Interfaces:** Consumes the router's registration interface; produces the subscribed dispatch outcome already understood by the connection loop.

### Component 3: Reply address on inbound frames

**Purpose:** Thread the subscription id through `chat.send` into the chat frame so replies can be addressed.
**Estimated size:** Small (chat-adapter frame type and dispatch call site, plus tests).
**Interfaces:** Extends the chat frame consumed by the intake pipeline; no new external interface.

### Component 4: CLI chat client updates

**Purpose:** Map `--session` to `context_id`, retire the `session` wire field, and make the interactive loop's concurrent reads frame-safe.
**Estimated size:** Medium (params change is trivial; the frame-safe concurrent read needs care and tests).
**Interfaces:** Consumes the existing admin client subscription API; user-facing CLI flags unchanged.

## Workflow

```
user runs `bob chat [--session X]`
  ↓
CLI opens admin connection, sends chat.open
  ↓
dispatch registers sub-id with reply router, returns subscribed outcome
  ↓ (connection spawns chat forwarder)
user types a line → chat.send {id, text, application_identity, context_id}
  ↓
dispatch validates (unchanged) → chat-adapter frame now carries sub-id → intake
  ↓ … Phase-2 producer (out of scope) eventually calls …
router.deliver(sub-id, reply)
  ↓
per-sub queue → forwarder → chat.message notification on owning connection
  ↓
CLI prints reply text (or JSON with --json); send/receive interleaving is safe
  ↓
user exits (EOF / Ctrl-C) → chat.close → router deregisters, forwarder stops
  ↓
replies delivered to a closed/unknown sub-id are dropped and logged
```

Error paths worth noting: a reply delivered after `chat.close` (or to a
never-opened id) is dropped with an observable log entry and must not error
the producer; a full per-subscription queue evicts that subscriber the same
way the audit bus evicts slow consumers, and the CLI surfaces the closed
stream as an error rather than hanging.

## Configuration Requirements

No new configuration is introduced.

- **Per-subscription queue bound** — the chat reply queue capacity is an
  internal constant chosen consistently with the existing audit fan-out
  bus; it is not operator-configurable in this spec. Missing-value
  behaviour does not apply.
- Existing settings (`BOB_ADMIN_SOCK_PATH`, chat application identity) are
  consumed unchanged.

## Implementation Order

| Phase | What | Depends On |
|---|---|---|
| 1 | Chat reply router: service-scoped register/deliver/drop semantics proven by crate tests | Nothing |
| 2 | Subscribed `chat.open` + forwarder + teardown: an integration test over a real socket injects a reply at the router and observes a `chat.message` frame | Phase 1 |
| 3 | Reply address on inbound frames and CLI param change (`context_id` in, `session` out) | Phase 1 (address type), independent of Phase 2 |
| 4 | CLI frame-safe concurrent receive + end-to-end test: injected reply prints while the user is mid-send; user documentation for `bob chat` updated | Phases 2 and 3 |

## Amendment Log

| Date | What changed | Why | Affected tasks |
|------|-------------|-----|----------------|
| 2026-06-23 | Spec superseded (status → superseded) and moved to `project/specs/archive/`. | CR-002 replaces admin-socket interactive chat and its outbound reply path with a supervised direct `pi` session; the reply router has no interactive consumer. | T-107, T-108 |
