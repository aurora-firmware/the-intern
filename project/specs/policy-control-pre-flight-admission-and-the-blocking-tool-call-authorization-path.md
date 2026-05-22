---
title: 'Policy Control: pre-flight admission and the blocking tool_call authorization
  path'
version: '0.1'
status: approved  # draft | review | approved | superseded
created: '2026-05-20'
author: planner
id: S-004
---

# Policy Control: pre-flight admission and the blocking tool_call authorization path

## Purpose

S-001 names Policy Control as the deterministic component that decides
authorization both when a request enters the system and when the agent later
asks to run an action — and S-001 Phase 4 owes "pre-flight checks and the
blocking `tool_call` authorization path over the Unix socket". Today neither
gate is real: the `policy-control` crate is a scaffold actor that returns
`NotImplemented`, and `extension-ipc::multiplex` answers every `Authz` frame
with a hardcoded `allow: false, "policy not implemented"` verdict, so no
supervised agent could ever run a tool even though the wire frames exist. The
pre-flight side does function — `requests-handler::run_preflight` enforces an
`allowed_user_ids` list — but it lives outside Policy Control and shares no
config or reload path with the action gate.

This spec is triggered now because Phases 2 (supervision) and 3 (event
forwarding) are complete: supervised pi-agent sessions run and the `bob.ts`
extension is installed and forwarding events, so the blocking `tool_call` hook
finally has both ends to connect. When this spec is delivered, a tool call made
by a supervised agent is allowed only if it matches an explicit, operator-defined
rule; everything else is denied deterministically by the service, outside the
agent process; the existing user admission check is governed by the same
component; and an operator can change the ruleset without restarting `bob`.

## Exclusions

What this specification explicitly does NOT cover:

- **Per-user or role-scoped action rules.** Action (`tool_call`) rules are
  global and service-wide; they do not depend on which user triggered the
  agent. the-intern has no role model and no human-meaningful identity today —
  a `UserId` is an opaque UUID. Scoping action rules by user or role is
  deferred until a real identity/role model exists, and is a separately
  justified later spec.
- **Agent skills.** S-001 Component 3's third bullet (providing pi-agent with
  skills) and S-003 both park skills "alongside the Phase 4 authorization
  hook". This spec delivers the authorization hook only; agent skills remain
  deferred to a later spec.
- **Deny / exception rules.** The action model is allow-only: a rule grants,
  and the absence of a matching rule denies. There are no deny rules and no
  allow-with-exception rules. A narrow restriction is expressed by writing an
  allow rule whose argument matchers only match the permitted shape.
- **File-watch hot-reload.** Reload is triggered explicitly via an admin-RPC
  method. The service does not watch the config file for changes.
- **Monitoring changes.** The append-only audit log and the inbound report
  interface are S-001 Phase 5. This spec emits verdict observability through
  the existing `tracing` and audit-record surfaces only; it adds no new
  Monitoring subsystem behaviour.
- **Channel-aware admission rules.** Pre-flight admission keeps its current
  shape — a flat allow-list of `UserId`s. Admission rules that also discriminate
  by channel are out of scope for this spec.

## Architecture

### Design Principles

- **Deterministic policy outside the agent.** Both verdicts are computed by the
  Rust service from explicit rules. The agent process never sees, supplies, or
  influences the ruleset, and cannot assert its own authorization.
- **One ruleset, two gates.** Admission (pre-flight) and action (`tool_call`)
  are evaluated against a single in-memory ruleset loaded from one config
  source with one reload path. There is no second, divergent policy store.
- **Default-deny, allow-only.** Anything not matched by an explicit allow rule
  is denied. This holds for both gates and for every failure mode.
- **Fail closed.** Any inability to reach a verdict — transport failure, a
  verdict that does not arrive within a bounded timeout, malformed input,
  internal error — resolves to a block, never an allow.
- **The hot path takes no round-trip.** Verdict evaluation is a pure,
  synchronous function over an immutable ruleset snapshot. Neither gate hands
  off to an actor to get a verdict; the `tool_call` path adds no scheduling
  hop between the agent's request and the answer.
- **The agent is not in the identity path.** The `tool_call` authorization
  request carries the session, the tool, and the arguments — nothing the agent
  could forge into an identity claim. Action rules consult no user, so no
  user identity crosses the extension boundary.

### System Diagram

```
+----------------------------- bob serve (Rust) ------------------------------+
|                                                                             |
|   bob TOML config ---load---> +--------------------------------------+      |
|        ^ re-read              |  policy-control crate                |      |
|        |                      |   PolicyEngine (pure, sync, no I/O)  |      |
|   admin.sock                  |   ruleset snapshot behind ArcSwap    |      |
|   policy.reload --command---> |   policy-control actor (owns config, |      |
|                               |     handles reload, swaps snapshot)  |      |
|                               +-----+--------------------+-----------+      |
|                                     | evaluate           | evaluate        |
|                       admission     | (inline)           | (inline) action |
|                                     v                    v                 |
|   inbound queue --> Requests Handler           extension-ipc::multiplex      |
|                       (pre-flight gate)          (Authz gate)                |
|                                                       ^   | AuthzVerdict     |
+-------------------------------------------------------+---+------------------+
                                                        |   |  extension.sock
                                              Authz     |   v
+---------------------------- pi-agent process ---------+----------------------+
|   pi --mode rpc        bob.ts extension: blocking tool_call hook             |
|                          - on tool call: send Authz { session, tool, args } |
|                          - await AuthzVerdict (bounded timeout)             |
|                          - allow -> tool runs;  block / timeout -> denied   |
+------------------------------------------------------------------------------+
```

### Responsibility Separation

| Component | Responsibility | Notes |
|---|---|---|
| `PolicyEngine` (policy-control) | Pure, synchronous evaluation of an admission request or an action request against an immutable ruleset snapshot, returning a verdict | No I/O, no async; the unit-test surface of this spec |
| Ruleset snapshot | Immutable in-memory representation of the active admission allow-list and action allow-list, cheaply shareable and atomically swappable | Held behind a lock-free cell; readers never block writers |
| policy-control actor | Owns the canonical config, builds the initial snapshot, processes the reload command, publishes new snapshots | Thin; not on the verdict hot path |
| Requests Handler (pre-flight gate) | Evaluates each dequeued request's `sender` against the admission ruleset via the engine; forwards on allow, denies and audits on block | Replaces the standalone `allowed_user_ids` check; behaviour preserved |
| `extension-ipc::multiplex` (action gate) | On each inbound `Authz` frame, evaluates `(tool, arguments)` against the action ruleset via the engine and routes the resulting `AuthzVerdict` back | Replaces the hardcoded deny verdict |
| `bob.ts` extension | Hosts pi-agent's blocking `tool_call` hook; sends an `Authz` request, awaits the verdict under a bounded timeout, returns allow/block to pi; fails closed | New behaviour on the existing extension |
| admin-RPC surface | Exposes a `policy.reload` method that instructs the policy-control actor to re-read config and swap the snapshot | New method on the existing `admin.sock` |

## Components

### Component 1: `PolicyEngine` and the ruleset snapshot

**Purpose:** Decide, deterministically and without I/O, whether an admission
request or an action request is allowed by the current ruleset.
**Estimated size:** Medium — the core logic of the spec, including the argument
matcher, but pure functions over plain data.
**Interfaces:** *Exposes* a synchronous admission evaluation (over a `UserId`)
and a synchronous action evaluation (over a tool name and an `arguments` JSON
value), each returning a `PolicyVerdict`; a constructor that builds a ruleset
snapshot from validated config data. *Consumes* the ruleset snapshot type.
No async, no sockets, no actors.

### Component 2: policy-control actor and config loading

**Purpose:** Own the canonical policy config, build the live snapshot at
startup, and atomically replace it when a reload is requested.
**Estimated size:** Small — replaces the existing scaffold actor; most of the
work is config parsing and validation.
**Interfaces:** *Exposes* a shareable read handle to the current snapshot for
the two gates, and a reload entry point for the admin-RPC layer. *Consumes*
bob's TOML configuration (the policy section). On a reload it re-reads config,
validates it, and either swaps the snapshot or rejects the reload, leaving the
previous snapshot in force.

### Component 3: Pre-flight gate (Requests Handler)

**Purpose:** Replace the standalone `allowed_user_ids` membership test so
request admission is decided by the shared engine.
**Estimated size:** Small — a substitution inside the existing
`run_preflight` path, preserving its observable behaviour.
**Interfaces:** *Consumes* the engine's admission evaluation and the snapshot
read handle. *Produces* the same outcomes as today — forward on allow; drop,
`tracing::warn!` without payload, and append a `PreflightDenied` audit record
on block.

### Component 4: Action gate (`extension-ipc::multiplex`)

**Purpose:** Replace the hardcoded deny verdict so inbound `Authz` frames get a
real action verdict.
**Estimated size:** Small — a substitution at the existing `Authz` match arm.
**Interfaces:** *Consumes* an inbound `Authz` frame (session, tool, arguments)
and the engine's action evaluation. *Produces* an `AuthzVerdict` outbound frame
routed back to the originating session.

### Component 5: `bob.ts` blocking `tool_call` hook

**Purpose:** Gate every pi-agent tool call through Policy Control before it
runs.
**Estimated size:** Medium — new bidirectional behaviour on an extension that
was one-way in Phase 3, including request/verdict correlation and the timeout.
**Interfaces:** *Hosts* pi-agent's blocking `tool_call` hook. *Produces* an
`Authz` request frame on `extension.sock`. *Consumes* the matching
`AuthzVerdict` frame. *Lifecycle:* on transport failure, an unparable verdict,
or a verdict that does not arrive within the bounded timeout, it returns a
block to pi and logs one warning.

### Component 6: `policy.reload` admin-RPC method

**Purpose:** Let an operator apply a config change to the live ruleset without
restarting `bob`.
**Estimated size:** Small — one new method on the existing JSON-RPC surface.
**Interfaces:** *Exposes* a `policy.reload` method on `admin.sock`. *Produces* a
success response when the snapshot is swapped, or an error response (with the
validation reason) when the new config is rejected and the previous snapshot is
retained.

## Workflow

End-to-end flow for the action gate, from a tool call to a verdict:

```
pi-agent is about to run a tool
  ↓
bob.ts blocking tool_call hook fires
  → sends Authz { session, tool, arguments } on extension.sock
  ↓
extension-ipc parses the frame, multiplex evaluates it
  → PolicyEngine.evaluate_action(tool, arguments) against the live snapshot
  ↓
multiplex routes AuthzVerdict { session, verdict } back to the session
  ↓
bob.ts receives the verdict within the bounded timeout
  → allow: hook returns allow, the tool runs
  → block: hook returns block, the tool call is denied, session continues
  ↓
(transport failure or timeout at any point → hook returns block, warns once)
```

Pre-flight admission gate:

```
Requests Handler dequeues an internal event with its RequestContext
  ↓
PolicyEngine.evaluate_admission(context.sender) against the live snapshot
  → allow: event is enqueued onward
  → block (or missing context): event dropped, warn without payload,
    PreflightDenied audit record appended
```

Operator reload:

```
Operator edits the policy section of bob's TOML config
  ↓
Operator calls policy.reload on admin.sock
  ↓
policy-control actor re-reads and validates config
  → valid: new snapshot built and atomically swapped; success response
  → invalid: previous snapshot retained; error response with the reason
  ↓
Subsequent verdicts (both gates) evaluate against whichever snapshot is in force
```

## Configuration Requirements

The deliverable rests on a policy section in bob's existing TOML configuration
(ADR-002: TOML via figment).

### Admission ruleset

- **What:** the set of `UserId`s permitted to submit requests. **Why:** it is
  the pre-flight identity gate.
- **Where:** the policy section of bob's TOML config. The existing
  `allowed_user_ids` key is the migration source; whether it is renamed or
  relocated under the policy section is a breakdown decision, but its meaning
  is preserved.
- **Constraints:** each entry is the string form of a `UserId` (a UUID).
- **Default behavior:** a missing or empty admission list denies all requests
  (unchanged from today's `run_preflight`).

### Action ruleset

- **What:** a list of allow rules for tool calls. **Why:** it is the global,
  service-wide action gate. **Contract:** the model is allow-only — a tool
  call is permitted only if some rule matches it.
- **Each rule** names a tool and carries an optional set of argument matchers:
  - A rule with no argument matchers allows that tool for any arguments.
  - A rule with argument matchers allows the tool only when **every** matcher
    passes.
  - Each argument matcher names a field path within the call's `arguments`
    JSON object and a glob pattern; the matcher passes when the value at that
    path is present and matches the glob. The exact glob syntax and the
    field-path syntax are a breakdown decision, but the semantics above are the
    contract.
- **Where:** the policy section of bob's TOML config.
- **Default behavior:** a missing or empty action list denies all tool calls.
  A tool absent from the list is denied. A rule referencing a field path that
  the call's arguments do not contain fails that matcher, and therefore the
  rule does not allow the call.

### Verdict timeout

- **What:** the bounded time `bob.ts` waits for an `AuthzVerdict` before
  failing closed. **Why:** a wedged or slow service must not hang the agent
  indefinitely.
- **Where:** surfaced to the extension through the existing env-var contract
  the supervisor already populates (S-003), so the operator does not configure
  the extension directly.
- **Constraints:** a positive duration.
- **Default behavior:** if no value is supplied the extension applies a
  built-in default timeout; expiry of the timeout is a block.

### Reload

- **What:** the `policy.reload` admin-RPC method. **Why:** it applies config
  changes to the live ruleset without a restart.
- **Constraints:** a reload that fails validation is rejected as a whole; the
  previously active snapshot stays in force. There is no partial application.
- **Default behavior:** without a `policy.reload` call the ruleset loaded at
  startup remains in force for the life of the process.

## Implementation Order

| Phase | What | Depends On |
|---|---|---|
| 1 | `PolicyEngine` and the ruleset snapshot: pure synchronous admission and action evaluation, the argument matcher, and snapshot construction from validated rule data. Unit-tested in isolation. | Nothing |
| 2 | Config loading and the policy-control actor: parse the policy section of bob's TOML config into a snapshot, replace the scaffold actor, expose a shareable snapshot read handle. | Phase 1 |
| 3 | Pre-flight gate migration: route `run_preflight`'s admission decision through the engine, preserving observable behaviour and audit output. | Phase 2 |
| 4 | Action gate: replace the hardcoded deny verdict in `extension-ipc::multiplex` with a real action evaluation; remove the unused `user` field from the `Authz` frame. | Phase 2 |
| 5 | `bob.ts` blocking `tool_call` hook: send the `Authz` request, correlate and await the `AuthzVerdict` under the bounded timeout, fail closed on any failure. | Phase 4 |
| 6 | `policy.reload` admin-RPC method: re-read and validate config, atomically swap the snapshot, report success or the rejection reason. | Phase 2 |

## Open Questions

- **Async blocking verdict (carried from S-001).** The design requires
  pi-agent's `tool_call` hook to accept an *asynchronous* allow/block verdict —
  the hook must be able to suspend while the `Authz`/`AuthzVerdict` round-trip
  completes. This must be verified against the pi-agent source before Phase 5
  is implemented; the spec-breakdown skill is expected to call out an explicit
  verification step. `[TODO]`
- **Glob and field-path syntax.** The argument matcher's glob dialect and the
  `arguments` field-path syntax are left to task breakdown; the matching
  *semantics* in Configuration Requirements are the contract. `[TODO]`

## Alternatives Considered

- **Central policy-control actor mediating every verdict (Approach A).** Both
  gates would send an evaluation request to the actor and await a verdict over
  a channel. Rejected because it puts an actor round-trip on the latency-
  sensitive `tool_call` path for no correctness gain: the chosen pure-engine +
  `ArcSwap`-snapshot design keeps one source of truth and a single reload
  command stream while letting both gates evaluate inline and lock-free.
- **Leaving pre-flight as a standalone `allowed_user_ids` check.** Rejected
  because the human asked for a unified policy model: one config source and one
  reload path should govern both gates. The pre-flight *rule shape* is
  unchanged, but it now lives behind the same engine.
- **Per-user or role-scoped action rules.** Rejected for v1 — see Exclusions.
  No identity or role model exists to scope against; action rules are global.
- **Deny / allow-with-exception rules.** Rejected for v1 — see Exclusions. The
  allow-only model is simpler to audit; narrow restrictions are expressed as
  narrow allow rules.

## Amendment Log

<!-- Optional. Use when an approved spec is amended after tasks are in flight.
| Date | What changed | Why | Affected tasks |
|------|-------------|-----|----------------|
| YYYY-MM-DD | Description of change | Reason for amendment | T-XXX, T-YYY |
-->
