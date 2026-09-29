---
title: Bob Service Shell Architecture
version: '0.2'
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
| Pi-agent Supervisor actor | Scaffold for S-001 Phase 2 work — owns the warm pool, spawn/reap, and prompt routing; starts every pi process — pool workers and interactive `bob chat` sessions — with the settings defined in Configuration → pi-agent process settings, building the arguments both kinds share in one place; forwards pool workers' stderr to the service log; supports acquiring a session under a caller-supplied cwd for per-entry scheduled jobs | Warm workers carry the service-wide settings; a per-entry-cwd request needs a dedicated worker (see Component 6) |
| Persistence actor | Scaffold for the inbound queue, audit log, and session state stores | Empty implementation; trait-only |
| `bob` client subcommands | Thin clients over the local control plane; resolve socket path from config, open `admin.sock`, perform one call (or one subscription, for `audit tail`), render results, exit. `bob chat` is the exception in shape but not ownership: it requires the running service and requests a supervised interactive `pi` session rather than feeding the request-intake path. Filesystem-only subcommands, which contact no service at all, are a separate category owned by their own specifications. | No business logic |

## Components

### Component 1: `bob` binary

**Purpose:** The single executable. Parses the subcommand and either runs the
service (`bob serve`) or runs an admin-RPC client. Hosts configuration loading
and the discovery rules for socket paths.
**Estimated size:** Small — argument parsing, configuration, dispatch.
**Interfaces:**
- *Subcommands:* `serve`, `status`, `sessions list`, `sessions kill`,
  `audit tail`, `policy reload`, `chat` (the catalogue is illustrative and
  grows with later phases; not every later subcommand is a service client — see
  Component 7).
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

**The warm-pool contract.** The supervisor starts every pool worker with the
service-wide pi-agent process settings (see Configuration), including an
explicit working directory: `pi_agent_cwd` when set, otherwise the inherited
launch cwd. Warm-pool workers are pre-spawned at service start with those
settings, so they can only be reused by requests that want them. A request
that supplies its own working directory (a per-entry scheduled job with an
explicit `cwd`, per S-009) therefore **cannot** reuse a warm worker: the
supervisor must spawn a **dedicated** worker in the requested directory, with
every other service-wide setting unchanged. That dedicated worker forgoes
warm-pool latency and consumes one `max_processes` slot for the duration of
the run.

**Worker stderr.** The supervisor reads every pool worker's stderr and writes
each line to the service log at warning level, tagged with the worker's
session. pi reports start-up failures there — for example a `pi_agent_model`
it does not recognize — and the bob extension uses stderr for its warning or
shutdown error when it has no UI to report through (S-003). An
interactive session's stderr is the user's own terminal and is not captured.

**When a worker never accepts the prompt.** Starting a worker does not wait
for pi to become ready, and handing out a warm worker does not check that it
is still running. A worker whose pi exited at start — for example because
`pi_agent_model` names a model pi does not recognize — is therefore only
discovered when a prompt is sent to it. For a scheduled fire, the dispatcher
then logs a warning, kills the session, and skips the fire; the entry fires
again on its next tick. No monitoring record is written: no session ran, and
the cause is already in the service log through the worker's stderr. A dead
warm worker stays in the pool until a fire picks it up and meets this
outcome, so at most the warm-pool size of them exist at once and none leak.
bob does not probe workers or validate the model ahead of time.

**When `max_processes` is exhausted.** Acquisition of a per-entry-cwd worker is
bound by `max_processes` exactly like any other spawn: when active plus warm
workers already fill the limit, the acquisition is refused rather than evicting
a live worker or exceeding the bound. Because scheduled runs are
fire-and-forget `periodic` deliveries with no caller to receive a receipt, a
refused acquisition **skips that fire** with a logged warning and a monitoring
failure record; the schedule entry remains and fires again on its next tick.

### Component 7: `bob` client subcommands

**Purpose:** Operator and user surface. A subcommand that needs the running
service is a thin JSON-RPC client over `admin.sock` and uses no other transport
(ADR-007). A subcommand that needs nothing from the service — for example
`bob init` (S-012), `bob task` (S-014), and `bob worklog` (S-015) — is
filesystem-only and never opens the socket.
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
  membrane, not by pre-flight request admission (ADR-010). The interactive `pi`
  session runs in the working directory where `bob chat` is invoked, and is
  otherwise started with the pi-agent process settings that apply to
  interactive sessions (see Configuration) — `pi_agent_model` among them, but
  not the pool-only `pi_agent_cwd` or `pi_agent_args`.
- *Rendering:* human-readable by default; `--json` for machine consumption
  on every subcommand.

## Workflow

End-to-end flows the shell must support on day one.

```
Service start
  bob serve
    ↓
  load configuration; init tracing
    → invalid configuration (e.g. a model flag in pi_agent_args): exit with a
      configuration error
    → pi_agent_model unset: log one warning naming the missing key
    ↓
  construct subsystem actors; obtain handles; pre-spawn warm workers
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
    - the pi-agent process settings for interactive sessions (Configuration),
      including --model <pi_agent_model> when set
    - the extension wiring S-003 defines: --extension <resolved bob.ts path>,
      BOB_SESSION_ID, BOB_EXTENSION_SOCK_PATH (and BOB_SKILL_INSTALL_PATH
      when a skill path is resolved)
    - the invocation cwd of bob chat
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

Configuration lives in `config.toml`. Service-wide settings are flat top-level
`snake_case` keys (ADR-002); a subsystem that needs more reserves its own table
(see Subsystem placeholders). Keys belonging to a later subsystem are defined
when that subsystem lands.

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

### pi-agent process settings

bob starts pi in two ways: as an RPC **pool worker** — warm or dedicated —
for queued requests and scheduled fires, and as an **interactive session** for
`bob chat`. Every setting that shapes a pi process is one flat key, and each
applies to exactly the kinds of process the table below marks. Each concern is
settable through exactly one key: no two keys may supply the same pi setting.

| Key | Pool workers | Interactive sessions |
|---|---|---|
| `pi_agent_command` | yes | yes |
| `pi_agent_args` | yes | no |
| `pi_agent_model` | yes | yes |
| `pi_agent_cwd` | yes | no — the session runs in the `bob chat` invocation cwd |
| `extension_path` (S-003) | yes | yes |
| `skill_install_path` | yes | yes |
| `pi_agent_warm_pool_size`, `pi_agent_max_processes`, `pi_agent_idle_reap_timeout` | pool sizing and reaping | no |

Every pi process also receives the extension wiring S-003 defines
(`--extension` and the `BOB_*` environment variables). The supervisor builds
the arguments shared by both kinds of process in one place, so a setting that
applies to both cannot reach one and silently miss the other — the same drift
ADR-014 guards against for skill delivery.

- **pi executable (`pi_agent_command`).** The command bob runs to start pi.
  *Default:* `pi`, resolved on `PATH`.
- **Pool-worker arguments (`pi_agent_args`).** Extra arguments passed
  verbatim to every pool worker, and only to pool workers. *Default:*
  `--mode rpc`, which pool workers require. *Constraints:* must not contain a
  model-selecting pi flag — `--model`, `--models`, or `--provider`. Config load
  rejects such a value with a configuration error that names `pi_agent_model`
  as the place to set the model.
- **pi-agent model (`pi_agent_model`).** *What:* an optional pi model
  pattern — anything pi accepts for its `--model` flag, such as
  `provider/id`, optionally with a thinking-level suffix. bob passes it
  verbatim as `--model <value>` to every pi process it starts, pool workers
  and interactive sessions alike, and does not interpret, list, default, or
  validate it. *Why bob sets it:* without `--model`, pi chooses the model from
  its own saved settings. pi rewrites that saved choice whenever a model is
  selected in any session, and when the saved model no longer resolves it
  silently falls back to another model. Given an explicit `--model` it does
  not recognize, pi instead reports the error and exits before any provider
  request. *Missing-value behaviour:* unset → no `--model` is passed and pi
  uses its own saved choice (backward compatible). bob then logs one warning
  at startup that names the missing `pi_agent_model` key, says that pi will
  choose the model from its own saved settings, which can change or fall back
  to a different model without notice, and says to set `pi_agent_model` in the
  service configuration. *Invalid value:* bob runs no startup or pre-fire
  check. A pool worker started with a model pi does not recognize logs pi's
  error through its stderr and exits (see Component 6 for what happens to
  the fire); an interactive session shows the error in the user's terminal.
- **pi-agent worker working directory (`pi_agent_cwd`).** The service-wide
  working directory the supervisor gives every pi-agent RPC worker it spawns
  for the `bob serve` pool. *What must exist:* an optional key naming the
  directory workers run in. *Constraints:* when set it must be an **absolute**
  path; a relative value is rejected at config load with a clear
  configuration error. *Missing-value behaviour:* unset → workers inherit the
  launch cwd of the `bob serve` process (backward compatible and the v1
  default). *Existence handling (lazy / spawn-time):* directory existence is
  **not** gated at config load and does **not** fast-fail service startup; a
  set-but-missing `pi_agent_cwd` surfaces at worker spawn time as a logged
  (warned) worker-spawn failure through the supervisor's existing
  child-process error path (and, for a scheduled firing, is skipped with a
  warning like any other spawn failure). Operators are advised to set an
  explicit workspace so pi's context-file (`AGENTS.md`/`CLAUDE.md`) and
  relative-path resolution are predictable. Skills are **not** affected by
  this key: bob supplies them independently of the working directory
  (ADR-014, S-011).
- **Skill install path (`skill_install_path`).** The directory bob supplies to
  pi as the source of agent skills. *Constraints:* absolute when set;
  security-relevant, since its content reaches every session bob spawns
  (ADR-014 §7). *Missing-value behaviour:* unset resolves to the ADR-009
  `data` default alongside the extension; set-but-missing or empty is
  **fail-open** — the session starts without skills and a warning is logged.
  This differs deliberately from `extension_path`, which is fail-closed.

**Operator documentation.** The user manual's configuration reference and
quickstart, and the bob-companion plugin's `bob-setup` skill, document these
keys, including that `pi_agent_model` is the one place to set the model and
how to confirm a chosen value by hand (`pi --list-models <search>` for the
model's exact name, `pi auth check --provider <p> --json` for the provider's
credentials — checks that confirm a value but do not guarantee it). The
operator guide carries a migration note for configurations that set the
model through `pi_agent_args`, and the `bob-troubleshooting` skill maps the
failure symptoms — the startup warning, a "model not found" line in the
service log, a scheduled job that ran but did nothing — to the same checks.
`README.md` records the pi version this behaviour was verified against; this
spec does not.

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
| 2026-07-05 | Added the service-wide `pi_agent_cwd` config key (absolute-only; default = inherit launch cwd; existence handled lazily at spawn time — no startup gate); the supervisor spawns workers with an explicit resolved cwd; documented that a per-entry-cwd scheduled job spawns a dedicated worker (no warm-pool reuse), consumes a `max_processes` slot, and — when the pool is exhausted — skips that fire with a warning rather than blocking or evicting; clarified that `bob chat` ignores `pi_agent_cwd` and uses the invocation cwd. | CR-005. | T-119, T-121, T-122, T-126, T-127, T-129 |
| 2026-08-06 | Added the service-wide skill install path config key (absolute-only; default = the ADR-009 `data` location alongside the extension; set-but-missing is fail-open with a warning, unlike the fail-closed `extension_path`). Removed skills from the `pi_agent_cwd` guidance, since skills no longer resolve from the working directory. | ADR-014 accepted 2026-08-06 / S-011. | S-011 breakdown tasks (Gate 2 pending). |
| 2026-08-23 | Component 7, the Responsibility table, and the Component 1 subcommand catalogue no longer claim that every non-`serve` subcommand is a thin JSON-RPC client. A subcommand needing the service uses `admin.sock` and only `admin.sock`; a filesystem-only subcommand contacts nothing. | The claim has been false since S-012's `bob init` shipped, which is filesystem-only and never opens the socket; ADR-007 was amended the same day. Found by the architecture consistency review of the S-014 draft. | None (documentation reconciliation only). |
| 2026-08-27 | Component 7's filesystem-only-subcommand example list generalized from `bob init` (S-012) alone to also name `bob task` (S-014) and `bob worklog` (S-015), so the passage reads as an example set rather than an exhaustive enumeration of one. | Found by the architecture consistency review of the S-015 draft: the same drift Component 7 already had once (see the 2026-08-23 entry) recurred because the passage names an example rather than stating the rule generically. | None (documentation reconciliation only). |
| 2026-09-28 | Configuration restructured: the keys that shape a pi process (`pi_agent_command`, `pi_agent_args`, `pi_agent_model`, `pi_agent_cwd`, `extension_path`, `skill_install_path`, and the pool-sizing keys) are gathered under a new "pi-agent process settings" subsection with one table stating which apply to pool workers and which to interactive `bob chat` sessions, and a rule that each pi setting is settable through exactly one key. `pi_agent_command` and `pi_agent_args` are specified for the first time (they existed only in code); `pi_agent_args` is pool-only and must not contain `--model`, `--models`, or `--provider`. New key `pi_agent_model`, passed as `--model` to every pi process bob starts; unset keeps pi's own saved choice and logs one startup warning naming the missing key. The supervisor forwards pool workers' stderr to the service log (Component 6, Responsibility table). Component 6 gains the outcome of a worker that never accepts the prompt (warning, session killed, fire skipped, no monitoring record) and the precise dead-warm-worker behaviour. Component 7 and the interactive-chat workflow now defer to the settings table instead of restating per-key rules; the service-start workflow gains the config-validation and unset-model warning steps. Operator-documentation deliverables recorded. | CR-015 (from GitHub issue #104), its Architecture Consistency Review (2026-09-28), and human decisions: no pre-fire model check and no new audit record (the service log is sufficient); the model is set in one place only. Restructuring rather than appending: the settings-to-process mapping previously lived in scattered one-off sentences, which is how `bob chat` came to receive none of `pi_agent_args` without any spec saying so. | Tasks TBD (breakdown pending) |
| 2026-09-29 | Component 6's "Worker stderr" now says the bob extension's warning *or shutdown error* reaches the service log, instead of "its single degradation warning". | S-003's 2026-09-29 reconciliation: since GitHub issue #112 the extension reports one error and shuts the pi session down when its transport to bob is lost, rather than only warning. Found by that reconciliation's Architecture Consistency Review. | None (documentation reconciliation) |
