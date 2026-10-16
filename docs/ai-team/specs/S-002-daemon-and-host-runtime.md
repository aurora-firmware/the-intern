---
title: Daemon and host runtime
version: '0.1'
status: draft  # draft | review | approved | superseded
created: '2026-10-16'
author: planner
id: S-002
---

# Daemon and host runtime

## Purpose

S-001 defines conversations, roles and agents, but leaves out the process that runs them: who owns the database, how
it starts, stops and recovers, where its files live, how it reaches models, and what a worker thread is. Every later
spec (control endpoint, policy, scheduler, chat, audit) plugs into that process, so its shape has to be fixed first,
and it has to allow clients that don't exist yet: a desktop GUI, and later a dashboard and remote control from the
LAN. When this spec is done:

- One daemon process owns the-intern's single pi-durable database and runs every conversation in it.
- A kill at any moment loses no committed work. On restart the daemon resumes every unfinished run.
- At most a fixed number of agent runs are active at once. Further work waits in arrival order, across
  restarts.
- Every capability the daemon offers is a service operation that clients, entry points and agent tools all call.
  The service layer knows nothing about transports, so new listeners can be added without changing it.
- Changes in the daemon are published as an observation feed: a snapshot, then deltas. Clients can come and go
  without affecting work.

## Definitions

This spec uses S-001's Definitions. It adds these terms:

| Term | Meaning in this spec |
|---|---|
| Daemon | The single long-running process of the-intern (`bob serve`). It owns the database and runs every agent run. |
| Database | The one pi-durable store (S-001) holding every conversation, entry, pi-durable task, submission and document, plus the daemon's own documents. |
| Instance | One daemon together with its state directory. Two instances share nothing. A second instance with its own state directory is the only hard wall between sets of conversations. |
| Service layer | The set of service operations. It is the only way to read or change the daemon's state from outside the harness. |
| Service operation | One named capability of the daemon, such as "create a conversation" or "submit input". It is either a **read** operation (it observes) or a **control** operation (it changes state or starts work). |
| Caller | Whatever invokes a service operation: a local client through a listener, an entry point (a schedule fire) or an agent tool. The caller states the actor that S-001 attribution records. |
| Listener | A transport that exposes service operations to clients. Listeners are defined in the control-endpoint spec (S-003), not here. |
| Client | A separate process that uses the daemon through a listener: `bob chat`, other `bob` commands, the TUI, the desktop GUI. A client holds no work. |
| Observation feed | The stream of changes the daemon publishes for a scope (the whole instance or one conversation). A subscription gets a snapshot, then deltas. |
| Admission | The daemon's decision on when an agent run may take a worker thread (S-001 R-10). |
| Supervisor | The operating system's service manager (systemd user service or launchd agent). It starts the daemon and restarts it when it exits with an error. |
| Fake model | A deterministic model whose replies are a pure function of the transcript. Used only by tests. |

pi-durable terms (Harness, task, submission, document, extension, registry) keep the meanings given in S-001 and in
`docs/pi-durable-knowledge.md`. "pi agent login" and "pi agent settings" are the user's credentials and
`settings.json` in pi agent's agent folder.

## Exclusions

What this specification explicitly does NOT cover:

- **Network listeners, the LAN dashboard and remote control.** The initial specs expose the daemon only on the local
  Unix socket (S-003). A listener on the LAN, read-only in its first version and later able to control the daemon,
  is planned and gets its own spec. Until then the feature review's exclusion of network ingress stays in force. This
  spec doesn't build any of it, but R-15 to R-17 make the design ready for it.
- **Summary views for remote clients.** A summarised feed that keeps transcript content and tool output on the
  machine is wanted, and is defined later. This spec requires only that the observation feed is the single source
  such a view can be derived from (R-17).
- **The control protocol, routes, client library and the socket's trust gate.** They belong to S-003. This spec
  defines the operations those surfaces expose, not how they are carried.
- **Several devices, a hub, a device registry, tokens and provisioning.** These make up most of durable-pi's weight.
  The-intern runs on one machine for one user.
- **One database per session or conversation.** durable-pi's layout is rejected. S-001 fixes one database per
  instance, and the daemon keeps its own state as documents in that database, not in a second store.
- **Several processes sharing one database, and operating-system threads or worker processes per agent run.**
  pi-durable allows one owner per storage. Worker threads stay a logical capacity unit (R-9).
- **Discovering and loading extensions at runtime.** Only the-intern's own pi-durable extensions, shipped in the
  package, are installed. pi agent extensions, the user's extensions and workspace extensions are never loaded
  (S-001; knowledge base §4.3).
- **Picking up hand edits of the configuration file while running.** The daemon reads the file at startup. A hand
  edit takes effect at the next restart, which is cheap because every run resumes. Settings changed through service
  operations apply at once (R-22). Policy reload belongs to S-004.
- **Configurable capacity limits.** The worker-thread count and the invocation depth cap are built-in constants
  (R-9), not settings.
- **Policy, approvals, the role prompt and skills, the scheduler, chat, audit and packaging.** Each has its own spec.
  This spec gives them the host, the service layer and the observation feed they build on. Packaging ships the
  supervisor unit files that R-4 requires.
- **Retention and archiving of old conversations.** Storage only grows. A retention policy is a later decision.
- **Compatibility across pi-durable versions.** The pi packages are pinned, and no backwards compatibility of the
  database is promised (AGENTS.md). The daemon records the versions that opened the database (R-20) but doesn't
  migrate.
- **Windows, Linux arm64 and Intel macOS.** These remain unsupported.

## Architecture

### Design Principles

- **One owner per database.** At most one daemon process opens an instance's database. Nothing but the daemon reads
  or writes it, including history, which clients read through the service layer.
- **Durability belongs to the runtime.** Recovery, exactly-once admission of input, queued input and checkpoints come
  from pi-durable. The daemon adds no retry loops, intake tables or recovery code of its own. Each daemon-owned fact
  is committed in the same atomic commit as the change it describes.
- **The service layer is free of transport.** Every service operation can be called in-process with no request,
  connection or listener in scope. Neither authorization nor the choice of which operations a listener exposes lives
  in the service layer. Adding a listener never changes a service operation.
- **Clients are viewers.** No client connection or subscription owns work. Closing a client, or a client falling
  behind, never stops, slows or changes an agent run.
- **Fail closed at startup, exit on a storage failure.** Invalid configuration, unsafe permissions or a second owner
  stop the daemon before it opens the database. A storage error while running ends the process with an error, and
  the supervisor's restart resumes the work.
- **Filesystem permissions are the security boundary.** Every directory and file the daemon creates is owner-only.
  The daemon stores no credentials. It uses the pi agent login in place.
- **Bounded capacity.** The number of active agent runs never exceeds the worker-thread count, including during
  recovery after a restart.
- **pi-durable sits behind a narrow host.** Only the host module and the-intern's own extensions use pi-durable. The
  service layer and every other component depend on the host's interface, so an upgrade of the pi packages touches a
  few files (coding guidelines).
- **Testable without a network.** The whole daemon, including kills and restarts, runs on the fake model with an
  isolated state directory and an isolated pi agent folder.

### System Diagram

```
 clients (S-003 listeners)        entry points               agents (tools)
 bob chat · bob CLI · TUI ·       scheduler (S-006)           coordination tools (S-001)
 desktop GUI · [LAN, later]             │                           │
        │ read / control ops            │ control ops               │ control ops
        ▼                               ▼                           ▼
 ┌──────────────────────────────────────────────────────────────────────────────┐
 │ daemon process                                                               │
 │  ┌────────────────────────────────────────────────────┐   ┌───────────────┐ │
 │  │ service layer (operations, read | control, caller)  │──►│ observation   │─┼──► subscribers
 │  └──────────────┬─────────────────────────────────────┘   │ feed          │ │    (snapshot,
 │                 │                                          └───────▲───────┘ │     then deltas)
 │  ┌──────────────▼─────────┐  ┌──────────────────┐                  │         │
 │  │ admission              │─►│ harness host     │──────────────────┘         │
 │  │ (worker threads, FIFO) │  │ (pi-durable,     │──► model runtime ──► pi agent login,
 │  └────────────────────────┘  │  extensions,     │    (fake model in tests)   settings, models
 │                              │  execution env)  │                            │
 │  lifecycle · configuration · └────────┬─────────┘                            │
 │  state layout                         ▼                                      │
 └───────────────────────────────── database (one SQLite file, state dir) ──────┘
                 ▲ start, restart on error exit
            supervisor (systemd / launchd)
```

### Responsibility Separation

| Component | Responsibility | Notes |
|---|---|---|
| Lifecycle | Startup sequence, single-owner lock, readiness, signals, shutdown, exit on a storage failure | Runs in the foreground. The supervisor handles daemonizing and restarts |
| Configuration | Loads, layers and validates configuration; refuses to start when it is invalid; persists settings changed through service operations | The file is read at startup and written only by settings operations |
| State layout | Creates and checks the config, state, data and runtime directories and their permissions | Owner-only |
| Model runtime | Resolves models and thinking levels through the pi agent login and model registry; maps pi agent settings into the harness explicitly; closes model connections on shutdown | The fake model replaces it in tests |
| Harness host | Opens the database, installs the-intern's extensions, builds the execution environment per seat workspace, ensures the root conversation, then resumes | The only user of pi-durable outside the-intern's extensions |
| Admission | Grants worker threads to agent runs, keeps waiting work in arrival order, durably | Implements S-001 R-10 |
| Service layer | The catalogue of read and control operations, their validation and their error outcomes | Called by listeners, entry points and agent tools alike |
| Observation feed | Publishes snapshots and deltas for the instance and for each conversation | The source for chat, monitoring, audit and later summary views |
| Status | Reports health, readiness, versions and capacity in use | A read operation |

## Components

### Component 1: Lifecycle

**Purpose:** Start the daemon in a fixed order, enforce one owner per instance, report readiness, and stop cleanly or
exit with an error that the supervisor acts on.
**Estimated size:** Small.
**Interfaces:** Exposes start and stop hooks so other components (listeners, scheduler) start after readiness and stop
before the harness closes. Consumes every other component.

### Component 2: Configuration

**Purpose:** Produce one validated configuration from built-in defaults, the user's configuration file, command-line
flags and the environment, and persist the settings that service operations change.
**Estimated size:** Small to medium.
**Interfaces:** Exposes the current configuration and a validated change-and-persist path to the service layer.
Consumes the configuration file, the command line and the environment.

### Component 3: State layout

**Purpose:** Resolve the instance's directories, create them owner-only when they are missing, and refuse unsafe
existing ones.
**Estimated size:** Small.
**Interfaces:** Exposes the paths of the database, the runtime directory (for S-003's socket), the data directory (for
S-001's per-role default workspaces) and the configuration file. Consumes configuration.

### Component 4: Model runtime

**Purpose:** Give the harness models, credentials and settings from the pi agent login and pi agent settings, and
validate model and thinking-level choices for the seat operations.
**Estimated size:** Medium.
**Interfaces:** Exposes model lookup, model validation, the default model and thinking level, and the explicit settings
mapping. Consumes pi agent's login, settings and model registry, read-only apart from the login's own token
refresh.

### Component 5: Harness host

**Purpose:** Own the open pi-durable harness: open storage, install extensions, apply settings, create the execution
environment for each tool call from the seat's workspace, ensure the root conversation, then resume unfinished work.
**Estimated size:** Medium.
**Interfaces:** Exposes the narrow host interface the service layer, admission and observation feed use. Consumes
state layout, model runtime and the-intern's extensions (S-001, S-004, S-005).

### Component 6: Admission

**Purpose:** Count worker threads, grant one to each agent run that is ready, hold the rest in arrival order, and keep
that order across restarts.
**Estimated size:** Medium to large: pi-durable has no concurrency cap of its own, so admission has to gate when runs
start, including the runs that resume after a restart.
**Interfaces:** Exposes the admission state (active, waiting with position) to the service layer and the observation
feed. Consumes the harness host and the daemon's admission document.

### Component 7: Service layer

**Purpose:** Offer every daemon capability as a named read or control operation with validated input, a stated
caller, and a defined error outcome.
**Estimated size:** Medium.
**Interfaces:** Exposes the operation catalogue (R-12) to listeners, entry points and agent tools. Consumes the harness
host, admission, model runtime and S-001's seating and coordination components.

### Component 8: Observation feed

**Purpose:** Turn committed changes into subscriptions per scope: a snapshot, then deltas, never a replay. Drop a
subscriber that falls too far behind, and never let a subscriber affect work.
**Estimated size:** Medium.
**Interfaces:** Exposes subscribe and unsubscribe per scope. Consumes the harness host's commit and event streams and
the admission state.

### Component 9: Status

**Purpose:** Report whether the daemon is starting, ready or stopping, its versions, start time, instance paths, and
worker threads in use and waiting.
**Estimated size:** Small.
**Interfaces:** Exposes a read operation and an instance-scope feed entry. Consumes lifecycle, admission and harness
host.

## Behavioural Requirements

### Process and lifecycle

- **R-1 Single owner.** Starting a daemon for an instance whose database another live daemon owns is refused before
  the database is opened. The refusal names the instance's state directory and the owning process id, and exits with
  an error. If the recorded owner is no longer alive, the new daemon takes ownership and starts normally.
- **R-2 Startup order.** The daemon starts in this order and stops at the first failure with an error that names the
  failing step and its cause:
  1. load and validate configuration (R-21)
  2. resolve the instance directories and check or create them (R-6)
  3. take single ownership (R-1)
  4. open the database and install the-intern's extensions, before anything resumes
  5. check that every configured model and thinking level resolves (S-001 Configuration Requirements)
  6. ensure the root conversation and the per-role default workspaces (S-001 R-12, R-3)
  7. restore admission (R-10), then resume unfinished work
  8. start the components that registered a start hook (listeners, scheduler), then report ready
- **R-3 Readiness.** Until step 8 has finished, the status operation reports "starting". Afterwards it reports
  "ready", and the daemon writes one log line naming the instance, the versions in use and the worker-thread count.
  No listener accepts calls before the daemon is ready.
- **R-4 Supervision contract.** The daemon runs in the foreground and never forks itself into the background. It
  writes diagnostics to standard error. It exits with status 0 only after a requested shutdown. Every other exit
  (startup failure, storage failure, unexpected error) has a non-zero status. The supervisor restarts the daemon on
  a non-zero exit. Packaging provides the systemd and launchd unit files.
- **R-5 Shutdown.** On SIGTERM or SIGINT the daemon:
  1. reports "stopping" and stops accepting new calls
  2. stops the components with a stop hook, in reverse start order
  3. closes the harness and every model connection
  4. exits with status 0
  
  Work running at that moment is not recorded as a user abort. It resumes on the next start, where calls that aren't
  replay-safe come back as interrupted results (pi-durable). The stop bound is 10 seconds: if shutdown hasn't finished
  by then, because some code doesn't honour its abort signal, the daemon exits with a non-zero status. No queued
  input, waiting work or parked conversation is lost either way.
- **R-6 Instance directories.** The daemon uses four directories, resolved from the XDG base directories, each in a
  folder named `the-intern`:
  - config (configuration file)
  - state (database)
  - data (per-role default workspaces, S-001 R-3)
  - runtime (the socket's directory, S-003)

  Each can be overridden by configuration (R-21). A missing directory is created owner-only (mode 0700). An existing
  one that isn't a directory, isn't owned by the user, or is accessible to the group or others stops startup with an
  error naming the path and the reason. The database file is owner-only.
- **R-7 Storage failure.** When the harness closes because of a storage error, the daemon logs the error, stops
  accepting calls and exits with a non-zero status within the stop bound (R-5). It doesn't try to reopen the database itself.
  After the supervisor restarts it, unfinished work resumes from its last checkpoint.
- **R-8 Crash recovery.** After a kill at any point, including `kill -9` during a model request, a tool call, an
  admission decision or a service operation, the next start:
  - resumes every unfinished agent run
  - keeps every queued input, parked conversation and waiting run
  - leaves every service operation that changes state either completed or not applied, never half-applied (S-001
    R-17)

### Worker threads and admission

- **R-9 Process model.** The daemon is one operating-system process with one event loop. A worker thread is a slot in
  that process, not an operating-system thread. CPU-heavy work runs outside the daemon process: tools run commands as
  child processes.
  - The number of worker threads is a built-in constant: **32**, the most concurrent agent runs the daemon is
    tested with. It changes only with a release, after load tests, and the user can't configure it.
  - The invocation depth cap (S-001 R-9) is a built-in constant: **10**. The user can't configure it.
- **R-10 Admission.** S-001 R-10 holds, with these additions:
  - An agent run takes a worker thread before its first model request, and gives it back when the conversation
    becomes idle, parked or aborted.
  - The waiting order is stored in the database. After a restart, runs that held a worker thread at the kill resume
    first, up to the worker-thread count. Waiting runs then start in their stored order.
  - If more runs held a worker thread than the running release allows (a release lowered the count), the extra runs
    wait at the head of the queue in their original order.
  - Admission never starves a waiting run: a run waits only for runs ahead of it in the queue or already active.
- **R-11 Visible capacity.** The status operation and the instance feed report how many worker threads exist, how
  many are in use and which conversations wait, with their queue positions. A conversation's status shows "waiting
  for a worker thread" while it waits (S-001 R-16).

### Service layer

- **R-12 Operation catalogue.** The service layer offers at least these operations. Each is marked **read** or
  **control**.
  - Read: daemon status; list conversations; get one conversation (seat, origin, status, depth, invocation links);
    read a conversation's stored entries, paged, including entries from before resets and compactions; read its
    current context; read a submission's state; wait for a submission to settle, for a time the caller chooses, at
    most 5 minutes; list roles with their defaults; list registered workspaces; list available models and thinking
    levels; read usage per conversation and in total; inspect live pi-durable tasks per conversation; subscribe to
    the observation feed (R-14).
  - Control: create a conversation (S-001 R-11); submit input with a request id and a busy mode (follow-up, steer or
    reject); withdraw a queued input; abort a conversation (with S-001's cascade); reset a conversation; compact a
    conversation; change a conversation's seat (S-001 R-4); set a role's default model, thinking level or workspace
    (S-001 R-3); register a workspace and unregister one (S-001 R-3a). The settings operations follow R-22.

  S-001's agent coordination capabilities (handoff, invoke, steer) are control operations of the same service layer.
  Later specs add theirs the same way (for example approvals in S-004 and firing a schedule now in S-006).
- **R-13 Operation contract.** Every operation:
  - validates its input and refuses an invalid call without changing state
  - names its caller's actor, which S-001 records where it requires attribution
  - ends with a result or one of a fixed set of error outcomes: not found, invalid input, busy (a reject-if-busy
    submit), conflict, unavailable (the daemon isn't ready or is stopping), internal. Each outcome carries a message
    that names what failed.

  A control operation that creates something (a conversation, a workspace registration) accepts an idempotency key.
  A repeated call with the same key returns the original result and creates nothing. Submits are idempotent through
  their request id (pi-durable). Read operations never change state.

### Observation feed

- **R-14 Snapshot, then deltas.** A subscription names a scope: the instance (conversations with seat, status and
  admission state, plus started and finished events), or one conversation (its live view, events and queued input).
  It first gets a snapshot, then deltas in commit order. A new subscription never replays earlier deltas. A
  subscriber that reconnects starts from a fresh snapshot.
- **R-15 Viewers don't affect work.** A subscriber that falls more than a bounded amount behind is disconnected and
  has to subscribe again. Neither a slow, disconnected or crashed subscriber nor any number of subscribers delays an
  agent run, holds a worker thread or loses a committed change.

### Ready for later listeners

- **R-16 Transport-free and complete.** Everything a client can do, it does through a service operation (R-12), and
  every operation can be called in-process with no listener. No operation reads transport details, a connection or
  the caller's machine to decide its outcome. Which operations a listener exposes, and how it authenticates callers,
  is the listener's choice (S-003 and the later LAN spec).
- **R-17 Classified operations and one feed.** The read or control mark of each operation is part of the catalogue,
  so a listener can expose read operations only, and add control operations later without changing the service
  layer. The observation feed is the only source of live data for clients, so a summarised feed (defined later) can
  be derived from it without a second path into the harness.

### Models, settings and credentials

- **R-18 pi agent login and models.** Models and credentials come from the user's pi agent login and model registry,
  used in place. The daemon writes nothing into pi agent's agent folder except token refreshes made by the login
  itself, under pi agent's own lock, so the user's pi and the daemon never log each other out. No credential is
  copied into the instance's directories or the database.
- **R-19 Explicit settings mapping.** pi agent settings reach the harness only through an explicit mapping. At least
  these are mapped: transport, retry, steering and follow-up modes, compaction thresholds and stream timeouts. Every
  mapped setting has a test. Unmapped settings have no effect, and the user documentation lists the mapped ones.
- **R-20 Versions.** The status operation reports the-intern's version and the pi package versions in use. The
  database records which versions last opened it. When they differ from the running versions, the daemon logs the
  change at startup and continues.

### Configuration

- **R-21 Configuration loading.** Each setting has one source:
  - the configuration file in the config directory holds the user settings of S-001: each role's default model,
    thinking level and workspace, and the registered workspaces
  - command-line flags set the instance directories (R-6)
  - the environment sets the pi agent folder, as for pi agent itself

  Built-in defaults apply where a source gives nothing. The file is optional, and a missing one means built-in
  defaults. A file that exists but can't be parsed, contains unknown keys or holds invalid values stops startup with
  an error naming the file, the key and the reason. The daemon reads the file at startup only; hand edits take effect
  at the next restart.
- **R-22 Settings changed at runtime.** The settings in the configuration file can also be changed through control
  operations (R-12), from any client.
  - The daemon validates the change as at startup (S-001 R-3a, Configuration Requirements). An invalid change is
    refused with a message naming the setting and the reason, and nothing changes.
  - A valid change is written to the configuration file first, atomically and owner-only, and applies at once. The
    file stays the single source of truth, so the change survives a restart.
  - A change applies as S-001 states: a role's new defaults affect only agents seated after it, and a newly
    registered workspace can be used at once.
  - If the file was changed on disk since the daemon last read it, the change is refused as a conflict naming the
    file, so a hand edit is never overwritten. A restart picks up the hand edit.
  - If the file can't be written, the change is refused and nothing applies.
  - Each change appears in the instance feed.

## Workflow

Daemon start, from supervisor to ready:

```
Supervisor starts bob serve
  ↓
Load configuration → invalid? exit non-zero, naming file, key, reason
  ↓
Resolve directories, check permissions → unsafe? exit non-zero, naming path, reason
  ↓
Take single ownership → another live owner? exit non-zero, naming state dir and pid
  ↓
Open database, install extensions → check configured models and thinking levels
  ↓
Ensure root conversation and default workspaces
  ↓
Restore admission order, resume unfinished work (held worker threads first, then the queue)
  ↓
Start listeners and scheduler → status "ready"
```

Input from any caller, through to the observation feed:

```
Caller (client via listener, schedule fire, agent tool) calls a control operation
  ↓
Service layer validates input, records the caller's actor
  ↓
Submission committed (idempotent by request id); conversation becomes ready
  ↓
Admission: free worker thread? → run starts; else waits in arrival order ("waiting for a worker thread")
  ↓
Agent run: model turns and tool calls, each committed before it is shown
  ↓
Observation feed publishes deltas to every subscriber of the instance and the conversation
  ↓
Conversation idle or parked → worker thread returns to admission → next waiting run starts
```

Failure while running:

```
Storage error closes the harness → daemon exits non-zero
  ↓
Supervisor restarts it → normal start → unfinished runs resume from their checkpoints
```

## Configuration Requirements

- **Configuration file.**
  - **What:** the S-001 user settings: each role's default model, thinking level and workspace, and the registered
    workspaces. Later specs add their sections and say which of their settings change at runtime.
  - **Where:** a TOML file in the config directory (R-6). Written by hand, or by the settings operations (R-22).
  - **Constraints:** a trusted, owner-only input. Unknown keys are refused.
  - **Missing:** built-in defaults for every setting. An invalid file stops startup (R-21).
- **Instance directories.**
  - **What:** the config, state, data and runtime directories (R-6), so several instances or tests can run side by
    side.
  - **Where:** the XDG base directories by default, overridable by command-line flags only.
  - **Constraints:** absolute paths. Owner-only directories owned by the user.
  - **Missing:** the XDG defaults, created owner-only. An unsafe existing directory stops startup.
- **pi agent folder.**
  - **What:** where the pi agent login, settings and models are read.
  - **Where:** pi agent's own default, including its `PI_CODING_AGENT_DIR` override (**Contract**: pi agent's
    variable name).
  - **Constraints:** read-only for the daemon, apart from the login's token refresh (R-18). Tests always point it at
    an isolated folder.
  - **Missing:** a missing login doesn't stop the daemon unless a configured model needs it (S-001). Model requests
    fail with an error the agent run shows.
- **Fake model (test only).**
  - **What:** runs the daemon on the fake model with no network, for deterministic tests. A second test-only switch
    sets a smaller worker-thread count, so tests can fill every worker thread.
  - **Where:** test-only switches. They are not in the user documentation and not in the configuration file.
  - **Constraints:** never enabled by default.
  - **Missing:** the real model runtime.

Built-in constants, not configurable: 32 worker threads and an invocation depth cap of 10 (R-9), the 10-second stop
bound for shutdown and storage failures (R-5, R-7), and a submission wait of at most 5 minutes (R-12). S-001 records
the two capacity constants by amendment.

## Verification

- **Deterministic tests** run on the fake model, with an isolated instance and an isolated pi agent folder, and no
  network. They cover:
  - R-1: a second daemon on the same instance is refused with the owner's pid. A stale owner is taken over.
    Two instances with different state directories run side by side.
  - R-2, R-21: each startup step fails on purpose (an invalid configuration file, an unknown key, an unsafe
    directory, an unresolvable configured model) and the daemon exits non-zero with the named cause and without
    opening the database where the step precedes it.
  - R-3: status reports "starting" until ready, and no listener call succeeds before ready.
  - R-5: SIGTERM during a tool call exits 0 within 10 seconds. The next start resumes the run and shows the
    interrupted result.
  - R-6: created directories are 0700 and the database file is owner-only. A group-readable existing directory stops
    startup.
  - R-7: a simulated storage failure exits non-zero within 10 seconds, and a restart resumes the run.
  - R-8: `kill -9` during a model request, a tool call, an admission change and a create operation, then a restart;
    the invariants hold (resumed runs, no lost input, no half-applied operation).
  - R-10, R-11 (with the test-only count of one): three submissions run one after another in arrival order; a kill
    while two wait restores the same order; restarting with a lower count makes the extra runs wait; status and the
    feed report active and waiting work. Without the test switch, status reports 32 worker threads.
  - R-12, R-13: every operation in the catalogue is called in-process with no listener; invalid input changes
    nothing; each error outcome is produced; a repeated create with the same idempotency key creates one
    conversation; read operations leave the database unchanged.
  - R-14, R-15: a subscription gets a snapshot, then deltas in commit order; a reconnect gets a fresh snapshot; a
    subscriber that stops reading is disconnected without delaying a running agent run.
  - R-17: a test enumerates the catalogue and fails if any operation lacks a read or control mark.
  - R-18: after a full test run, the isolated pi agent folder is byte-identical apart from the login's own token
    file, and no credential appears in the instance directories or the database.
  - R-19: one test per mapped setting.
  - R-20: status reports the versions, and a changed version is logged at startup.
  - R-21, R-22: a role default changed through the service is in the file and survives a restart; an invalid change
    and a change after a hand edit are refused and leave the file as it was; an unwritable file refuses the change;
    agents seated before a change keep their seat.
- **Live acceptance tests** use the user's pi agent login with the low-cost model from S-001:
  1. The daemon starts under the user's login, answers a prompt in the root conversation, and leaves `~/.pi`
     unchanged apart from a token refresh.
  2. A `kill -9` during a long `bash` call, then a restart by hand: the run continues with an interrupted result and
     its submission settles once.
  3. Under the systemd user service, killing the daemon with a non-zero exit gets it restarted, and the run resumes.

## Implementation Order

| Phase | What | Depends On |
|---|---|---|
| 1 | Lifecycle, configuration, state layout and single ownership; harness host on the fake model with the root conversation; status; kill and restart tests | Nothing |
| 2 | Model runtime: pi agent login, model validation, settings mapping, closing connections on shutdown; live test 1 | Phase 1 |
| 3 | Service layer with the read and control catalogue, and the observation feed | Phase 1 |
| 4 | Admission and worker threads, durable across restarts | Phase 3 |
| 5 | Supervision: storage-failure exit, shutdown bound, live tests 2 and 3 with the packaged unit files | Phases 1–4, packaging spec for the unit files |

S-001 phase 1 needs phases 1 to 3 of this spec. S-001 phase 4 needs phase 4.

## Amendment Log
