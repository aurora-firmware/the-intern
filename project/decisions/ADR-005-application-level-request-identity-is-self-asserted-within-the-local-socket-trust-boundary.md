---
id: ADR-005
title: Application-level request identity is self-asserted within the local-socket trust boundary
status: accepted
created: '2026-05-22'
---

# ADR-005: Application-level request identity is self-asserted within the local-socket trust boundary

## Context

The Intern has two distinct layers of identity, and they were never connected.

**Layer 1 — the transport trust gate.** bob's clients connect over Unix-domain
sockets (`admin.sock`, `extension.sock`). Each listener creates the socket in a
parent directory it chmods to `0o700` (owner-only) and sets the socket file to
`0o660`. Because the parent directory is owner-only, the operating system
already restricts connections to the **service-owner uid**. The listeners
*additionally* read the peer uid via `SO_PEERCRED` and check it against a
configured uid allow-list — but, behind the `0o700` directory, that allow-list
is unreachable for any non-owner uid and grants nothing the filesystem does not
already enforce. The filesystem permissions are the real gate.

**Layer 2 — per-request identity.** Once a connection is open, each inbound
request needs an identity attributed to it — the `sender` carried in its
`RequestContext` — consumed by the requests-handler pre-flight admission check,
the policy engine's rules, and monitoring/audit.

The two layers were never connected. The connecting peer's OS identity is used
only to admit or refuse the connection, then discarded. The interactive-chat
adapter (S-006) builds a `RequestContext` for every chat message but, lacking a
real identity to place in it, uses an anonymous generated `UserId`. As a result
pre-flight admission and policy cannot meaningfully authenticate the caller of a
chat message.

Forces and constraints:

- `SO_PEERCRED` reports only a numeric OS uid (plus gid/pid). It cannot vouch
  for *which program* is running or *which application-level user* is acting.
- A process name or command line is reachable from the pid, but it is racy (pid
  reuse) and forgeable (the peer chooses its own executable name). It is
  unusable as an authentication signal.
- Transport is local Unix-domain sockets only (S-002). The socket's parent
  directory is chmod'd `0o700` on every bind, so the connection gate admits
  only the service-owner uid.
- The codebase holds three unreconciled notions of identity: the application
  `UserId`, the OS uid, and a plain-string user on the extension channel's
  authz frames (`ai-review-report.md`, finding F4).

## Decision

Keep the two layers separate and give each one explicit job.

1. **The socket's filesystem permissions are the transport trust gate.** The
   listener creates the socket behind a `0o700` parent directory with the
   socket file at `0o660`; the owner-only directory restricts connections to
   the service-owner uid. That is the entire connection gate. `SO_PEERCRED` is
   no longer used to gate connections; the peer uid/pid may be read only as an
   optional audit signal. (See *Removed: the in-service uid allow-list*.)

2. **Application-level identity is asserted inside the request.** Every inbound
   request must carry its own application-level origin identity as part of its
   arguments. The adapter/dispatcher copies that asserted identity into the
   request's `RequestContext` `sender`. It is *not* derived from the OS uid.

3. **The asserted identity is honored because the gate vouches for the caller.**
   bob trusts the application identity a request declares because the socket's
   filesystem-permission gate has already established the caller as the trusted
   service-owner uid. This is *asserted identity within a trust boundary*, not
   cryptographic authentication of the end user.

**Threat model, stated explicitly.** Any process running as the service-owner
uid can connect and assert any application identity, including one belonging to
another application user. This is acceptable because that uid *is* the service's
own trust domain — a process running as the service owner can already inspect or
control the service directly. The gate is therefore the real security boundary;
the asserted identity exists for attribution, routing, and policy scoping among
cooperating trusted callers — not as a defense against a hostile caller. If bob
ever broadens socket access beyond the service-owner uid (for example via a
shared Unix group) or otherwise admits semi-trusted callers, this decision must
be revisited and real end-user authentication introduced.

**Validation of the asserted identity.**

- A request that declares no application identity is rejected at intake with a
  clear error. There is no implicit anonymous identity — this replaces the
  current placeholder behavior.
- The identity is validated as structurally well-formed (non-empty, within size
  bounds). Whether it must additionally match a configured or known set of
  identities is left to the implementing task and may start permissive (any
  well-formed identity accepted) and tighten later. This ADR requires only that
  an absent identity is an error and that the value is structurally validated.

> **Amended (ADR-010, 2026-06-23).** The "request rejected at intake without an
> asserted identity" rule above governs requests that traverse the request-intake
> path (chat-adapter → intake → Requests-Handler queue). Under CR-002, **interactive
> chat** runs as a supervised, directly-launched `pi` session that does **not**
> traverse that intake path, so the intake-rejection rule does not apply to it;
> interactive chat is gated by the socket trust boundary (Layer 1) and the
> `tool_call` authz membrane instead (ADR-010). The session still carries an
> application identity for attribution/audit. This narrows the rule for that one
> channel; all other inbound paths are unchanged.

> **Amended (ADR-012, 2026-06-30).** Scheduler jobs are another local-channel
> exception, but only for admission. A scheduled request may still carry
> application identity for attribution and audit, but scheduler firing is
> admitted by trusted schedule-store membership under the Unix trust boundary,
> not by requiring a scheduler-derived `UserId` in `[policy].admitted_users`.

### Removed: the in-service uid allow-list

The previously separate in-service gate — `bob_core::auth::is_allowed` checking
the peer uid against a configured `allowed_uids` list — is removed. Behind the
listener's `0o700` parent directory it is unreachable for any non-owner uid, so
it enforces nothing the filesystem does not already enforce; its only reachable
case is the service-owner uid, which it always admits. It carries code and
configuration surface (`is_allowed`, the `allowed_uids` / `service_uid` config
fields, per-listener plumbing) for no net access control. Removing it makes the
gate a single, OS-enforced mechanism. If bob ever needs to admit a curated set
of additional uids, the standard Unix mechanism applies — a dedicated group,
`chgrp` on the socket, and a correspondingly relaxed directory mode — rather
than a bob-specific config list.

**Scope.** This ADR governs the inbound request path (chat now; email, webhook,
and scheduler later). The extension channel's separate string-form identity on
authz frames is acknowledged as the third representation but is not reshaped
here; reconciling it is follow-on work toward closing F4.

## Consequences

### Positive

- Clear separation of concerns: transport trust is OS-enforced by filesystem
  permissions, application identity is request-declared. Each layer has exactly
  one job.
- The connection gate becomes a single mechanism — socket/directory permissions
  — instead of two overlapping ones, removing dead code and config surface.
- The chat path can be completed: the adapter has a real, request-supplied
  identity to put in `RequestContext.sender`, so pre-flight and policy operate
  on a meaningful sender instead of an anonymous placeholder.
- Policy rules can be written against stable, named application identities
  rather than numeric OS uids or random UUIDs.
- The model extends to future channels and to a future external intake socket:
  each request self-identifies, and only the gate differs per transport.
  ADR-012 narrows scheduler admission specifically; it does not remove
  application identity for attribution or for other adapters.
- No dependence on racy or forgeable signals, and no need for an
  OS-uid-to-user mapping table.

### Negative

- The asserted identity is only as trustworthy as the gate. Misconfigured
  socket or directory permissions — for example a world-traversable parent
  directory — would let an untrusted local process connect and assert any
  identity. The socket's `0o700` directory and `0o660` file modes become
  security-critical and must be enforced on every bind and covered by tests.
- Clients must now always supply an identity; a request omitting it is
  rejected. Existing or ad-hoc callers — and tests — must be updated.
- It does not deliver end-user authentication. If one trusted OS account
  proxies many real people, the model cannot tell them apart on its own.
- Admitting a curated set of additional uids now requires standard Unix group
  configuration rather than a bob config field — more standard, but a change
  for any operator who relied on the (non-functional) allow-list.

### Neutral

- `SO_PEERCRED` is no longer part of the connection gate. Reading the peer
  uid/pid remains available as an optional audit or diagnostic signal —
  recording who connected, and via the pid a best-effort process-name
  breadcrumb — but it is explicitly not an identity or a security input.
- `UserId` remains the application identity type. This ADR does not mandate its
  representation, only that its value originates from the request, not the OS.
- The extension channel's string identity is left as-is for now; full F4
  reconciliation remains open.

## Alternatives Considered

### Alternative A: Derive application identity from the OS uid

**Description:** Make the application user be the `SO_PEERCRED` uid directly —
`RequestContext.sender` becomes the numeric OS account.
**Rejected because:** It binds application identity to local OS accounts. Policy
rules would have to name numeric uids; identity could neither outlive nor differ
from the OS account; and it does not work for a future external intake socket,
where the submitting process is a relay rather than the originating user. It
conflates the gate with identity instead of separating them.

### Alternative B: Map OS uid to a logical user via configuration

**Description:** Maintain a config table from uid to a named application
user/role; the dispatcher looks the request's peer uid up in it.
**Rejected because:** It still ties every application user to a distinct OS
account, and it adds a configuration surface plus an unmapped-uid failure case.
It cannot represent a trusted client — a channel adapter or relay — that
legitimately submits requests on behalf of many different users, which is
exactly the chat case. Self-assertion handles that naturally.

### Alternative C: Cryptographic end-user authentication

**Description:** Each request carries a verifiable credential (a signed token or
shared secret) proving the end user's identity independent of the OS.
**Rejected because:** It is disproportionate to the current local-only,
small-trusted-user-set deployment, and it would require a credential-issuing and
key-management story that nothing else in the system needs yet. The
trust-boundary model is sufficient now; this remains the upgrade path if bob
later admits semi-trusted callers.

### Alternative D: Keep the in-service uid allow-list as defense-in-depth

**Description:** Retain `is_allowed` and the `allowed_uids` config as a second
gate behind the filesystem permissions.
**Rejected because:** Behind the listener's `0o700` parent directory the
allow-list is unreachable for any non-owner uid — it can only ever see the
service-owner uid, which it always admits. It is not a functioning second gate,
so it provides no real defense in depth; it only adds code and configuration
surface and a misleading impression of layered access control. Genuine defense
in depth would require the directory mode and the allow-list to gate *different*
populations, which is not the case here.
