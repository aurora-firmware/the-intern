---
id: ADR-008
title: Single-user-local deployment scope
status: accepted
created: '2026-06-13'
---

# ADR-008: Single-user-local deployment scope

## Context

The logical model (`system_overview.md`) and S-001 were written with multi-user
language: S-001's design principles call for "per-user isolation" with "one
process per active user-session" so "a data-scoping fault cannot cross users,"
and ADR-005 reasons about "a small trusted user set" and "one OS account
[proxying] many real people."

In practice the committed product is narrower: **the-intern runs as a long-lived
service for a single user on their own machine.** Subsequent decisions already
lean on this — ADR-005 makes the OS filesystem-permission gate the entire trust
boundary, the control plane is local-only (ADR-007), and the v1 ingress is local
and pull-based. Those decisions are coherent only against a single-user-local
deployment, but that scope had never been recorded; the concrete architecture
record began reinterpreting the system around it while S-001 still committed the
broader multi-user model. This ADR records the scope explicitly so the artifact
set agrees, and states the upgrade path so nothing is foreclosed.

Forces and constraints:

- The design goal is simplicity before complexity: the smallest mechanism
  consistent with the logical model.
- A single OS account is the trust domain; the filesystem gate already enforces
  exactly that (ADR-005).
- Channels are additive by construction: the deterministic core is typed by
  delivery kind and never enumerates channels (ADR-004), so narrowing the
  channel set now does not constrain the core later.

## Decision

The committed deployment scope is **one user, one machine, one OS/trust-domain
account**. The architecture is designed for, and only required to satisfy, that
deployment. Concretely:

1. **Trust boundary.** The service-owner uid is the entire trust domain; the
   socket filesystem-permission gate is the security boundary (ADR-005). No
   cross-user isolation is promised.
2. **Isolation rationale.** One pi-agent process per active session still holds,
   but its purpose is isolating *concurrent contexts of the one user* (e.g. an
   interactive chat and a scheduled job at the same time), not separating
   different people. Queue-borne request context and supervised pi session
   identity are separate concerns, settled by the relevant request-intake and
   supervisor specs rather than by this ADR.
3. **Identity.** "Single user" is about the OS/trust-domain account, **not** the
   number of application identities. The self-asserted-identity model (ADR-005)
   still carries multiple application-level identities and channels behind that
   one uid — for example a chat `sender` asserted over the socket, or the
   scheduler's adapter-assigned, job-derived identity (S-009). Policy and audit
   operate on those application identities.
4. **Ingress.** The service exposes no inbound network listener. Synchronous
   input arrives over `admin.sock`; asynchronous input is obtained by polling on
   a schedule (e.g. email via the scheduler driving a skill). The committed
   channel set is therefore interactive chat, scheduler, and email-by-polling.
5. **Secrets.** `bob` custodies no secrets. Actions use the user's own existing
   credential stores under the same uid. Least privilege is the uid boundary plus
   invocation-time Policy Control verdicts; there is no per-Action capability
   sandbox (an Action runs with the full authority of the service uid).

This narrows the per-user language in S-001 and the logical model; S-001 is
amended to reference this ADR. `system_overview.md` remains the implementation-
agnostic logical model and is not rewritten around the deployment scope.

**Upgrade path (nothing foreclosed).** If the-intern ever needs to admit a
second OS user, a remote/semi-trusted caller, or an inbound network channel, that
is a deliberate revisit of this ADR and of ADR-005's trust model (real end-user
authentication, a network ingress, per-Action isolation as needed). Because
channels are additive (ADR-004) and the control plane's UDS-only stance is scoped
to the operator surface, such additions are new work, not a redesign.

## Consequences

### Positive

- The artifact set is internally consistent: the trust model, control plane,
  ingress, and credential decisions all have a recorded scope that justifies
  them.
- Maximum simplicity now — no multi-user policy partitioning, no secret vault, no
  network-auth story — without contradicting approved specs.
- The single OS-account assumption matches what the filesystem gate already
  enforces, so there is no gap between the documented and the enforced boundary
  (modulo the tracked `extension.sock` bind bug).

### Negative

- The product cannot serve multiple OS users or remote callers without revisiting
  this ADR and ADR-005. This is an accepted, deliberate limitation, not an
  oversight.
- Some S-001 text (per-user isolation, the broader channel list) is narrowed;
  readers must follow the amendment to this ADR.

### Neutral

- The application-identity model is unchanged: multiple senders/channels behind
  one uid remain first-class, which is what keeps policy and audit meaningful and
  what makes a future multi-user upgrade a matter of changing the gate, not the
  identity model.

## Alternatives Considered

### Alternative A: Keep the multi-user architecture as committed scope

**Description:** Retain S-001's per-user isolation and multi-user trust set as the
required scope; treat single-user-local as merely the first deployment.
**Rejected because:** It forces the system to carry multi-user machinery (policy
partitioning by OS user, an OS-uid-to-user story, a real cross-user trust
boundary) that the actual product does not need, contradicting the simplicity
goal — and it leaves ADR-005, ADR-007, and the ingress design (all single-user
by assumption) unjustified.

### Alternative B: Leave the scope unrecorded and reinterpret per document

**Description:** Do not record a scope decision; let each document assume whatever
deployment it needs.
**Rejected because:** That is the exact inconsistency this ADR resolves — the
concrete architecture record had begun assuming single-user while S-001 still
committed multi-user. An unrecorded scope cannot be reasoned about or revisited.
