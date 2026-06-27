---
title: Bob Service Shell Architecture
version: '0.1'
status: approved  # draft | review | approved | superseded
created: '2026-05-16'
author: planner
id: S-002
---

# Bob Service Shell Architecture

## Purpose

S-001 (the-intern Agent Service Architecture) defines *what* the Rust service
must contain — channel adapters, a Requests Handler, Policy Control, Monitoring,
a pi-agent process supervisor — and the two trust boundaries that surround it.
It is deliberately silent on *how* the binary is shaped: process model, runtime
topology, where module boundaries fall, how the operator and the agent's JS
extension reach the service, and how a future GUI or programmatic client can
talk to it.

This specification defines that shell. It describes the binary, the runtime
topology that hosts every subsystem named in S-001, the public IPC surfaces the
binary exposes, the CLI that wraps the same binary, and the runtime-agnostic
library crate that holds the deterministic core. It does **not** implement any
of the subsystems themselves — those are scaffolded with their port traits and
left empty, to be filled by the phases listed in S-001.

The expected outcome is a service skeleton on which Phases 1 through 7 of
S-001's implementation order can land without re-litigating shape: subsystems
fit into existing actor slots, the admin and extension transports already
exist, and the operator already has a working binary to drive them.

## Exclusions

What this specification explicitly does NOT cover:

- **Subsystem business logic.** Policy rules, audit storage, pi-agent process
  lifecycle, channel adapter implementations, persistence schemas, and the
  agent prompt-delivery wiring are all out of scope. This spec defines where
  each subsystem lives, its port trait, and how it is wired into the runtime —
  not how it works internally.
- **GUI.** No graphical client is built. The admin surface is designed so that
  a GUI can be added later as another client of the same JSON-RPC API, but no
  GUI work happens in this spec.
- **Windows support.** S-001's "OS-agnostic technology" design principle is
  amended in this spec to "Unix-likes (Linux and macOS)". The shell relies on
  Unix domain sockets and POSIX peer-credentials; porting to Windows is a
  later, separately-justified effort.
- **Alternative admin transports.** No HTTP, HTTPS, gRPC, Windows named pipes,
  or TCP-loopback variants of the admin surface. UDS with JSON-RPC 2.0 is the
  sole transport.
- **Socket multiplexing.** Admin traffic and JS-extension traffic share neither
  socket nor schema. They are kept on separate UDS endpoints because they have
  different trust profiles and different evolution rates.
- **Extension protocol changes.** The JS-extension UDS (`extension.sock`)
  preserves the contract from S-001 unchanged. This spec only fixes its path
  and how the supervisor wires it.
- **Monitoring report interface for external action CLIs.** S-001 Component 1
  lists a third inbound surface — used by external action CLIs to self-report
  the actions they performed — and leaves its transport as an open question
  (local HTTP endpoint or a small reporting CLI). This shell spec defers that
  surface entirely: it neither builds it nor pre-commits a transport for it.
  The decision is reopened as an Open Question below and remains the open
  question already noted in S-001.
- **Action CLI tooling.** External CLIs invoked by the agent are out of scope,
  as in S-001.

## Architecture

### Design Principles

- **Unix-likes only, by design.** The shell relies on UDS and POSIX file
  permissions for local trust (POSIX peer-credentials are read only as an audit
  signal). This is a deliberate amendment to
  S-001's OS-agnostic principle — restated narrowly so future readers know it
  was a choice, not an oversight.
- **Actor handles, not a central bus.** Each subsystem owns its state and is
  reached only through a clonable typed `Handle`. There is no service-wide
  event enum and no single dispatcher task. Concurrency is bounded per
  subsystem and back-pressure is observable at each handle.
- **Runtime-agnostic core.** Domain types, port traits, and verdict/audit/event
  shapes live in a library crate (`bob-core`) with no Tokio dependency. I/O,
  timers, sockets, and process control live exclusively in adapter crates.
- **Two sockets, by audience.** The admin surface and the JS-extension surface
  have unrelated trust models and unrelated schemas. Splitting them keeps the
  high-trust extension protocol stable while letting the admin protocol evolve.
- **One binary, many subcommands.** The same `bob` executable both runs the
  service (`bob serve`) and acts as every operator-facing client. Distribution,
  versioning, and configuration discovery have one anchor.
- **Backpressure is explicit.** Bounded channels everywhere, per the Rust
  coding guidelines; a full queue is a typed service state, not a hidden stall.

### System Diagram

```
+-------------------------------------------------------------------+
|  bob (single binary)                                              |
|                                                                   |
|  +-- bob serve (long-lived service) -----------------------+      |
|  |                                                         |      |
|  |   Tokio runtime                                         |      |
|  |                                                         |      |
|  |   admin-rpc actor  <----------+                         |      |
|  |   extension-ipc actor  <------|---+                     |      |
|  |   requests-handler actor  <---|---|---+                 |      |
|  |   policy-control actor  <-----|---|---|---+             |      |
|  |   monitoring actor  <---------|---|---|---|---+         |      |
|  |   pi-agent-supervisor actor   |   |   |   |   |         |      |
|  |   persistence actor           |   |   |   |   |         |      |
|  |                               |   |   |   |   |         |      |
|  |        wired in main.rs ------+---+---+---+---+         |      |
|  |        domain types & port traits in `bob-core`         |      |
|  +---------------------------------------------------------+      |
|                                                                   |
|  +-- bob {status, sessions, audit, policy, chat, ...} -----+      |
|  |   admin-rpc CLIENT — opens admin.sock, sends/receives    |      |
|  |   JSON-RPC 2.0 calls and subscription notifications      |      |
|  +---------------------------------------------------------+      |
+--------+-----------------------+----------------------------------+
         |                       |
         | admin.sock            | extension.sock
         | (UDS, JSON-RPC 2.0,   | (UDS, S-001 schema,
         |  notifications for    |  auth verdicts +
         |  subscriptions;       |  event forwarding;
         |  filesystem-gated,    |  filesystem-gated,
         |  peer-cred audited)   |  peer-cred audited)
         v                       v
   bob CLI / future GUI       pi-agent JS extension
   / programmatic clients     (one connection per session,
                               multiplexed by session id)
```

The two sockets are independent transports owned by independent actors. The
admin actor never sees extension traffic and vice versa.

### Responsibility Separation

| Component | Responsibility | Notes |
|---|---|---|
| `bob` binary | Single executable; entry-point dispatch to `serve` or a client subcommand | One crate, one build artefact |
| `bob serve` runtime | Owns the Tokio runtime, signal handling, configuration load, tracing init, actor construction and wiring, and the graceful-shutdown protocol from the Rust coding guidelines | Lives in the binary crate; depends on every subsystem crate |
| `bob-core` library crate | Pure domain types (events, verdicts, audit records, identifiers) and the port traits each subsystem exposes; no Tokio | Imported by every subsystem and by the binary |
| Admin-RPC actor | Owns `admin.sock`; accepts connections, enforces the filesystem-permission gate (`SO_PEERCRED` audited, not a gate — ADR-005), frames JSON-RPC 2.0, dispatches method calls to subsystem handles, and serializes subscription notifications back to subscribers | Public surface; method catalogue evolves over time |
| Extension-IPC actor | Owns `extension.sock`; preserves the S-001 schema for auth verdicts and event forwarding; multiplexes by session id | Stable contract; do not co-mingle with admin traffic |
| Requests Handler actor | Scaffold for S-001 Phase 1 work — owns the inbound internal-event queue and pre-flight identity attachment | Empty implementation in this spec |
| Policy Control actor | Scaffold for S-001 Phase 4 work — accepts verdict requests over its handle, returns allow/block | Empty implementation; pre-loaded with a deny-by-default stub |
| Monitoring actor | Scaffold for S-001 Phase 5 work — accepts events and report records, exposes a subscription stream for admin-RPC | Empty implementation; uses an in-memory ring buffer for early development |
| Pi-agent Supervisor actor | Scaffold for S-001 Phase 2 work — owns the warm pool, spawn/reap, and prompt routing | Empty implementation; `bob sessions list` shows the (currently empty) pool |
| Persistence actor | Scaffold for the inbound queue, audit log, and session state stores | Empty implementation; trait-only |
| `bob` client subcommands | Thin clients over the local control plane; resolve socket path from config, open `admin.sock`, perform one call (or one subscription, for `audit tail`), render results, exit. `bob chat` is the exception in shape but not ownership: it requires the running service and requests a supervised interactive `pi` session rather than feeding the request-intake path. | No business logic |

## Components

### Component 1: `bob` binary

**Purpose:** The single executable. Parses the subcommand and either runs the
service (`bob serve`) or runs an admin-RPC client. Hosts configuration loading
and the discovery rules for socket paths.
**Estimated size:** Small — argument parsing, configuration, dispatch.
**Interfaces:**
- *Subcommands:* `serve`, `status`, `sessions list`, `sessions kill`,
  `audit tail`, `policy reload`, `chat` (the catalogue is illustrative and
  grows with later phases).
- *Configuration:* layered, per the Rust coding guidelines — defaults, config
  file, environment, CLI flags; concrete keys are defined in later phases.
- *Exit codes:* zero on success, a stable non-zero taxonomy for the typed
  service errors named in the Rust coding guidelines.

### Component 2: `bob-core` library crate

**Purpose:** Runtime-agnostic deterministic core. Holds the types every
subsystem speaks in, and the port traits each subsystem exposes.
**Estimated size:** Small to start; grows as subsystems land.
**Interfaces:**
- *Domain types:* `InternalEvent`, `RequestContext`, `SessionId`,
  `PolicyVerdict`, `AuditRecord`, `MonitoringReport`, plus the typed error
  enum families called out in the Rust coding guidelines.
- *Port traits:* `RequestsHandler`, `PolicyEngine`, `AuditSink`, `EventBus`,
  `SessionPool`, `PersistenceStore`. Each is an `async` trait whose methods
  are the public surface of the corresponding actor.
- *No Tokio dependency.* The crate compiles without any async runtime. Actors
  in adapter crates implement these traits over Tokio primitives.

### Component 3: `bob serve` runtime

**Purpose:** The long-lived service process. Wires every actor together,
exposes the two sockets, runs the supervision and shutdown protocols.
**Estimated size:** Small in this spec (wiring only); grows in later phases.
**Interfaces:**
- *Lifecycle:* a single Tokio runtime; signal handling for `SIGTERM`/`SIGINT`;
  the shutdown protocol from §8 of the Rust coding guidelines (stop intake,
  cancel workers, drain queues, terminate pi-agent children, flush audit,
  exit).
- *Wiring:* constructs each subsystem actor, hands every adapter the handles
  it needs, and never exposes a raw channel to client code.
- *Observability:* initialises `tracing` once, emits spans for every
  significant lifecycle event (socket bind, actor start, actor stop, child
  spawn/reap, shutdown phases).

### Component 4: Admin-RPC actor and `admin.sock`

**Purpose:** The public control surface — for the `bob` CLI today, for the
programmatic API and any later GUI.
**Estimated size:** Medium.
**Interfaces:**
- *Transport:* Unix domain socket at `$XDG_RUNTIME_DIR/bob/admin.sock` on
  Linux, `$TMPDIR/bob-$UID/admin.sock` on macOS; the path is overridable in
  configuration. The directory is created with mode `0700`, the socket with
  mode `0660`.
- *Authentication:* the socket's filesystem permissions are the sole connection
  gate — an owner-only (`0700`) parent directory restricts connections to the
  service-owner uid (ADR-005). `SO_PEERCRED` (`LOCAL_PEERCRED` on macOS) is read
  only as an optional audit signal, not a gate; there is no in-service uid
  allow-list. Admitting additional uids, if ever needed, is done with a Unix
  group (`chgrp` on the socket and a correspondingly relaxed directory mode),
  not bob configuration.
- *Wire protocol:* JSON-RPC 2.0 with newline-delimited frames over a
  persistent connection. Standard request/response and notification forms.
- *Subscriptions:* a method that opens a subscription returns a subscription
  id; the server then emits JSON-RPC notifications carrying that id until the
  client unsubscribes or disconnects. This is the mechanism for `bob audit tail`
  (audit events) and any future live view.
- *Error model:* the typed service errors from `bob-core` map to JSON-RPC
  error objects with a stable code table. No raw user content, credentials, or
  policy-controlled data is included in error data (per Rust coding
  guidelines §5).
- *Method catalogue:* defined per-subsystem during the corresponding phase;
  this spec fixes the framing, transport, and authentication, not the
  catalogue.

### Component 5: Extension-IPC actor and `extension.sock`

**Purpose:** The JS-extension channel from S-001 — auth verdicts and event
forwarding, one connection per pi-agent session, multiplexed by session id.
**Estimated size:** Small in this spec (transport + framing only); grows when
S-001 Phases 3 and 4 land.
**Interfaces:**
- *Transport:* Unix domain socket at `$XDG_RUNTIME_DIR/bob/extension.sock` on
  Linux, `$TMPDIR/bob-$UID/extension.sock` on macOS; overridable.
- *Authentication:* same gate model as `admin.sock` — filesystem permissions are
  the gate, `SO_PEERCRED` is audit-only (ADR-005); the extension always runs
  under the same uid as the service.
- *Schema:* preserved from S-001 unchanged. This spec does not introduce or
  change message types on the extension surface.
- *Multiplexing:* every frame carries a session id; the actor dispatches to
  the supervisor's per-session record.

### Component 6: Subsystem scaffolds

**Purpose:** Reserve the seats for S-001's subsystems so later phases land
without re-shaping the runtime. Each subsystem is one crate, one actor, one
port trait in `bob-core`.
**Estimated size:** Each scaffold is small (trait, actor struct, handle,
construction).
**Interfaces:**
- *Requests Handler, Policy Control, Monitoring, Pi-agent Supervisor,
  Persistence* — see the Responsibility Separation table for their role.
  Method bodies in this spec return `ServiceError::NotImplemented` (or the
  appropriate typed equivalent). The supervisor exposes a `list_sessions`
  method that returns an empty list, so `bob sessions list` works end-to-end
  from day one.

### Component 7: `bob` client subcommands

**Purpose:** Operator and user surface; every non-`serve` subcommand is a
thin JSON-RPC client.
**Estimated size:** Small.
**Interfaces:**
- *Socket discovery:* read the same configuration the service uses; default
  paths as above.
- *Single-shot subcommands* (`status`, `sessions list`, `policy reload`,
  …): open `admin.sock`, send one JSON-RPC call, render the response, exit.
- *Streaming subcommands* (`audit tail`): open `admin.sock`, send a
  subscription call, render notifications as they arrive until the user
  interrupts or the server closes.
- *Interactive chat:* `bob chat` requires the running service, asks it to open a
  supervised interactive pi session, and brokers the caller's terminal to that
  service-owned child. It is gated by socket access and the `tool_call` authz
  membrane, not by pre-flight request admission (ADR-010).
- *Rendering:* human-readable by default; `--json` for machine consumption
  on every subcommand.

## Workflow

End-to-end flows the shell must support on day one.

```
Service start
  bob serve
    ↓
  load configuration; init tracing
    ↓
  construct subsystem actors; obtain handles
    ↓
  bind admin.sock and extension.sock (perms 0660, dir 0700)
    ↓
  install signal handlers; mark ready; spin
```

```
Admin client call
  bob status (or any non-serve subcommand)
    ↓
  resolve admin.sock path from config
    ↓
  connect; server enforces the filesystem-permission gate (peer uid audited)
    ↓
  send JSON-RPC 2.0 request frame
    ↓
  admin-rpc actor dispatches to the matching subsystem handle
    ↓
  receive response frame; render; exit
```

```
Subscription (audit tail)
  bob audit tail
    ↓
  connect; subscribe via JSON-RPC call → subscription id returned
    ↓
  server emits JSON-RPC notifications carrying the subscription id
    ↓
  client unsubscribes (or disconnects); server tears down the subscription
```

```
Interactive chat
  bob chat
    ↓
  resolve and connect to admin.sock
    ↓
  request session.interactive.open
    ↓
  bob serve starts a supervised pi child with:
    - BOB_SESSION_ID
    - BOB_EXTENSION_SOCK_PATH
    - --extension <resolved bob.ts path>
    - caller terminal fds brokered via SCM_RIGHTS (ADR-011)
    ↓
  pi owns the interactive UI; bob supervises, monitors, and reaps the child
```

```
Extension verdict request (S-001 path; shell perspective only)
  pi-agent JS extension opens extension.sock; sends session-tagged frame
    ↓
  extension-ipc actor decodes; forwards to policy-control handle
    ↓
  verdict returned; actor writes the response frame back, session-tagged
```

```
Graceful shutdown
  SIGTERM received
    ↓
  stop accepting new admin connections; close listener
    ↓
  cancel subsystem workers; drain bounded queues up to deadline
    ↓
  reap pi-agent children (idle first, then active, then forced kill)
    ↓
  flush audit; close sockets; exit with logged reason
```

## Configuration

Behavioural — concrete keys are defined when each subsystem lands.

- **Socket paths.** `admin_sock_path` and `extension_sock_path` default to
  `$XDG_RUNTIME_DIR/bob/admin.sock` and `…/extension.sock` on Linux, and to
  `$TMPDIR/bob-$UID/admin.sock` and `…/extension.sock` on macOS. Both
  overridable; both must lie under a directory the service can create with
  mode `0700`.
- **Connection gate.** Admission is by filesystem permissions only: the socket
  lives behind an owner-only (`0700`) parent directory, so only the
  service-owner uid can connect (ADR-005). There is no `admin_allowed_uids` /
  `admin_allowed_gid` config; to admit additional uids, `chgrp` the socket to a
  shared group and relax the directory mode.
- **Queue bounds.** Every bounded mpsc has a configurable capacity, with safe
  defaults. The configuration surface names each queue explicitly so operators
  can tune backpressure per subsystem.
- **Shutdown deadlines.** The drain, child-reap, and forced-kill deadlines
  from §8 of the Rust coding guidelines are configurable, with safe defaults.
- **Tracing.** Log level, formatter (development vs. JSON), and span sample
  rate. Audit log destinations are configured separately when Monitoring lands.
- **Subsystem placeholders.** Each subsystem reserves its own configuration
  table (`[policy]`, `[monitoring]`, `[supervisor]`, …) so that later phases
  add keys without restructuring the file.

## Implementation Order

| Phase | What | Depends On |
|---|---|---|
| 1 | `bob-core` library crate: domain types, port traits, error taxonomy | Nothing |
| 2 | `bob` binary skeleton: argument parsing, subcommand dispatch, config loader, tracing init | Phase 1 |
| 3 | `bob serve` runtime wiring: Tokio runtime, signal handlers, actor construction with placeholder implementations of every port trait, graceful shutdown | Phase 2 |
| 4 | Admin-RPC actor: `admin.sock` listener, filesystem-permission gate (`SO_PEERCRED` audited), JSON-RPC 2.0 framing, subscription notification plumbing, error mapping | Phase 3 |
| 5 | Extension-IPC actor: `extension.sock` listener, filesystem-permission gate, S-001 framing, session-id multiplex; placeholder verdict path that returns deny-by-default | Phase 3 |
| 6 | `bob` client subcommands: socket discovery, `status`, `sessions list`, `audit tail` (subscription), `chat` (subscription + input), `policy reload`, `--json` rendering | Phase 4 |
| 7 | Integration tests: end-to-end shell tests (start service → connect from `bob` client → observe shutdown), backpressure on the admin queue, filesystem-permission gate denial, malformed-frame rejection | Phase 4, Phase 5, Phase 6 |

S-001's phases 1 through 7 land *into* this shell by filling in the subsystem
actors created in phase 3 above; their port traits and seats are already
present.

## Open Questions

- **Admin-RPC framing detail.** Newline-delimited JSON is assumed for v1. If a
  later subscription stream needs interleaved large payloads, length-prefix
  framing may be preferable. The choice does not change any external contract
  with the CLI as long as it is fixed before phase 6. `[TODO]`
- **Admin group convention.** If multi-uid access is ever needed, which Unix
  group to `chgrp` the socket to (e.g. `bob`, `wheel`) and how packaging sets it
  up. Default is uid-only access via the `0700` directory; revisit when
  packaging lands. `[TODO]`
- **Configuration format.** TOML is the conventional Rust default and aligns
  with the project's existing `.ai-team.toml`. Confirm during phase 2.
  `[TODO]`
- **Crate boundary for the admin client.** Whether the JSON-RPC client used
  by `bob`'s non-`serve` subcommands should live in `bob-core` (reusable by a
  future Rust GUI) or in the binary crate. `[TODO]`
- **Monitoring report transport for external action CLIs.** S-001 leaves the
  transport for the external-tool reporting interface open (local HTTP
  endpoint or a small reporting CLI). The shell does not pre-commit. Two
  options stay live: extend `admin.sock` with a `report.*` method family
  (cheap, but mixes the operator and tool-reporting trust roles on one
  socket), or introduce a third UDS (`report.sock`) dedicated to that
  audience. Either way it stays UDS+JSON-RPC, not HTTP. The decision lands
  before S-001 Phase 5 (Monitoring) starts. `[TODO]`

## Amendment Log

| Date | What changed | Why | Affected tasks |
|------|-------------|-----|----------------|
| 2026-06-13 | Reconciled the connection-gate description with ADR-005: filesystem permissions are the sole admission gate, `SO_PEERCRED` is audit-only, and the in-service uid allow-list (`admin_allowed_uids`/`admin_allowed_gid`) is removed (additional uids via a Unix group instead). Updated the Responsibility table, Components 4–5 authentication, the system diagram and workflow labels, the Configuration and Open-Questions sections, and Implementation Order Phases 4/5/7. | ADR-005 (accepted 2026-05-22) removed the peer-credential gate and the uid allow-list, but S-002's gate wording was never updated; PR #22 reconciles the artifact set. | None (gate already implemented per ADR-005; documentation reconciliation only). |
| 2026-06-23 | `bob chat` redefined: it requires the running service and launches a supervised, directly-launched interactive `pi` session (exempt from pre-flight admission, ADR-010) instead of feeding the admin-socket interactive-chat adapter. The obsolete chat-subscription workflow was removed from the active spec text. | CR-002. | T-103, T-104, T-105, T-106, T-107, T-108 |
