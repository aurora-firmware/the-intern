---
id: ADR-004
title: Inbound request interface typed by delivery kind (sync/async/periodic)
status: accepted
created: '2026-05-21'
---

# ADR-004: Inbound request interface typed by delivery kind (sync/async/periodic)

## Context

S-001 (the-intern Agent Service Architecture) requires that every channel —
synchronous or asynchronous — normalize into the *same* internal event and
follow the same path ("event-driven uniformity"). Channel adapters sit outside
the deterministic core and are the only components that know channel specifics.

The current implementation deviates from this. `InternalEvent` in `bob-core`
(introduced by task T-008) is an enum whose variants name channels directly:
`ChatMessage`, `EmailReceived`, `Webhook`, `Scheduled`. T-008's acceptance
criterion AC-2 explicitly mandated "variants covering chat, email, webhook, and
scheduled triggers." Neither S-001 nor S-002 asked for this — S-002 lists
`InternalEvent` only by name, never defining its shape. The spec-breakdown of
S-002 over-specified, and the core enum now hardcodes channel identity that the
core should not know.

The forces at play:

- The core must stay agnostic to how many channels exist or what they are;
  adding a channel must not require editing a core type.
- Channels do differ in one way the core *does* care about: their
  **delivery and response semantics** — whether a caller is waiting for an
  answer, whether a response can be routed back, and whether the request was
  triggered by a human at all.
- `RequestContext` (sender `UserId`, source `ChannelId`, optional
  `context_id`) is already generic — it carries an opaque channel identifier,
  not a channel-type enum — and does not need to change.

## Decision

`bob-core` exposes a generic inbound request interface typed by **delivery
kind**, not by channel. The core recognizes exactly three kinds. Channel
identity (chat, email, webhook, scheduler, …) lives only in adapters *outside*
the core; an adapter translates heterogeneous external input into one of the
three kinds. The core never enumerates channel types.

The three kinds and their response semantics:

| Kind | On reception | Later | Core behaviour |
|---|---|---|---|
| **sync** | acknowledgement *or* error returned to the caller | the agent's answer is routed back to the same caller | bob-core retains the request context internally until pi-agent produces the answer, then delivers it back over the originating connection |
| **async** | acknowledgement *or* error only | nothing further | context is not retained for a response; any agent-side output is a separate outbound action, not a response to this request |
| **periodic** | nothing returned (no caller to answer) | nothing | timer-triggered; fire-and-forget into the queue |

The acknowledgement/error is a **receipt**: it reports whether the request was
accepted into the queue (and passed the pre-flight identity/access check) or
rejected. It is not the agent's answer. A `sync` caller therefore observes two
things — an immediate receipt, then later the routed-back answer. An `async`
caller observes only the receipt. A `periodic` trigger observes nothing,
because there is no external caller.

The current `InternalEvent` enum (`ChatMessage` / `EmailReceived` / `Webhook` /
`Scheduled`) is superseded by this decision. `RequestContext` is unaffected and
remains the generic carrier of sender, source channel, and context identifier.

This ADR records the decision only. The code reshape of `InternalEvent` and its
consumers (`requests-handler`, `persistence`) is separate corrective work, and
the design of the channel adapters themselves is S-001 Phase 6, both out of
scope here.

## Consequences

### Positive

- Adding a new channel never requires editing a core type — adapters absorb all
  channel-specific knowledge, satisfying S-001's "thin core / adapters outside"
  structure.
- The core handles each request by the one property it genuinely needs — the
  delivery/response contract — rather than by an identity it should not know.
- Response handling becomes explicit and uniform: each kind has a single,
  documented answer for "what, if anything, goes back to the caller."

### Negative

- The shipped `InternalEvent` enum and its consumers must be reshaped; this is a
  change to already-integrated Phase 1 work (T-008, T-026–T-030).
- T-008's acceptance criteria are retroactively wrong; the deviation must be
  recorded so the corrective tasks are not mistaken for new scope.

### Neutral

- `RequestContext` is unchanged; the generic `ChannelId` it already carries is
  exactly the adapter-side identity this decision relies on.
- The kind taxonomy aligns with S-001's existing language ("synchronous or
  asynchronous" channels, "scheduled tasks"); `periodic` simply names the
  scheduled case as its own kind.

## Alternatives Considered

### Alternative A: Keep per-channel variants in the core enum

**Description:** Leave `InternalEvent` as a channel-named enum and extend it with
a new variant for each future channel.
**Rejected because:** It hardcodes channel identity into the deterministic core,
forces a core-type edit for every new channel, and contradicts S-001's
event-driven-uniformity principle and the thin-core design. It was never
required by S-001 or S-002 — only by an over-specified task breakdown.

### Alternative B: A single untyped request with no kind distinction

**Description:** Normalize every channel into one opaque request type carrying
just content and `RequestContext`, with no delivery-kind tag.
**Rejected because:** The core genuinely needs the delivery contract to decide
whether to retain context for a routed-back answer, whether to return only a
receipt, or whether to return nothing. Erasing the distinction would push that
decision somewhere less deterministic or lose it entirely.
