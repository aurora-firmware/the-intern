---
title: Channel Adapter Framework
version: '0.1'
status: approved  # draft | review | approved | superseded
created: '2026-05-21'
author: planner
id: S-006
---

# Channel Adapter Framework

## Purpose

S-001 Phase 6 calls for channel adapters that turn heterogeneous inbound
traffic into the single internal request model. The core request type is
delivery-kind-typed (ADR-004, T-067), and channel adapters submit normalized
requests with `RequestContext` through the intake handle defined here.

This specification delivers the reusable in-process channel-adapter framework:
the intake handle, per-channel configuration surface, and `bob serve`
supervision wiring used by concrete adapters. The first admin-socket
interactive-chat adapter originally scoped here was retired by CR-002; current
interactive `bob chat` behaviour is specified in S-002, ADR-010, and ADR-011.
The scheduler adapter in S-009 is the active concrete adapter built on this
framework.

## Exclusions

What this specification explicitly does NOT cover:

- **Concrete adapters.** This spec defines the framework only. Each channel gets
  its own spec, built on this framework; S-009 defines the scheduler adapter.
- **Interactive `bob chat`.** Current interactive chat is a service-required,
  supervised direct `pi` session, not a channel adapter. See S-002, ADR-010,
  ADR-011, and CR-002.
- **The external request-intake socket.** The intake handle is shaped so an
  external-process intake socket can wrap it later, but that socket — letting
  external programs act as adapters — is a separate future spec.
- **The outbound response path.** ADR-004 specifies that a `Sync` request
  yields a receipt and, later, the agent's answer routed back to the caller.
  This spec wires only the inbound half: the receipt is produced, but the
  routed-back answer is not.
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
+-------------------------------------------------------------+
| bob service                                                 |
|                                                             |
|   Concrete channel adapter (for example scheduler, S-009)   |
|        |  normalizes channel input to                        |
|        |  InternalEvent + RequestContext                     |
|        v                                                    |
|   Channel intake handle  (the one doorway)                  |
|        |  bounded submit, returns accept/reject              |
|        v                                                    |
|   Internal event queue --> Requests Handler (admission)      |
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

## Workflow

End-to-end flow for one channel-adapter submission:

```
Adapter receives or generates channel input
  ↓
Adapter normalizes the input into an InternalEvent plus a
RequestContext (sender, source channel, context id)
  ↓
Adapter submits via the channel intake handle
  ↓
Intake handle enqueues onto the bounded internal event queue and
returns an accept/reject receipt
  ↓
Requests Handler dequeues and applies the concrete channel's
admission model (Phase 1b / ADR-004; scheduler exception in ADR-012)
```

The receipt (accepted, or rejected for a full queue) is the inbound
acknowledgement-or-error of ADR-004. Channel-specific response routing is out of
scope for the framework and belongs in the concrete adapter spec.

Admission semantics are also owned by the concrete adapter spec and the policy
ADRs. Most queue-borne adapters use the S-004 pre-flight `UserId` gate; the
scheduler adapter is narrowed by ADR-012 to trusted schedule-store membership
under the Unix trust boundary.

## Configuration Requirements

- **Per-channel enable flag.** Each channel must have an enable setting so an
  operator can run only the channels they want. It lives in a channels section
  of `bob`'s layered TOML config (ADR-002). When a channel's configuration is
  absent or the flag is unset, the channel **defaults to disabled** — an
  unconfigured channel is never started.
- **Intake queue bounds.** The intake handle relies on the existing bounded
  internal event queue; its capacity is already a Phase 1b configuration
  concern and is not redefined here.

## Implementation Order

| Phase | What | Depends On |
|---|---|---|
| 1 | Channel intake handle (the doorway) and the per-channel configuration schema | Nothing (builds on the Phase 1b queue and the ADR-004/T-067 core types) |
| 2 | Adapter supervision wiring in `bob serve` — construct and gracefully shut down enabled adapters | Phase 1 |

## Alternatives Considered

- **A unifying `ChannelAdapter` trait (Approach A).** A `bob-core` trait every
  adapter implements, with a uniform lifecycle and an adapter registry.
  *Rejected:* it would be designed before enough concrete adapters exist to
  generalize from, and no existing `bob` subsystem shares such a trait. Approach
  B — intake handle + config + supervision, with adapters as ordinary subsystem
  actors — matches the codebase and defers the polymorphic contract until two
  real adapters exist to generalize from.
- **Fully external adapters via an intake socket now.** Let external programs
  submit ready-made requests over a socket from day one. *Rejected for this
  spec:* it adds a security-relevant socket surface before it is needed. The
  intake handle is instead shaped so that socket can be added later without
  reshaping the core (see Exclusions).
- **Building all Phase 6 channels at once.** *Rejected:* email, scheduler, and
  any future channels each carry channel-specific transport concerns.
  Establishing the framework separately keeps this spec small and lets each
  channel be specified with its transport properly considered.

## Amendment Log

| Date | What changed | Why | Affected tasks |
|------|-------------|-----|----------------|
| 2026-06-23 | Interactive-chat adapter removed from the active spec; the channel-adapter framework (intake handle, configuration, supervision wiring) remains active and is used by later adapters such as S-009 scheduler. | CR-002 routes interactive chat through a supervised direct `pi` session, bypassing and retiring the admin-socket chat subscription path. | T-107, T-108 |
| 2026-06-30 | Framework workflow changed from unconditional pre-flight identity check to concrete-adapter admission model; scheduler exception recorded. | ADR-012 / CR-004 move scheduler admission to the Unix trust boundary and trusted schedule store, while leaving the common intake doorway intact. | Scheduler amendment tasks TBD |
