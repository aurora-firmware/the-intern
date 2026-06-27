---
id: ADR-010
title: Interactive chat is exempt from pre-flight admission
status: accepted
created: '2026-06-23'
---

# ADR-010: Interactive chat is exempt from pre-flight admission

## Context

S-004 defines per-user **pre-flight admission**: `PolicyEngine.evaluate_admission`
checks a request's `sender` against the `[policy] admitted_users` allow-list, and
this check runs **inside the Requests Handler** when it dequeues an `InternalEvent`
from the internal event queue. ADR-005 additionally requires every request to carry
a self-asserted application identity and rejects unidentified requests at intake.

CR-002 makes `bob chat` launch a **service-owned interactive `pi` session**. Such a
session does not traverse the chat-adapter → intake handle → internal queue →
Requests Handler path, so pre-flight admission has **no point of enforcement** for it
(Gate-1 architectural finding, 2026-06-23). Keeping a "no bypass; admission via
`config.toml`" wording would therefore be unenforceable.

Forces and constraints:

- **ADR-008** scopes the product to single-user, local deployment. The per-user
  admission allow-list adds little there: the operator is the sole user, and socket
  access is already gated to that uid by the 0700 trust boundary.
- The **action-level** `tool_call` authorization hook (S-004), hosted by the bob
  extension, is the gate that actually constrains what a session can do, and it
  remains available for interactive sessions (the session is supervised, so the
  extension is loaded and connected).

## Decision

**Interactive chat sessions are exempt from per-user pre-flight admission.** Their
security gates are:

1. **Socket access** — the 0700 owner-only Unix-socket trust boundary (ADR-005 /
   ADR-007 "Layer 1 is the real gate").
2. **The blocking `tool_call` authorization hook** hosted by the bob extension (S-004
   action gate), which remains fully in force.

The interactive `pi` session is **owned and supervised by `bob serve`** so the
extension membrane and monitoring are in effect (without which gate 2 would be inert).

Pre-flight admission (`admitted_users`) **remains in force for non-interactive /
programmatic intake** (for example the scheduler adapter) that does traverse the
Requests Handler.

This **amends** S-004 (pre-flight admission applies to queue-borne requests, not to
interactive chat) and the ADR-005 intake-rejection expectation **for the
interactive-chat channel**. It does not supersede either decision.

## Consequences

### Positive

- Removes an admission gate that has no enforcement point for a directly-launched
  session and little value under single-user-local; aligns with the intent to drop the
  per-user UUID check.
- Keeps the meaningful gate — action-level `tool_call` authorization — fully intact.
- Lets CR-002 proceed without inventing a second admission entry point.

### Negative

- Interactive chat is no longer identity-gated at intake; acceptable **only** under the
  single-user-local trust model (ADR-008). Must be revisited if multi-user is ever in
  scope.
- The `config.toml` `admitted_users` stopgap (currently admitting the chat default
  identity — including the `scripts/bob-dev-config` entry added earlier) becomes
  unnecessary for chat once this is implemented and can be removed for that channel.

### Neutral

- Non-interactive channels keep pre-flight admission; the policy ruleset and hot-reload
  path are unchanged.
- The chat session still carries an application identity for audit/monitoring; only the
  admission *gate* is removed for it.

## Alternatives Considered

### Alternative A: Launch-boundary admission check

**Description:** Keep a per-session admission check, performed by the service at the
moment `bob chat` launches/attaches a session, against the live ruleset.
**Rejected because:** it adds a second admission entry point and machinery to enforce a
gate of little value under single-user-local. Revisit if multi-user becomes a goal.

### Alternative B: Keep chat on the admin-socket pipeline

**Description:** Keep `bob chat` as a JSON-RPC client whose turns flow through the
Requests Handler, preserving pre-flight admission unchanged.
**Rejected because:** it contradicts CR-002's goal of a direct interactive `pi` session
and re-scopes the work onto the retired S-006/S-008/CR-001 admin-socket chat path
rather than launching pi.
