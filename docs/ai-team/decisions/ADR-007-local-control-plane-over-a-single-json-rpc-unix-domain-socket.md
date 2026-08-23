---
id: ADR-007
title: Local control plane over a single JSON-RPC Unix-domain socket
status: accepted
created: '2026-06-13'
---

# ADR-007: Local control plane over a single JSON-RPC Unix-domain socket

## Context

`bob` is a long-lived daemon. Operating it — checking it is alive, listing and
killing stuck pi-agent sessions, reloading policy and schedules without
downtime, tailing the audit log — requires a request/response channel that the
logical architecture (`system_overview.md`) deliberately never described: that
document models the data plane (Requests Handler → Policy Control → Agent
Harness → Actions) and the functional components, not day-2 operability.

In practice an operator surface accreted across the implementation specs and was
never named as one architectural element:

- S-002 introduced `admin.sock` and the `bob` CLI as "the public control
  surface," but fixed only the framing, transport, and authentication — not the
  method catalogue, and not the architecture-level decision.
- S-005 mounted `report.submit` and `audit.tail` on the same socket; S-009
  mounted `schedule.*`. S-006/S-008 previously mounted `chat.*`; CR-002 later
  retired that request-pipeline chat path and replaced it with supervised
  interactive-session control over the same socket.
- ADR-001 fixed the wire framing; ADR-003 placed the client in the `bob` binary;
  ADR-005 reshaped the trust model.

The result is real and load-bearing, but it had no single decision record. Two
*data-plane* interfaces the logical model already names — interactive chat and
Monitoring's inbound report interface — also depend on this transport, so it
cannot simply be removed. This ADR records the control plane as a deliberate
architectural element and pins its shape.

Forces and constraints:

- Transport is local Unix-domain sockets only (S-002); no HTTP/gRPC/TCP.
- The trust boundary is filesystem permissions, not peer credentials (ADR-005).
- The deployment is single-user-local (ADR-008): every caller is the one
  service-owner uid.
- The operator surface co-evolves with subsystem features; it must be cheap to
  add methods without reshaping the transport.

## Decision

`bob serve` exposes a **single local control plane**: JSON-RPC 2.0,
newline-delimited (ADR-001), over one dedicated Unix-domain socket `admin.sock`,
owned by the `admin-rpc` component. The `bob` CLI is its client; its non-`serve`
subcommands are thin JSON-RPC clients (ADR-003).

Several logically distinct interfaces are mounted on this one transport:

| Surface | Methods | Origin |
|---|---|---|
| Operator control | `service.status`, `sessions.list`/`kill`, `policy.reload`, `schedule.add`/`remove`/`list`/`reload` | new (this plane) |
| Live observability | `audit.tail.subscribe`/`unsubscribe` | new (this plane) |
| Interactive chat | `session.interactive.open` / attach lifecycle for a supervised pi session | CR-002 / ADR-011 |
| External action reporting | `report.submit` | S-005 Monitoring interface |

**Trust model (honest).** Admission to the socket is gated solely by filesystem
permissions: the listener creates an owner-only (`0700`) parent directory and a
`0660` socket file, which restricts connections to the service-owner uid.
`SO_PEERCRED` is read only as an optional audit signal, **not** as an admission
gate (ADR-005). The same gate is the intended invariant for `extension.sock`;
the production bind does not yet enforce it, tracked as a bug rather than papered
over here.

**The chat and report surfaces are not new architecture.** Monitoring's inbound
report interface rides `admin.sock` because it is the one local transport that
already exists. Interactive `bob chat` now uses `admin.sock` as a control-plane
request to open and attach to a supervised pi session; chat turns do not traverse
the queue-borne Requests Handler → Policy Control path (ADR-010).

**Configuration and persistent state.** Some methods apply operator changes to
live subsystems and signal the owning subsystem to reload. `policy.reload`
re-reads static config; `schedule.*` mutates the dedicated schedule state store
defined by ADR-012 and reloads the scheduler. Mutable runtime state is kept out
of `config.toml` unless an owning ADR explicitly says otherwise.

> **Amended (ADR-012, 2026-06-30).** The original `schedule.*` example used
> `[schedule]` in `bob.toml` as its source of truth. ADR-012 replaces that with
> `$XDG_STATE_HOME/bob/schedules.json` and keeps the same admin-socket method
> family as the authorized mutation path.

> **Amended (S-012, 2026-08-23).** "Its non-`serve` subcommands are thin
> JSON-RPC clients" overstates the rule. This decision governs the *control
> plane*: everything that reaches the running service does so over `admin.sock`,
> and no second transport is introduced. It does not require every subcommand to
> reach the service. `bob init` (S-012) is filesystem-only and never contacts a
> running service, and further filesystem-only subcommands are consistent with
> this ADR. The invariant is that a subcommand needing the service uses this
> plane and only this plane; a subcommand needing nothing from the service uses
> nothing. Recorded when the S-014 draft review found the original wording had
> been false since `bob init` shipped.

## Consequences

### Positive

- The architecture record names the control plane instead of leaving it implicit
  across five specs and three ADRs.
- One transport, one framing, one gate — reused by every operator verb and by
  the two data-plane interfaces that need a local client↔daemon channel.
- Adding an operator method is a leaf change: a new JSON-RPC method on an
  existing socket, no transport or trust reshaping.

### Negative

- The operator surface and the external-tool `report.submit` surface share one
  socket and one trust role. Acceptable while every caller is the same-uid local
  user; revisited only if external tools ever need a different trust level (see
  Open question below).
- A single socket is a single point of compatibility: the JSON-RPC method
  catalogue is now an externally observable contract that must evolve carefully.

### Neutral

- The control plane is local-only by construction; there is no remote operator
  access, consistent with ADR-008. Remote operation would be a separate decision
  that also triggers the ADR-005 trust-boundary revisit.

## Open question (deferred)

`report.submit` is an external-tool interface sharing the operator socket. While
all callers are same-uid local processes this is fine. If external Actions and
human operators ever need different trust levels, split the report interface onto
its own socket (`report.sock`) or add per-method authorization. No action while
ADR-008 holds; tracked here so the seam is explicit.

## Alternatives Considered

### Alternative A: Separate sockets per concern

**Description:** One socket for operator control, one for chat, one for
`report.submit`.
**Rejected because:** Under the single-user-local trust model (ADR-008) all
three share the same gate and the same trust role, so the split buys no security
and multiplies socket-management, path-discovery, and lifecycle surface. The seam
is kept available (see Open question) for the day the trust roles actually
diverge.

### Alternative B: HTTP or gRPC control API

**Description:** Expose the control plane over a loopback HTTP/gRPC endpoint.
**Rejected because:** It contradicts S-002's UDS-only stance, replaces the
OS-enforced filesystem gate with an application-level auth story the system does
not otherwise need, and opens a network-shaped surface on a single-user-local
product. JSON-RPC-over-UDS gives request/response and subscriptions with the
filesystem as the gate.

### Alternative C: No control plane — config files plus signals only

**Description:** Operate the daemon by editing config files and sending signals;
no request/response interface.
**Rejected because:** It cannot express the operations the daemon actually needs
(inspect/kill a live session, tail audit, return a typed status), and it leaves
the two data-plane interfaces (`chat.*`, `report.submit`) with no transport at
all. The CLI subcommands are defined in terms of these calls; without the plane
they cannot function.
