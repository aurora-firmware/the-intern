---
title: Daemon and host runtime
version: '0.14'
status: approved  # draft | review | approved | superseded
created: '2026-10-16'
author: planner
id: S-002
---

# Daemon and host runtime

## Purpose

This spec covers the **Intern service** component of S-000. S-001 defines conversations, roles and agents, but leaves
out the process that runs them: who owns the database, how it starts, stops and recovers, where its files live, how it
reaches models, and what a worker thread is. Every later spec (control endpoint, jobs, schedules and triggers, email,
web interface) plugs into that process, so its shape has to be fixed first, and it has to serve the command line on
the machine and the web interface over the team's network alike. This spec fixes one durable daemon that owns the
database, a transport-free service layer every caller uses, bounded capacity, and an observation feed for clients.
Success Criteria lists the observable outcomes.

## Definitions

This spec uses S-001's Definitions. It adds these terms:

| Term | Meaning in this spec |
|---|---|
| Daemon | The single long-running process of the-intern (`bob serve`). It owns the database and runs every agent run. |
| Database | The one durable store of an instance (S-001), holding every conversation, entry, pi-durable task, submission and document, plus the daemon's own documents and the job store's tables (S-004 REQ-001). |
| Instance | One daemon together with its state directory. Two instances share nothing. A second instance with its own state directory is the only hard wall between sets of conversations. |
| Service layer | The set of service operations. It is the only way for clients and job sources to read or change the daemon's state. |
| Service operation | One named capability of the daemon, such as "submit input" or "reset a conversation". It is either a **read** operation (it observes) or a **control** operation (it changes state or starts work). |
| Caller | Whatever invokes a service operation: a client through a listener, a job source (a schedule fire, a trigger, email) or an agent tool. The caller states the actor that S-001 attribution records. |
| Listener | A transport that exposes service operations to clients. Listeners belong to S-000's Intern service and are defined in the control-endpoint spec (S-003), not here. |
| Client | A separate program that uses the daemon through a listener: the `bob` commands and the web interface in a team member's browser. A client holds no work. |
| Observation feed | The stream of changes the daemon publishes for a scope (the whole instance or one conversation). A subscription gets a snapshot, then deltas. |
| Admission | The daemon's decision on when an agent run may take a worker thread (S-001 REQ-010). |
| Supervisor | The operating system's startup manager (systemd on Linux, launchd on macOS). It starts the daemon when the machine starts, without anyone logging in, and restarts it when it exits with an error. |
| Service account | The operating-system account the daemon runs as. In v1 it is the account of the person who installed the-intern. Its pi agent login, keys and account credentials are the-intern's. |
| Fake model | A deterministic model whose replies are a pure function of the transcript. Used only by tests. |

pi-durable terms (Harness, task, submission, document, extension, registry) keep the meanings given in S-001 and in
`docs/research/pi-durable-knowledge.md`. "pi agent login" and "pi agent settings" are the service account's
credentials and `settings.json` in pi agent's agent folder.

## Users and Journeys

| Actor | Goal |
|---|---|
| Team member | Uses the-intern through clients (the `bob` command line on the machine, the web interface over the network), and relies on work surviving restarts. |
| Supervisor (systemd, launchd) | Starts the daemon at machine startup without a login and restarts it after an error exit. |
| Callers (downstream systems) | Clients through listeners, job sources and agent tools call service operations and subscribe to the observation feed. |
| Later specs (downstream systems) | The control endpoint, Jobs, schedules and triggers, email and the web interface plug into the daemon's startup, service layer and feed. |
| Developer | Runs the whole daemon, including kills and restarts, on the fake model without a network. |

Journeys, in priority order:

1. **The daemon starts and becomes ready.** The supervisor starts `bob serve`; it validates its configuration and
   directories, takes single ownership, opens the database, resumes work and reports ready, or exits non-zero naming the
   failing step. Delivered by REQ-002, REQ-003, REQ-004, REQ-006, REQ-021, REQ-001.
2. **Work survives every stop.** A shutdown, a storage failure or a kill at any point loses no committed work, and the
   next start resumes it. Delivered by REQ-005, REQ-007, REQ-008.
3. **A caller drives work through the service layer.** Every capability is a named read or control operation with
   validated input, a stated actor and fixed error outcomes, callable in-process. Delivered by REQ-012, REQ-013, REQ-016,
   REQ-017.
4. **Capacity is bounded and visible.** At most the worker-thread count of runs are active; the rest wait in a durable
   order that status and the feed show. Delivered by REQ-009, REQ-010, REQ-011.
5. **Clients watch live without affecting work.** Subscribers get a snapshot then deltas, and a slow one is dropped.
   Delivered by REQ-014, REQ-015.
6. **The team changes settings while it runs.** Role and workspace settings change through operations, are written to
   the file and apply at once. Delivered by REQ-022.
7. **The service account's credentials are used in place.** Delivered by REQ-018, REQ-019, REQ-020.

## Exclusions

What this specification explicitly does NOT cover:

- **Listeners.** The local socket for the command line and the network listener for the web interface, the control
  protocol, routes and the client library belong to S-003. This spec defines the operations those surfaces expose,
  not how they are carried. No listener authenticates callers (S-000; REQ-016).
- **Several devices, a hub, a device registry, tokens and provisioning.** The-intern runs on one machine, serving the
  team that can reach it.
- **Discovering and loading extensions at runtime.** Only the-intern's own pi-durable extensions, shipped in the
  package, are installed. pi agent extensions, the service account's extensions and workspace extensions are never
  loaded (S-001; knowledge base §4.3).
- **Picking up hand edits of the configuration file while running.** The daemon reads the file at startup. A hand
  edit takes effect at the next restart, which is cheap because every run resumes. Settings changed through service
  operations apply at once (REQ-022).
- **Configurable capacity limits.** The worker-thread count and the invocation depth cap are built-in constants
  (REQ-009), not settings.
- **Jobs, skills and instructions, schedules and triggers, email, the web interface and team knowledge.** Each has
  its own spec. This spec gives them the daemon, the service layer and the observation feed they build on.
- **Installation.** Release form and the supervisor registration that REQ-004 requires belong to S-000's Installation
  and service setup, decided in the bootstrap plan.
- **Approval rules for actions.** S-000 excludes them; no policy component exists.
- **Retention and archiving of old conversations.** Storage only grows. A retention policy is a later decision.
- **Compatibility across pi-durable versions.** The pi packages are pinned, and no backwards compatibility of the
  database is promised (AGENTS.md). The daemon records the versions that opened the database (REQ-020) and migrates
  only the job store's own tables (S-004 REQ-001), never pi-durable's; export and import copy the whole database and
  don't convert it (S-004).
- **Windows, Linux arm64 and Intel macOS.** These remain unsupported.

## Alternatives Considered

- **durable-pi's device model: several devices, a hub, a device registry, tokens and provisioning.** Rejected: these
  make up most of durable-pi's weight, and the-intern runs on one machine.

## Interfaces

### Exposed: the `bob serve` command

**Contract:** `bob serve [--config-dir <dir>] [--state-dir <dir>] [--data-dir <dir>] [--runtime-dir <dir>]
[--verbose]`. The directory flags take absolute paths (REQ-006, REQ-021). The daemon runs in the foreground, writes its
log to standard error and nothing to standard output, and `--verbose` adds debug lines. Exit status: 0 after a
requested shutdown, 1 for any failure, 2 for a usage error (REQ-004, REQ-005).

### Exposed: the service operation catalogue

Every operation is called with an input and a caller that names its actor, and ends with a result or one of the error
outcomes `not_found`, `invalid_input`, `busy`, `conflict`, `unavailable` or `internal`, each with a message naming what
failed (REQ-013). **Contract** (operation names and kinds):

| Operation | Kind | Purpose |
|---|---|---|
| `daemon.status` | read | Phase, versions, start time, instance directories, worker threads in use and waiting (REQ-003, REQ-011, REQ-020) |
| `conversations.list`, `conversations.get` | read | Conversations with seat, origin, status, depth and invocation links; the list marks the front desk (REQ-012; S-001 REQ-016, REQ-021) |
| `desk.get` | read | The front desk's conversation id and seat (REQ-012; S-001 REQ-021) |
| `conversations.invocations` | read | The conversations a conversation invoked, recursively (S-001 REQ-016) |
| `conversations.entries` | read | Stored entries, paged, including entries from before resets and compactions |
| `conversations.context` | read | The current context |
| `submissions.get`, `submissions.wait` | read | A submission's state; wait up to 5 minutes for it to settle |
| `roles.list` | read | Roles with their instructions, tools, skills and defaults |
| `workspaces.list` | read | Registered workspaces |
| `models.list` | read | Available models and thinking levels |
| `usage.get` | read | Usage per conversation and in total |
| `tasks.live` | read | Live pi-durable tasks per conversation |
| `feed.subscribe` | read | Subscribe to the instance or a conversation (REQ-014) |
| `jobs.get`, `jobs.list`, `jobs.worklog.list`, `jobs.history.list` | read | Jobs, their worklogs and their histories (S-004 REQ-010, REQ-011, REQ-014) |
| `jobs.create` | control | Create a job and start its lead conversation (S-004 REQ-007; S-001 REQ-012) |
| `jobs.update`, `jobs.worklog.add`, `jobs.relate`, `jobs.unrelate` | control | Edit a job, add to its worklog, relate or unrelate two jobs (S-004 REQ-004, REQ-009, REQ-010) |
| `jobs.resume`, `jobs.complete`, `jobs.cancel` | control | A job's actions open to team members (S-004 REQ-005) |
| `jobs.export` | control | Export the whole database to a new file (S-004 REQ-016) |
| `conversations.submit` | control | Submit input with a request id and a busy mode (`followUp`, `steer`, `reject`) |
| `submissions.withdraw` | control | Withdraw a queued input |
| `conversations.abort`, `conversations.reset`, `conversations.compact` | control | Abort (with S-001's cascade), reset or compact a conversation |
| `conversations.seat` | control | Change a conversation's seat (S-001 REQ-004) |
| `roles.create`, `roles.change`, `roles.restore`, `roles.remove` | control | Role settings (S-001 REQ-003; REQ-022) |
| `workspaces.register`, `workspaces.unregister` | control | Workspace registration (S-001 REQ-018; REQ-022) |

The tests register `test.createConversation` and `test.failStorage` (`test/support/test_operations.ts`); they are not part of the product's catalogue.

### Exposed: the observation feed

A subscription names the scope `instance` or one conversation. Each delivers a snapshot, then deltas with increasing
sequence numbers in commit order, and ends with a reason (`lagging`, `unsubscribed`, `stopped`) (REQ-014, REQ-015). The
instance scope carries every conversation with its job, lead flag, seat, status and the worker threads, and the
deltas `conversation_created`, `run_started`, `run_finished`, `seat_changed`, `status_changed`, `admission_changed` and
`settings_changed`. It also carries the jobs that aren't Done and S-004's job deltas, each published after its job
store commit and numbered in the same sequence (S-004 REQ-015). The conversation scope carries its live view and
entries.

### Consumed

- The pi agent folder: login, `settings.json` and model registry, at pi agent's default location or
  `PI_CODING_AGENT_DIR` (**Contract**: pi agent's variable name) (REQ-018, REQ-019).
- The XDG base directories `XDG_CONFIG_HOME`, `XDG_STATE_HOME`, `XDG_DATA_HOME` and `XDG_RUNTIME_DIR` (REQ-006).
- The configuration file `config.toml` in the config directory. Its keys are documented in the user manual
  (`docs/manual/running_the_intern.md`, `docs/manual/roles_and_agents.md`) (REQ-021).
- SIGTERM and SIGINT (REQ-005).

## Workflow

Daemon start, from supervisor to ready:

```
Supervisor starts bob serve at machine startup                                  REQ-004
  ↓
Load configuration → invalid? exit non-zero, naming file, key, reason           REQ-021, REQ-002
  ↓
Resolve directories, check permissions → unsafe? exit non-zero, naming path,    REQ-006
  reason
  ↓
Take single ownership → another live owner? exit non-zero, naming state dir     REQ-001
  and pid; a stale owner is taken over
  ↓
Read job schema version → newer? exit non-zero, naming both versions            REQ-002
  ↓
Open database, create or migrate job store, ready the tools → check             REQ-002
  configured models and thinking levels → unresolvable? exit non-zero, naming
  the role and value
  ↓
Ensure per-role default workspaces
  ↓
Restore admission order, apply the job repair rules (S-004 REQ-018), resume     REQ-010
  unfinished work (held worker threads first, then the queue), then submit the
  input those rules owe (S-004 REQ-018)
  ↓
Start listeners and scheduler → status "ready"                                  REQ-003
```

Input from any caller, through to the observation feed:

```
Caller (client via listener, job source, agent tool) calls a control operation  REQ-012
  ↓
Service layer validates input, records the caller's actor                       REQ-013
  → invalid? error outcome, nothing changes; not ready? unavailable
  ↓
Submission committed (idempotent by request id); conversation becomes ready
  (parked for reports? the message is held, { held: true })                     REQ-012
  ↓
Admission: free worker thread? → run starts; else waits in arrival order        REQ-010, REQ-011
  ("waiting for a worker thread")
  ↓
Agent run: model turns and tool calls, each committed before it is shown
  ↓
Observation feed publishes deltas to every subscriber of the instance and the   REQ-014, REQ-015
  conversation; a lagging subscriber is dropped
  ↓
Conversation idle or parked → worker thread returns to admission → next
waiting run starts
```

Failure and stop while running:

```
Storage error closes the database → daemon exits non-zero within 10 s           REQ-007
  ↓
Supervisor restarts it → normal start → unfinished runs resume from their       REQ-008
checkpoints

SIGTERM / SIGINT → stopping → stop components in reverse order → close database → REQ-005
exit 0 (non-zero past the 10 s bound)
```

## Behavioral Requirements

Requirement identifiers before v0.6 were `R-n`. The number is kept: `R-n` is now `REQ-00n` (`REQ-0nn` from 10), so
`R-12` is `REQ-012`. REQ-001, REQ-007, REQ-008, REQ-015 and REQ-018 are under Quality Requirements. The deterministic
tests run on the fake model, with an isolated instance and an isolated pi agent folder, and no network.

### REQ-002 — Startup order

The daemon SHALL start in this order and stop at the first failure with an error that names the failing step and its
cause:

1. load and validate configuration (REQ-021)
2. resolve the instance directories and check or create them (REQ-006)
3. take single ownership (REQ-001)
4. read the job schema version, open the database, create or migrate the job store's tables, and make the-intern's
   tools ready, before anything resumes
5. check that every configured model and thinking level resolves (S-001 Configuration Requirements)
6. ensure the per-role default workspaces (S-001 REQ-003) and the front desk (S-001 REQ-021)
7. restore admission (REQ-010), apply the job repair rules (S-004 REQ-018), resume unfinished work, then submit the
   input those rules owe (S-004 REQ-018)
8. start the components that start after work resumes (listeners, scheduler), then report ready

#### AC-002.1 — The steps run in order

- **Given:** a valid instance
- **When:** the daemon starts
- **Then:** the eight steps run in order, and status reports "starting" until step 8 has finished

**Verification:** test — `test/service/daemon_startup.test.ts`.

#### AC-002.2 — Each step fails with its name

- **Given:** an invalid configuration file, an unknown key, an unsafe directory, a relative directory flag, a live
  owner, an unopenable database, a newer job schema, an unresolvable configured model, a failing workspace or a
  component that fails to start in step 8
- **When:** the daemon starts
- **Then:** it exits non-zero naming the failing step and its cause, creates no database file where the step precedes
  step 4, releases ownership it took, and stops the components already started

**Verification:** test — `test/service/daemon_startup.test.ts` ("runDaemon startup failures"),
`test/service/daemon_lifecycle.test.ts` ("startup failures"), `test/service/agents_startup.test.ts`.

### REQ-003 — Readiness

Until step 8 has finished, the status operation SHALL report "starting". Afterwards it reports "ready", and the daemon
writes one log line naming the instance, the versions in use and the worker-thread count. Listeners open in step 8,
so they can receive calls before the daemon is ready; until then every call but the status operation is refused as
`unavailable`, as for any other caller (S-003).

#### AC-003.1 — Starting until ready

- **Given:** a daemon held in step 8
- **When:** callers call `daemon.status` and other operations
- **Then:** status answers "starting", every other operation is refused as `unavailable`, and after release status
  answers "ready"

**Verification:** test — `test/service/daemon_lifecycle.test.ts` ("readiness"), `test/service/daemon_startup.test.ts`,
`test/service/daemon_process.test.ts`.

#### AC-003.2 — The ready line

- **Given:** a daemon reaching ready
- **When:** its log is read
- **Then:** it holds one ready line naming the state directory, the versions and the worker-thread count

**Verification:** test — `test/service/daemon_startup.test.ts` ("logs one ready line naming the state directory, the
versions and the worker-thread count"), `test/service/bob_serve.test.ts`.

### REQ-004 — Supervision contract

The daemon SHALL run in the foreground and never fork itself into the background. It writes diagnostics to standard
error. It exits with status 0 only after a requested shutdown. Every other exit (startup failure, storage failure,
unexpected error) has a non-zero status. The supervisor restarts the daemon on a non-zero exit. Installation registers
the daemon with systemd and launchd so that it starts when the machine starts, without anyone logging in.

#### AC-004.1 — `bob serve` in the foreground

- **Given:** `bob serve` started with the directory flags
- **When:** it becomes ready, receives a signal, or fails to start
- **Then:** it writes the ready line to standard error and nothing to standard output, exits 0 on SIGTERM or SIGINT
  after ready, and exits non-zero naming the failed step when startup fails

**Verification:** test — `test/service/bob_serve.test.ts`.

#### AC-004.2 — Started and restarted by the supervisor

- **Given:** the daemon registered with systemd on Linux and launchd on macOS as installation does it
- **When:** the machine starts, and later the daemon is killed with a non-zero exit
- **Then:** it starts without a login, is restarted, and its run resumes

**Verification:** demonstration — S-002 live acceptance test 3 (Success Criteria 4), once Installation's supervisor
registration exists (`docs/development/release_form.md`, "What is still unverified").

### REQ-005 — Shutdown

On SIGTERM or SIGINT the daemon SHALL:

1. report "stopping" and stop accepting new calls
2. stop the started components, in reverse start order
3. close the database and every model connection
4. exit with status 0

Work running at that moment is not recorded as a team member's abort. It resumes on the next start, where calls that
aren't replay-safe come back as interrupted results. The stop bound is 10 seconds: if shutdown hasn't
finished by then, because some code doesn't honour its abort signal, the daemon exits with a non-zero status. No
queued input, waiting work or parked conversation is lost either way.

#### AC-005.1 — The shutdown sequence

- **Given:** a ready daemon with started components
- **When:** it receives SIGTERM
- **Then:** it reports "stopping", answers calls `unavailable`, stops components in reverse order, closes the database
  and exits 0

**Verification:** test — `test/service/daemon_shutdown.test.ts`, `test/service/daemon_process.test.ts` ("signals").

#### AC-005.2 — SIGTERM during a tool call

- **Given:** a run in the middle of a `bash` tool call
- **When:** the daemon receives SIGTERM, and is started again
- **Then:** it exits 0 within 10 seconds, records no abort, and the restarted run resumes with an interrupted result
  and settles once

**Verification:** test — `test/service/daemon_shutdown_process.test.ts`, `test/service/daemon_shutdown.test.ts`.

#### AC-005.3 — The stop bound

- **Given:** a component that doesn't stop when asked
- **When:** the daemon shuts down
- **Then:** it exits non-zero after 10 seconds and logs an error

**Verification:** test — `test/service/daemon_shutdown.test.ts`, `test/unit/constants.test.ts`.

### REQ-006 — Instance directories

The daemon SHALL use four directories, resolved from the XDG base directories, each in a folder named `the-intern`:

- config (configuration file)
- state (database)
- data (per-role default workspaces, S-001 REQ-003)
- runtime (the socket's directory, S-003). When `XDG_RUNTIME_DIR` is unset, as on macOS and under launchd, the
  runtime directory is the `run` folder inside the state directory.

Each can be overridden by a command-line flag (REQ-021). A missing directory is created owner-only (mode 0700). An
existing one that isn't a directory, isn't owned by the service account, or is accessible to the group or others
stops startup with an error naming the path and the reason. The database file is owner-only.

#### AC-006.1 — Resolution

- **Given:** XDG variables set, unset, empty or relative, and directory flags
- **When:** the directories are resolved
- **Then:** they are the XDG directories with `the-intern` appended, or the home defaults, or the flag value itself;
  the runtime fallback is inside the state directory; a relative flag is refused naming the value

**Verification:** test — `test/unit/state_layout.test.ts`.

#### AC-006.2 — Permissions

- **Given:** missing directories, and an existing path that is a file, group- or world-accessible, or owned by
  another account
- **When:** the daemon starts
- **Then:** missing directories are created 0700 and the database file 0600; each unsafe path stops startup naming the
  path and the reason, and nothing is created

**Verification:** test — `test/unit/state_layout.test.ts`, `test/service/daemon_lifecycle.test.ts` ("private
permissions"), `test/service/harness_host.test.ts` ("makes the database file and its wal and shm files owner-only").

### REQ-009 — Process model

The daemon SHALL be one process (Definitions), and a worker thread SHALL be a logical unit of capacity. How the daemon
runs agent runs and tool commands side by side follows ADR-001 decision 3.

- The number of worker threads is a built-in constant: **32**, the most concurrent agent runs the daemon is
  tested with. It changes only with a release, after load tests, and no one can configure it.
- The invocation depth cap (S-001 REQ-009) is a built-in constant: **10**. No one can configure it.

#### AC-009.1 — The constants

- **Given:** a release build with no test switch
- **When:** the constants and `daemon.status` are read
- **Then:** there are 32 worker threads and the depth cap is 10, and no setting changes them

**Verification:** test — `test/unit/constants.test.ts`, `test/unit/status_operation.test.ts`,
`test/service/admission_process.test.ts` ("no worker-thread switch").

### REQ-010 — Admission

S-001 REQ-010 SHALL hold, with these additions:

- An agent run takes a worker thread before its first model request, and gives it back when the conversation
  becomes idle, parked or aborted.
- The waiting order survives a restart. After a restart, runs that held a worker thread at the kill resume first, up
  to the worker-thread count. Waiting runs then start in that order.
- If more runs held a worker thread than the running release allows (a release lowered the count), the extra runs
  wait at the head of the queue in their original order.
- Admission never starves a waiting run: a run waits only for runs ahead of it in the queue or already active.

#### AC-010.1 — Arrival order

- **Given:** one worker thread (test switch)
- **When:** three submissions arrive for three conversations
- **Then:** they run one after another in arrival order, and a waiting conversation makes no model request

**Verification:** test — `test/service/admission.test.ts`, `test/service/admission_process.test.ts`,
`test/unit/admission_queue.test.ts`.

#### AC-010.2 — Release on abort

- **Given:** one running and one waiting conversation
- **When:** the running one is aborted, or the waiting one is
- **Then:** the head of the queue is granted, or the aborted waiting one leaves the queue without a model request

**Verification:** test — `test/service/admission.test.ts`.

#### AC-010.3 — The order survives a restart

- **Given:** one active and two waiting runs
- **When:** the daemon is killed with `kill -9` and restarted
- **Then:** the active run resumes first and the waiting runs start in their waiting order

**Verification:** test — `test/service/admission_process.test.ts`, `test/service/admission.test.ts`.

#### AC-010.4 — A lower count after a release

- **Given:** more held worker threads than the count after a restart
- **When:** the daemon starts
- **Then:** the extra runs wait at the head of the queue in their original order

**Verification:** test — `test/service/admission_process.test.ts`, `test/unit/admission_queue.test.ts`.

### REQ-011 — Visible capacity

The status operation and the instance feed SHALL report how many worker threads exist, how many are in use and which
conversations wait, with their queue positions. A conversation's status shows "waiting for a worker thread" while it
waits (S-001 REQ-016).

#### AC-011.1 — Status and feed report capacity

- **Given:** runs active and waiting
- **When:** `daemon.status`, `conversations.get` and the instance feed are read
- **Then:** they report the worker threads, the count in use and each waiting conversation with its position, and the
  waiting conversation's status is "waiting for a worker thread"

**Verification:** test — `test/unit/status_operation.test.ts`, `test/service/admission_process.test.ts`,
`test/service/instance_feed.test.ts`, `test/service/conversation_read_operations.test.ts`.

### REQ-012 — Operation catalogue

The service layer SHALL offer at least these operations, each marked **read** or **control** (Interfaces gives their
names):

- Read: daemon status; list conversations, marking the front desk; get one conversation (seat, origin, status,
  depth, invocation links); get the front desk's conversation id and seat (S-001 REQ-021); read a conversation's
  stored entries, paged, including entries from before resets and compactions; read its current context; read a
  submission's state; wait for a submission to settle, for a time the caller chooses, at most 5 minutes; list roles
  with their instructions, tools, skills and defaults; list registered workspaces; list available models and
  thinking levels; read usage per conversation and in total; inspect live pi-durable tasks per conversation;
  subscribe to the observation feed (REQ-014).
- Control: submit input with a request id and a busy mode (follow-up, steer or reject); withdraw a queued input;
  abort a conversation (with S-001's cascade); reset a conversation; compact a conversation; change a conversation's
  seat (S-001 REQ-004); create, change, restore and remove a role (S-001 REQ-003); register a workspace and unregister
  one (S-001 REQ-018). The settings operations follow REQ-022.
- Jobs: the `jobs.*` operations of S-004, read and control as Interfaces marks them. Starting a job's lead
  conversation (S-001 REQ-012) isn't a catalogue operation: `jobs.create` calls it in-process.

A submit to a conversation parked for reports holds the message until the conversation continues (S-001 REQ-020),
whatever its busy mode, and returns `{ held: true }` with no submission id. A submit to a job's lead conversation
parked because its job is Blocked isn't held: the lead continues with it (S-001 REQ-020; S-004 REQ-006). The
submission read, wait and withdraw operations take a submission id, so they don't apply to a held message. The
message shows in the conversation's transcript as its hold record, and once the conversation continues it is an input
like any other. A repeated submit with the same request id while the message is held returns `{ held: true }` again
and holds nothing twice.

A conversation of a Done job is closed (S-001 REQ-026). `conversations.list` and `conversations.get` give it status
`closed`, and every read operation works on it. From the job's complete or cancel, a submit in any busy mode, the
withdrawal of one of its submissions (`submissions.withdraw`), an abort, a reset, a compaction and a seat change of a
conversation of the job are refused `conflict`, with a message naming the conversation as closed, and change nothing.

S-001's agent coordination capabilities (handoff, invoke, steer) are control operations of the same service layer.
Later specs add theirs the same way (for example creating and answering jobs in S-004 and running a schedule now in
the schedules and triggers spec).

Creating a job (`jobs.create`) SHALL record an origin built from the caller, never taken from a team member or an
agent: a team member's call records a request with the caller's way in, an agent's call in a job's conversation
records a follow-up of the agent's own conversation, the front desk's call records a request with the way in of the
team member's input it answers and the front desk in its origin details (S-004 REQ-021), and only a job source (a
schedule fire, a trigger) states its own origin details. A team member's request records the details its way in
observes, which the caller carries: the remote address and port for the network listener, the message ID and sender
for Email. A call from a team member or an agent whose input names an origin is refused as `invalid_input` (S-004
Interfaces, `jobs.create`).

#### AC-012.1 — Every operation is callable in-process

- **Given:** a daemon with no listener
- **When:** every operation of the catalogue is called in-process
- **Then:** each returns its result, and the read operations leave every conversation unchanged

**Verification:** test — `test/service/conversation_read_operations.test.ts`,
`test/service/runtime_read_operations.test.ts`, `test/service/conversation_control_operations.test.ts`,
`test/service/role_operations.test.ts`, `test/service/workspace_operations.test.ts`,
`test/service/seat_operations.test.ts`, `test/service/job_operations.test.ts`, `test/service/instance_feed.test.ts`
("feed.subscribe"), `test/unit/status_operation.test.ts`.

#### AC-012.2 — Submissions

- **Given:** a conversation
- **When:** an input is submitted twice with one request id, with busy mode reject while busy, then withdrawn while
  queued, and read and waited on
- **Then:** it is admitted once, the reject is refused `busy` with nothing queued, the withdrawn input settles
  unanswered, and the wait returns the settled state or the current state at the timeout, which is at most 5 minutes

**Verification:** test — `test/service/conversation_control_operations.test.ts`,
`test/service/conversation_control.test.ts`, `test/service/runtime_read_operations.test.ts`.

#### AC-012.3 — A submit to a conversation parked for reports is held

- **Given:** a conversation parked for reports
- **When:** input is submitted in each busy mode, and one request twice
- **Then:** each returns `{ held: true }` with no submission id, holds the message once, and delivers it when the
  conversation continues

**Verification:** test — `test/service/steer.test.ts` ("a parked conversation").

#### AC-012.4 — Paged entries and the context

- **Given:** a conversation with a reset and a compaction
- **When:** its entries and its context are read
- **Then:** the entries page oldest first with a cursor and include those before the reset and the compaction, and
  the context holds only what the model sees now

**Verification:** test — `test/service/conversation_read_operations.test.ts`, `test/service/harness_host.test.ts`.

#### AC-012.5 — The origin comes from the caller

- **Given:** callers of each kind: a team member with a way in, a team member with none named, an agent, and a job
  source
- **When:** each creates a job with `jobs.create`; one team member's call names a request origin with another way in,
  and another names a schedule, trigger or follow-up origin
- **Then:** the team member's job records a request with the caller's way in; the team member's call with no way in
  named, whose way in is `in-process` (S-001 AC-007.1), is refused `invalid_input` (S-004 REQ-002); the agent's job
  records a follow-up of its own conversation; the job source's job records the origin it states; and each team
  member's call that names an origin, of any kind, is refused `invalid_input` and creates nothing

**Verification:** test — `test/service/job_operations.test.ts`.

#### AC-012.6 — The front desk

- **Given:** a started daemon with both listeners and several job conversations
- **When:** `desk.get` and `conversations.list` are called in-process and over each listener
- **Then:** `desk.get` returns the front desk's conversation id and its seat (role `desk`, model, thinking level,
  workspace), the same as `conversations.get` returns for that id, and `conversations.list` marks that conversation,
  and no other, as the front desk

**Verification:** test — a service test through both listeners on the fake model.

#### AC-012.7 — A closed conversation

- **Given:** a closed conversation (S-001 REQ-026)
- **When:** a team member submits input to it, withdraws one of its submissions, and aborts, resets, compacts and
  reseats it
- **Then:** each is refused `conflict` naming the conversation as closed, and the conversation is unchanged

**Verification:** test — the service test of S-001 AC-026.2.

### REQ-013 — Operation contract

Every operation MUST:

- validate its input and refuse an invalid call without changing state
- name its caller's actor and, for a team member, the details its way in observed, which S-001 records where it
  requires attribution
- end with a result or one of a fixed set of error outcomes: not found, invalid input, busy (a reject-if-busy submit, or
  a resource in use for now), conflict, unavailable (the daemon isn't ready or is stopping), internal. Each outcome
  carries a message that names what failed.

A control operation that creates something (a job, a role, a workspace registration) accepts an
idempotency key. A repeated call with the same key returns the original result and creates nothing. Submits are
idempotent through their request id. Read operations never change state.

#### AC-013.1 — Validation and error outcomes

- **Given:** the catalogue
- **When:** operations are called with an unknown name, no actor, invalid input, outside their phases, or a failing
  run
- **Then:** each ends with `not_found`, `invalid_input`, `unavailable` or `internal` naming the failure, without
  running or changing state; a service error from the run passes through unchanged

**Verification:** test — `test/unit/operations.test.ts`, and the `invalid_input` and `not_found` scenarios of each
operation test in `test/service/`.

#### AC-013.2 — Idempotency keys

- **Given:** a create operation with an idempotency key
- **When:** it is repeated, concurrently, after a restart, or after a crash between creating and recording the key
- **Then:** the original result is returned and nothing is created twice; an empty or malformed key is refused

**Verification:** test — `test/service/idempotency.test.ts`, `test/service/role_operations.test.ts`,
`test/service/workspace_operations.test.ts`, `test/service/job_operations.test.ts`.

### REQ-014 — Snapshot, then deltas

A subscription SHALL name a scope: the instance (conversations with seat, status and admission state, plus started
and finished events, and S-004's jobs and job deltas, each published after its job store commit and numbered in the
same sequence), or one conversation (its live view, events and queued input). It first gets a snapshot, then deltas
in commit order. A new subscription never replays earlier deltas. A subscriber that reconnects starts from a
fresh snapshot.

#### AC-014.1 — Conversation scope

- **Given:** a conversation with a run
- **When:** a client subscribes, then subscribes again
- **Then:** each subscription gets a snapshot and then deltas in commit order with increasing sequence numbers, and
  the second starts from a fresh snapshot without replaying

**Verification:** test — `test/service/conversation_feed.test.ts`, `test/service/host_observation.test.ts`.

#### AC-014.2 — Instance scope

- **Given:** several conversations
- **When:** a client subscribes to the instance
- **Then:** the snapshot holds every conversation with its job, lead flag, seat, status and the worker threads, and
  the deltas report creations, runs, seat and status changes, admission and settings changes in order

**Verification:** test — `test/service/instance_feed.test.ts`, `test/service/host_observation.test.ts`.

### REQ-016 — Transport-free and complete

Everything a client can do, it SHALL do through a service operation (REQ-012), and every operation MUST be callable
in-process with no listener. No operation reads transport details, a connection or the caller's machine to decide its
outcome. No listener authenticates callers: whoever can reach a listener can call the operations it exposes (S-000).
Which operations a listener exposes is the listener's choice (S-003).

#### AC-016.1 — No transport in the service layer

- **Given:** the service layer's code and the operation tests
- **When:** a reviewer checks them
- **Then:** every operation is called in-process in the tests, and the service layer follows ADR-001 decision 2 on
  transports; observed caller details are recorded only, and no outcome depends on them

**Verification:** inspection — `src/service/`; test — AC-012.1's tests.

### REQ-017 — Classified operations and one feed

The read or control mark of each operation SHALL be part of the catalogue, so a listener can expose read operations
only, and add control operations later without changing the service layer. The observation feed is the only source of
live data for clients, so every client's live view is derived from it without a second path into the daemon's state.

#### AC-017.1 — Every operation is marked

- **Given:** the catalogue
- **When:** it is enumerated, or an operation is defined without a valid kind
- **Then:** every operation is listed with its read or control mark, and a definition without one is refused

**Verification:** test — `test/unit/operations.test.ts`.

### REQ-019 — Explicit settings mapping

Only the pi agent settings the-intern maps explicitly SHALL take effect. At least these are mapped: transport,
retry, steering and follow-up modes, compaction thresholds and stream timeouts. Every mapped setting has a test.
Unmapped settings have no effect, and the user manual lists the mapped ones.

#### AC-019.1 — One test per mapped setting

- **Given:** a `settings.json` with each mapped setting, an unmapped one, and wrong-typed values
- **When:** it is mapped
- **Then:** each mapped setting takes effect, unmapped and wrong-typed values have no effect, and valid
  siblings are kept

**Verification:** test — `test/unit/settings_mapping.test.ts`, `test/unit/model_runtime.test.ts`; inspection — the
user manual lists the mapped settings (`docs/manual/running_the_intern.md`, "Pi agent settings that take effect").

### REQ-020 — Versions

The status operation SHALL report the-intern's version and the pi package versions in use. The instance keeps, with its
database, which versions last opened it. When they differ from the running versions, the daemon logs the change at
startup and continues.

#### AC-020.1 — Versions are reported and changes logged

- **Given:** a database last opened by other versions, and a first start
- **When:** the daemon starts and status is read
- **Then:** status reports the versions; the change is logged and the daemon reaches ready, and a first start logs no
  change

**Verification:** test — `test/service/versions.test.ts`, `test/service/daemon_startup.test.ts`,
`test/unit/status_operation.test.ts`.

### REQ-021 — Configuration loading

Each setting SHALL have one source:

- the configuration file in the config directory holds the settings of S-001 (the team's roles, the changes to
  the shipped roles, and the registered workspaces) and the sections later specs add, such as S-003's `[network]`
- command-line flags set the instance directories (REQ-006)
- the environment sets the pi agent folder, as for pi agent itself

Built-in defaults apply where a source gives nothing. The file is optional, and a missing one means built-in
defaults. A file that exists but can't be parsed, contains unknown keys or holds invalid values stops startup with
an error naming the file, the key and the reason. The daemon reads the file at startup only; hand edits take effect
at the next restart.

#### AC-021.1 — Loading and refusals

- **Given:** no file, a valid file, unparsable TOML, an unknown top-level or section key, and an invalid value
- **When:** the configuration is loaded
- **Then:** defaults apply for a missing file or section; each invalid file stops startup naming the file, the key and
  the reason

**Verification:** test — `test/unit/config_file.test.ts`, `test/unit/roles_section.test.ts`,
`test/service/daemon_lifecycle.test.ts`, `test/service/agents_startup.test.ts`.

#### AC-021.2 — The pi agent folder from the environment

- **Given:** `PI_CODING_AGENT_DIR` set, and unset
- **When:** the pi agent folder is resolved
- **Then:** it is the variable's value, or pi agent's default

**Verification:** test — `test/unit/model_runtime.test.ts` ("resolvePiAgentDir").

### REQ-022 — Settings changed at runtime

The settings in the configuration file SHALL also be changeable through control operations (REQ-012), from any client.

- The daemon validates the change as at startup (S-001 REQ-018, Configuration Requirements). An invalid change is
  refused with a message naming the setting and the reason, and nothing changes.
- A valid change is written to the configuration file first, atomically and owner-only, and applies at once. The
  file stays the single source of truth, so the change survives a restart.
- A change applies as S-001 states: a role change affects only agents seated after it, a newly
  registered workspace can be used at once, and unregistering follows S-001 REQ-018 (refused while a role's default
  workspace is that workspace; seated agents keep it until their seat changes; new seats can't name it).
- If the file was changed on disk since the daemon last read it, the change is refused as a conflict naming the
  file, so a hand edit is never overwritten. A restart picks up the hand edit.
- If the file can't be written, the change is refused and nothing applies.
- Writing a change keeps every section and setting it doesn't change, including sections other specs own (S-003
  `[network]`).
- Each change appears in the instance feed.

#### AC-022.1 — A valid change is written and survives a restart

- **Given:** a running daemon
- **When:** a role is created or changed, or a workspace registered or unregistered, through the service
- **Then:** the file is written owner-only with no temporary file left, the change applies at once and appears in the
  instance feed, and it survives a restart

**Verification:** test — `test/unit/config_writer.test.ts`, `test/service/role_operations.test.ts`,
`test/service/workspace_operations.test.ts`, `test/service/instance_feed.test.ts`.

#### AC-022.2 — Refused changes leave the file as it was

- **Given:** an invalid change, a file edited by hand since it was read, an unwritable file, or an unregistration
  refused under S-001 REQ-018
- **When:** the change is requested
- **Then:** it is refused (`invalid_input`, `conflict` naming the file, or `internal`), and the file and the running
  settings are unchanged

**Verification:** test — `test/unit/config_writer.test.ts`, `test/service/role_operations.test.ts`,
`test/service/workspace_operations.test.ts`.

#### AC-022.3 — Seated agents keep their seat

- **Given:** an agent seated before a role change
- **When:** the role changes through the service
- **Then:** the agent keeps its seat until its seat changes

**Verification:** test — `test/unit/role_catalog.test.ts`, `test/service/role_prompt_extension.test.ts`.

## Quality Requirements

### REQ-001 — Single owner

Starting a daemon for an instance whose database another live daemon owns MUST be refused before the database is
opened. The refusal names the instance's state directory and the owning process id, and exits with an error. If the
recorded owner is no longer alive, the new daemon takes ownership and starts normally.

#### AC-001.1 — A second daemon is refused

- **Given:** a daemon owning an instance
- **When:** a second daemon starts on the same state directory
- **Then:** it is refused naming the state directory and the first daemon's pid, and the first daemon still owns the
  instance

**Verification:** test — `test/service/daemon_lifecycle.test.ts` ("single ownership"), `test/unit/ownership.test.ts`.

#### AC-001.2 — A stale owner is taken over

- **Given:** an ownership record left by a daemon killed with `kill -9`, by an earlier boot, or unparsable
- **When:** a new daemon starts, or two race for it
- **Then:** exactly one takes ownership and starts normally

**Verification:** test — `test/unit/ownership.test.ts`, `test/service/daemon_lifecycle.test.ts`.

#### AC-001.3 — Separate instances run side by side

- **Given:** two state directories
- **When:** a daemon starts on each
- **Then:** both run

**Verification:** test — `test/service/daemon_lifecycle.test.ts`.

### REQ-007 — Storage failure

When the database closes because of a storage error, or a job store write fails (S-004 REQ-020), the daemon MUST log the
error, stop accepting calls and exit with a non-zero status within the stop bound (REQ-005). It doesn't try to reopen
the database itself. After the supervisor restarts it, unfinished work resumes from its last checkpoint.

#### AC-007.1 — Exit and resume

- **Given:** a run in progress
- **When:** a database write fails with a storage error, and the daemon is started again
- **Then:** it exits non-zero within 10 seconds without reopening the database, and the run resumes from its last
  checkpoint and settles once

**Verification:** test — `test/service/daemon_shutdown_process.test.ts`, `test/service/daemon_shutdown.test.ts`,
`test/service/harness_host.test.ts`.

### REQ-008 — Crash recovery

After a kill at any point, including `kill -9` during a model request, a tool call, an admission decision or a service
operation, the next start MUST:

- resume every unfinished agent run
- keep every queued input, parked conversation and waiting run
- leave every service operation that changes state either completed or not applied, never half-applied (S-001
  REQ-017); a job operation cut off part way is completed by S-004 REQ-018 at the next start, before any listener
  answers a call other than `daemon.status`

#### AC-008.1 — Kill at each point

- **Given:** a daemon during a model request, a `bash` tool call, queued follow-ups, an admission change and a create
  operation
- **When:** it is killed with `kill -9` and restarted
- **Then:** the run resumes and settles once, the tool call comes back as an interrupted result, every queued input is
  answered once, every run finishes, and a retried create holds exactly one conversation

**Verification:** test — `test/service/crash_recovery.test.ts`, `test/service/agents_crash.test.ts`,
`test/service/agents_crash_reports.test.ts`.

### REQ-015 — Viewers don't affect work

A subscriber that falls more than a bounded amount behind MUST be disconnected and has to subscribe again. Neither a
slow, disconnected or crashed subscriber nor any number of subscribers delays an agent run, holds a worker thread or
loses a committed change. The bound is 1000 undelivered deltas.

#### AC-015.1 — A lagging subscriber is dropped

- **Given:** a subscriber that stops reading
- **When:** more than 1000 deltas are undelivered
- **Then:** it is closed with reason `lagging`, a running agent run is not delayed, and the run's entries are the same
  as with no subscriber

**Verification:** test — `test/service/conversation_feed.test.ts`, `test/service/instance_feed.test.ts`.

### REQ-018 — Service account credentials

Models and their credentials MUST come from the service account's pi agent login and model registry, used in place.
The daemon writes nothing into pi agent's agent folder except token refreshes made by the login itself, under pi
agent's own lock, so a person's pi under the same account and the daemon never log each other out. Every other
credential the-intern acts with (mail, wiki, repositories, other hosts) is the service account's, in that account's
usual places. No credential is copied into the instance's directories or the database.

#### AC-018.1 — The pi agent folder is untouched

- **Given:** an isolated pi agent folder with credentials
- **When:** a daemon runs and is stopped
- **Then:** every file in the folder is byte-identical apart from the login's own token file, no `auth.json` is created
  where there was none, and no credential string appears in the instance directories or the database

**Verification:** test — `test/service/credentials.test.ts`, `test/unit/model_runtime.test.ts`.

## Configuration Requirements

- **Configuration file.**
  - **What:** the S-001 settings: the team's roles, the changes to the shipped roles, and the registered workspaces.
    Later specs add their sections and say which of their settings change at runtime.
  - **Where:** a TOML file in the config directory (REQ-006). Written by hand, or by the settings operations
    (REQ-022).
  - **Constraints:** a trusted, owner-only input. Unknown keys are refused.
  - **Missing:** built-in defaults for every setting. An invalid file stops startup (REQ-021).
- **Instance directories.**
  - **What:** the config, state, data and runtime directories (REQ-006), so several instances or tests can run side
    by side.
  - **Where:** the XDG base directories by default, overridable by command-line flags only.
  - **Constraints:** absolute paths. Owner-only directories owned by the service account.
  - **Missing:** the XDG defaults, created owner-only. An unsafe existing directory stops startup.
- **pi agent folder.**
  - **What:** where the pi agent login, settings and models are read.
  - **Where:** pi agent's own default, including its `PI_CODING_AGENT_DIR` override (**Contract**: pi agent's
    variable name).
  - **Constraints:** read-only for the daemon, apart from the login's token refresh (REQ-018). Tests always point it
    at an isolated folder.
  - **Missing:** a missing login doesn't stop the daemon unless a configured model needs it (S-001). Model requests
    fail with an error the agent run shows.
- **Fake model (test only).**
  - **What:** runs the daemon on the fake model with no network, for deterministic tests. A second test-only switch
    sets a smaller worker-thread count, so tests can fill every worker thread.
  - **Where:** test-only switches. They are not in the user manual and not in the configuration file.
  - **Constraints:** never enabled by default.
  - **Missing:** the real models.

Built-in constants, not configurable: 32 worker threads and an invocation depth cap of 10 (REQ-009), the 10-second stop
bound for shutdown and storage failures (REQ-005, REQ-007), and a submission wait of at most 5 minutes (REQ-012). S-001
records the two capacity constants by amendment.

## Assumptions and Dependencies

- **pi-durable** (the pinned version in `README.md`). Provides durable storage on one SQLite file with one owner per
  storage, recovery, exactly-once input by request id, queued input, checkpoints and interrupted results for calls that
  aren't replay-safe. The daemon relies on these instead of recovery code of its own (ADR-001); host writes during a
  running turn are queued (ADR-003). A pi-durable upgrade that changes them needs a review of REQ-001, REQ-005, REQ-007,
  REQ-008 and REQ-010.
- **pi agent login, settings and model registry** of the service account (the `pi-coding-agent` package). The login
  refreshes its own token under its own lock (REQ-018).
- **Platforms.** Linux x64 and Apple silicon macOS, with the XDG base directories as resolved in REQ-006. The
  supervisor registration with systemd and launchd comes from S-000's Installation and service setup (REQ-004); until
  it exists, live acceptance test 3 can't run.
- **S-001** defines the conversations, roles, seats and coordination this daemon runs, and the settings the
  configuration file holds.
- **S-003, the control-endpoint spec**, defines the listeners that expose the catalogue.
- **S-004, the Jobs spec**, defines the job store in the same database, the `jobs.*` operations, the job deltas on the
  instance feed and the job repair rules that startup step 7 applies.
- **Assumption, confirmed by ADR-002:** the team members who can reach a listener are trusted equally, and the service
  account bounds what agents can do, so no listener authenticates callers.

## Success Criteria

1. Every requirement's acceptance scenarios pass in `npm test` on the fake model, with an isolated instance, an
   isolated pi agent folder and no network, including the kill-and-restart scenarios (REQ-001 to REQ-022).
2. Live acceptance test 1: the daemon starts under the account running the test, answers a prompt in the lead
   conversation of a test job, and leaves `~/.pi` unchanged apart from a token refresh (REQ-002, REQ-003, REQ-012,
   REQ-018). Measured by `npm run test:live` (`test/live/live_daemon.ts`) against a real model.
3. Live acceptance test 2: a `kill -9` during a long `bash` call, then a restart by hand; the run continues with an
   interrupted result and its submission settles once (REQ-008). Measured by `npm run test:live`.
4. Live acceptance test 3: registered with systemd on Linux and launchd on macOS as installation does it, the daemon
   starts at machine startup without a login; killing it with a non-zero exit gets it restarted, and the run resumes
   (REQ-004, REQ-007, REQ-008). Measured by hand on each platform once Installation's supervisor registration exists.
5. Without the test switch, `daemon.status` reports 32 worker threads, and no operation exists outside the catalogue's
   read and control marks (REQ-009, REQ-017). Measured by `npm test`.

## Implementation Order

Delivered: every phase below is implemented, apart from live acceptance test 3, which waits for Installation's
supervisor registration.

| Phase | What | Depends On |
|---|---|---|
| 1 | Lifecycle, configuration, instance directories and single ownership; the daemon on the fake model; status; kill and restart tests | Nothing |
| 2 | Real models: pi agent login, model validation, settings mapping, closing connections on shutdown; live test 1 | Phase 1 |
| 3 | Service layer with the read and control catalogue, and the observation feed | Phase 1 |
| 4 | Admission and worker threads, durable across restarts | Phase 3 |
| 5 | Supervision: storage-failure exit, shutdown bound, live tests 2 and 3 with the installed supervisor registration | Phases 1–4, the bootstrap plan's supervisor registration |

S-001 phase 1 needs phases 1 to 3 of this spec. S-001 phase 4 needs phase 4.

## Open Questions

None affect the specified behaviour. Retention of old conversations is a later decision, recorded under Exclusions.

## Amendment Log

| Date | What changed | Why | Affected tasks |
|------|-------------|-----|----------------|
| 2026-10-30 | Aligned with the rewritten S-000: the spec covers S-000's Intern service; the daemon serves a team through the command line and a web interface over the network, and no listener authenticates callers; the daemon runs as one service account (the installing person's in v1) whose pi login and other credentials are used in place; the supervisor starts it at machine startup without a login; the root conversation, chat, policy, approvals and audit are removed; role operations cover creating, changing, restoring and removing roles; the job record crosses versions by export and import (Purpose, Definitions, Exclusions, Design Principles, System Diagram, Responsibility Separation, components 2 and 5, R-2, R-4, R-6, R-12, R-16 to R-18, R-21, R-22, Workflow, Configuration Requirements, Verification, Implementation Order). Consistency review: the plain "create a conversation" operation became "start the lead conversation of a job" (S-001 R-12); job sources replace entry points; listeners belong to S-000's Intern service; Installation is decided in the bootstrap plan; live test 3 covers launchd. | Product owner ruling: S-000 is the source of truth, and S-002 is aligned as part of creating S-000. | None; S-002 isn't broken down yet |
| 2026-10-31 | The runtime directory falls back to the `run` folder inside the state directory when `XDG_RUNTIME_DIR` is unset (R-6). | Product owner ruling during the breakdown: the XDG base directories give no default for the runtime directory, and macOS and launchd don't set it. | None; S-002 isn't broken down yet |
| 2026-11-01 | Design Principles: "Durability belongs to the runtime" names its bounded exception, the-intern's own facts about a conversation and redelivery from them. R-12: a submit to a parked conversation returns `{ held: true }` with no submission id in every busy mode, and the submission read, wait and withdraw operations don't apply to a held message; Verification item for it. | Spec-truth reconciliation of S-001 (findings F6 and F10). Driving ADR: ADR-001 decision 4, amended 2026-11-01. | T-034, T-071, T-073, T-075 (built as amended); follow-up T-086 |
| 2026-11-01 | Design Principles, "Durability belongs to the runtime": the-intern's own facts also include a conversation's parked state and its abort mark; an abort's facts are written in one commit just before pi-durable's abort, not in pi-durable's abort commit. | S-001 v0.3 R-8 and R-8a (product owner decision F3): a lone abort owes the invoker an "aborted" report, and an abort withdraws held messages and awaiting links. Driving ADR: ADR-001 decision 4, amended 2026-11-01. | T-084, T-085 |
| 2026-11-01 | v0.6, format only; no requirement changed meaning. Restructured to the ai-team 0.18.0 spec format: requirements renumbered `R-n` → `REQ-00n`/`REQ-0nn` with the same number; each requirement got acceptance scenarios with a Verification method, taken from the former Verification section and naming the tests that cover them; R-1, R-7, R-8, R-15 and R-18 moved to Quality Requirements; R-15's "bounded amount" names the implemented bound of 1000 undelivered deltas; Components merged into Responsibility Separation; rejected designs moved from Exclusions to Alternatives Considered; added Users and Journeys, Interfaces (the `bob serve` command, the operation catalogue's names and kinds and the feed, from the shipped code), Assumptions and Dependencies, Success Criteria (from the Purpose outcomes and the live acceptance tests) and Open Questions. Earlier rows keep their `R-n` identifiers. | Product owner request: S-002 must match the ai-team 0.18.0 format, keeping its meaning so the implementation stays valid. | None; references in code, docs and ADRs updated to the new identifiers |
| 2026-11-01 | v0.7. REQ-003: listeners open in step 8 and refuse every call but status as `unavailable` until ready. REQ-012 and new AC-012.5: a lead conversation's origin is built from the caller; only job sources state their own. REQ-021: the configuration file also holds sections later specs add. REQ-022: a settings write keeps sections it doesn't change. Assumptions: S-003 exists. | S-003 architecture consistency review (findings 2, 3, 6, 7, 13; re-run finding B); product owner decision 2026-11-01: the origin is built in the service from the caller. The current code takes the origin from the input and may drop unknown sections; a task investigates the deviations. | Investigation task to be created in the S-003 breakdown |
| 2026-11-02 | v0.8. Definitions, Database: the job store's `intern_` tables. Design Principles: "Durability belongs to the runtime" has two bounded exceptions, the second being ordered job writes and the four startup repair rules (S-004 REQ-018); "One owner per database" allows the import step under the single-owner lock (S-004 REQ-017). Exclusions: only the job store's tables migrate, and export and import copy the whole database without converting it. REQ-002 and AC-002.2: step 4 reads the job schema version first and creates or migrates the job store; step 7 applies the job repair rules before resuming work. REQ-007: a failed job store write is handled as a storage error. REQ-008: a job operation cut off between its job write and its pi-durable change is completed by S-004 REQ-018. REQ-012 and Interfaces: `jobs.startLead` leaves the catalogue and the `jobs.*` operations join it; creating a job records the origin, with the details a team member's way in observes; only a conversation parked for reports holds a submitted message (AC-012.3), and a lead parked for its Blocked job continues on the submit. AC-012.5: callers create jobs with `jobs.create`, and a call naming no way in is refused. REQ-013: the actor carries the observed way-in details; a job is the create example. REQ-014 and the feed in Interfaces: S-004's job deltas, published after their job store commit, in the same sequence. AC-016.1: observed caller details are recorded only. Assumptions: S-004. | S-004 architecture consistency review; product owner decisions 2026-11-02. Driving ADR: ADR-001, amended 2026-11-02 for the job store. | None yet; the code changes (startup steps 4 and 7, the catalogue, the held-message rule, the job deltas) come in the S-004 breakdown |
| 2026-11-02 | v0.9. REQ-012 and AC-012.5: a team member's or an agent's `jobs.create` call that names an origin of any kind is refused `invalid_input`, as S-004 Interfaces states. | Gate 2 review of the S-004 task plan. | T-117 |
| 2026-11-03 | v0.10. The front desk (S-001 v0.8). REQ-012, Interfaces and new AC-012.6: the read operation `desk.get` returns the front desk's conversation id and seat, and `conversations.list` marks the front desk; a job the front desk creates records a request with the way in of the input it answers and the front desk in its origin details. REQ-002: step 6 also ensures the front desk. | Product owner decisions of the front desk brainstorm, 2026-11-03. S-002 owns the catalogue. | None yet; the front desk comes in the breakdown of this amendment |
| 2026-11-03 | v0.11. REQ-012: a conversation of a Done job is closed (S-001 v0.9 REQ-026); the list and get give it status `closed`, every read works on it, and submit, abort, reset, compact and seat on it are refused `conflict`. Architecture consistency review (findings F2, F4 and F8), same version: REQ-012, the refusals apply from the job's complete or cancel and include `submissions.withdraw`; new AC-012.7, verified by the service test of S-001 AC-026.2. | Product owner decision of 2026-11-03, during the S-005 dev-loop (T-166). S-002 owns the catalogue and its error outcomes. Architecture consistency review of the amendment, 2026-11-03. | T-166 (blocked on it); T-186 to T-196 (Gate 2 passed 2026-11-03; the amendment merged into `dev-pi-durable-s005` before the preflight, by the product owner's approval of the in-flight amendment) |
| 2026-11-05 | Same version, format only; no requirement changed. Restructured to the ai-team 0.19.0 spec layout: `## Architecture` is gone and `## Alternatives Considered` is a top-level section holding solution alternatives only. The design principles are dropped: each is a requirement, its rationale or an implementation constraint already recorded elsewhere. The device-model alternative stays, because it is a different interface for the same need. The other three alternatives were implementation approaches: they, the system diagram, the responsibility table and the durability principle moved to `docs/development/architecture.md`, and ADR-001 records the reasoning. Configuration Requirements and Implementation Order no longer use the table's component names "state layout", "harness host" and "model runtime". | ai-team 0.20.0 upgrade; specs say what, the architecture documents and ADRs say how | T-185 |
| 2026-11-05 | v0.12. No behaviour changes (CR-001): technology and implementation words leave the requirement text, and each REQ keeps its guarantee. Changed: AC-001.1, AC-001.2, REQ-002 (the same eight steps and numbers), AC-002.1, AC-002.2, AC-003.1, REQ-005, AC-005.1, AC-005.3, REQ-007, AC-007.1, REQ-008, REQ-009 (constants unchanged), REQ-010, AC-010.3, REQ-013, AC-016.1, REQ-017, REQ-019, AC-019.1, REQ-020, with the copies in Definitions, Users, Exclusions, Workflow and Implementation Order. Moved statements live in ADR-001 decisions 1, 2, 3, 4 and 5 and `docs/development/architecture.md`. AC-016.1 points to ADR-001 decision 2. No identifier added or retired. | CR-001, approved by the product owner. | T-202 (inspects AC-016.1); spec text otherwise |
| 2026-11-05 | v0.13. No behaviour changes. Workflow and REQ-002 step 7: the daemon restores admission, applies the job repair rules, resumes unfinished work, then submits the input those rules owe (S-004 v0.12 REQ-018). REQ-008: a job operation cut off part way is completed by S-004 REQ-018 at the next start, before any listener answers a call other than `daemon.status`, in place of "before work resumes". | spec-truth reconciliation: the text was stale against the built behaviour, and the Architect found no behaviour change (D1). | None; spec text only |
| 2026-11-05 | spec-truth reconciliation — PASS | Work in 8e1eaa08..HEAD confirmed against v0.13; step 7, Workflow and REQ-008 corrected for input submitted after the resume, before listeners open; earlier task logs not read | none |
| 2026-11-06 | v0.14. No behaviour changes. REQ-013: the gloss of `busy` reads "a reject-if-busy submit, or a resource in use for now". No identifier added or retired. | S-006 second architecture consistency review, finding F3, product owner decision of 2026-11-06: `jobs.export` (S-004 REQ-016) and the export route (S-003 REQ-016) refuse `busy` for a resource in use, which the old gloss didn't cover. Approved with S-006 at Gate 1. | None; spec text only |
