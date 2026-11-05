# Architecture

A high-level map of how The Intern fits together at runtime and which spec owns each part. It restates no
requirements: the specs and the accepted ADRs are the source of truth, and where this page differs from them, fix this
page. Read [S-000](../ai-team/specs/S-000-system-overview.md) for scope. The shared vocabulary and the spec map are in
[system_overview.html](../system_overview.html) (sections 4 and 5), and are not repeated here. The module rule comes
from ADR-001 decision 2 and ADR-005, and the [coding guidelines](coding_guidelines.md) give the detail.

## Runtime shape

The Intern is one daemon process (`bob serve`) that owns one database, one SQLite file in the instance's state
directory. The file holds pi-durable's tables and the job store's `intern_` tables
([S-002](../ai-team/specs/S-002-daemon-and-host-runtime.md), [S-004](../ai-team/specs/S-004-jobs.md),
[ADR-001](../ai-team/decisions/ADR-001-one-daemon-process-owns-one-pi-durable-database.md)).
Nothing else reads or writes that file, except the import step while the daemon is stopped. The operating system's
supervisor starts the daemon and restarts it after an error exit, and unfinished work resumes from its checkpoints.

```
 ways in: command line (local) · web interface (network) · email
        │                                job sources: schedules, triggers
        ▼                                          │
   listeners ──────────────┐                       │
                           ▼                       ▼
 ┌─ daemon process ─────────────────────────────────────────────────┐
 │  service layer (read and control operations) ◄── agent tools     │
 │        │                                  │                      │
 │        ▼                                  ▼                      │
 │  admission (worker threads)        observation feed ──► clients  │
 │        │                                                         │
 │        ▼                                                         │
 │  harness host + the-intern's pi-durable extensions ──► models    │
 └───────────────────────────────┬──────────────────────────────────┘
                                 ▼
         one database: pi-durable's tables + the job store
```

- **Service layer.** Every capability is a named read or control operation. Listeners, job sources and agent tools all
  call the same operations, and the layer knows nothing about transports, so adding a listener changes no operation
  (S-002).
- **Listeners.** Two listeners serve one HTTP protocol and belong to the Intern service
  ([S-003](../ai-team/specs/S-003-control-endpoint.md)). The local socket, `bob.sock` in the instance's runtime
  directory, is always on and serves the `bob` commands on the machine. The network listener is off until the
  configuration file has a `[network]` section; it then listens on the configured address and fixed port, in plain
  HTTP, and serves the web interface. Both expose every catalogue operation at `POST /operations/<name>`, with the
  routes derived from the catalogue so a new operation needs no listener change, and the observation feed as
  Server-Sent Events at `GET /feed`. Operation calls must send a JSON body (`Content-Type: application/json`, at
  most 10 MiB). Only the network listener serves the web interface files, under `/ui/`. No listener authenticates
  callers, refuses a call because of its `Origin`, `Host` or `Referer` header, or encrypts traffic: whoever reaches a
  listener is a team member ([ADR-002](../ai-team/decisions/ADR-002-equal-team-members-bounded-by-the-service-account.md)). Each
  listener stamps the way in itself: it calls the service layer as a team member with the way in `command line` on
  the local socket and `web interface` on the network listener, and nothing in a request changes the caller (S-003
  REQ-007).
- **Client library.** The TypeScript library in `src/client/` calls operations and follows the feed through a
  listener, from Node over the local socket or a URL, or from a browser over a URL. The `bob` commands and the web
  interface reach the daemon only through it (S-003 REQ-009).
- **Job origin.** The service layer builds a job's origin from the caller, never from the input: a team member's job
  records a request with the caller's way in, an agent's job a follow-up of its conversation, and only a job source
  states its own origin (S-002 REQ-012, AC-012.5).
- **Observation feed.** The one source of live data for clients: a snapshot, then deltas. A client that is slow or
  gone never affects an agent run (S-002).
- **Worker threads.** A worker thread is a logical slot for one active agent run, not an operating-system thread. The
  count is fixed, and work beyond it waits in a stored arrival order (S-001, S-002, ADR-001).
- **Jobs and conversations.** Work is organised as jobs. Each job has one lead conversation whose current agent is
  the job's lead. Roles are the configuration agents are made from; a seat is a role's place in a conversation. The
  lead can hand its conversation to an agent of another role, or invoke agents of specialist roles in conversations of
  their own that report back (S-001).
- **Conversation ids.** `src/host/conversation_id.ts` is the one place that reads a conversation id from text:
  `parseConversationId` accepts only the digits of the id with no leading zero, the way the product writes it, and
  `toConversationId` throws for an id the product wrote itself. A spelling such as `07` names no conversation, so a
  comparison of two id strings, a lookup keyed by one and the conversation it resolves to agree.
- **Closed mark.** Every conversation of a job closes when the job is Done. The mark is the `closed` field of the
  conversation's `intern.conversation` document (`ConversationMeta` in `src/host/seating.ts`). A job's abort sets it,
  with the parked state, the awaiting links and the held messages cleared, in the abort's own commit. That commit also
  removes the conversation's queued inbox items and settles them `unanswered` with reason `closed`. Nothing clears it,
  and a document written without the field reads as not closed. A conversation also counts as closed while its job is
  Done, before the mark is set (`isConversationClosed` in `src/host/job_section.ts`). The front desk and a conversation
  with no job are never closed. The conversation lists with status `closed` (`ConversationStatus` in
  `src/service/conversation_read_operations.ts`), and every read operation still works on it (S-001 REQ-026).
- **Per-job serial section** (`src/host/job_section.ts`). The section orders, per job and in this process, the job
  abort's listing and marking of the job's conversations with every admission, control operation and creation that
  touches one, so none slips in between the listing and the marks. `inJobSection(host, jobId, work)` runs the work
  after every earlier section of the job has settled, and the work must not enter another section.
  `inOpenConversation(host, conversationId, work)` reads the conversation's job, then runs the closed check and the work
  in that job's section; for the front desk and a conversation with no job it runs the work with no section. Both
  throw `ConversationClosedError`, and a lead start for a Done job throws `JobDoneError` (`refuseIfJobDone`). The
  jobs component registers the job Done check at startup step 5 (`setJobDoneCheck`), because the host module must not
  import the job store. The service layer maps the errors to `conflict`.
- **What runs in the section.** `inOpenConversation` wraps the admission of input and the holding of a steering message
  (`src/host/steering.ts`, `src/host/conversation_control.ts`), abort, reset and compaction
  (`src/host/conversation_control.ts`), the clearing that an abort with awaited conversations makes (`abortWithAwaited`
  in `src/host/invocation.ts`), the creation of invoked conversations (`invoke` in the same file), a seat change
  (`src/service/seat_operations.ts`) and the seat writes of a handoff (`src/coordination/coordination_extension.ts`).
  The creation of a job's lead runs in `inJobSection` with the Done check (`src/service/job_operations.ts`), and so does
  the job abort's listing and marking (`closeJobConversations` in `src/host/invocation.ts`).
- **Job abort that closes.** `complete` and `cancel` write the job Done first (`finishJob` in
  `src/jobs/job_actions.ts`), then `abortJobConversations` lists the job's conversations and sets their marks in the
  section, releases it, and then aborts them. No abort mark is set, so no report is sent. A lead's complete tool isn't
  aborted: it returns `control: { terminate: true }`, and its run ends at that call. A compaction still running is
  aborted after the marks. Between the Done write and the marks a crash leaves a Done job with open conversations, which
  repair rule 4 closes at the next start. An abort or compaction stop that rejects is logged and stops no other, and
  isn't attempted again, so its conversation keeps running until the next start. A closed mark whose commit rejects
  doesn't end the work either: `abortAfterFailedClose` stops the compactions of the conversations whose mark landed and
  aborts every conversation (the lead's own one unawaited on its own tool path), logging each failure. Either way a team
  member's call still fails `internal`. The marks after a rejected commit aren't retried; rule 4 sets them (ADR-001
  decision 4). Passing the front desk's id to it throws `FrontDeskNotJobError`.
- **Job store.** The job record (jobs, counters, worklog, history, Related links) lives in `intern_` tables in the
  same file, kept by `src/jobs/job_store.ts` (S-004 REQ-001). The file has one connection: `openHarnessHost` opens it
  owner-only and gives the same handle to `SqliteStorage.open` and, through `hostDatabase(host)`, to the job store, so
  both wait in one transaction queue (`src/host/harness_host.ts`, `openOwnerOnlyDatabase`, `openStorageOnHostDatabase`
  and `narrowToHostDatabase`). The job store never reads pi-durable's tables, and the handle it gets can't close the
  file. Its schema version lives in the `intern_schema` table, not in the file's `user_version`.
- **Startup steps for jobs** (`src/daemon/daemon.ts`, `startUp`). Step 4 opens the host and, before pi-durable opens
  the file, reads the job schema version through `beforeStorageOpen: checkJobSchemaVersion`; a newer version stops
  startup and leaves the file unchanged. It then calls `migrateJobStore`, builds the job store and binds it to the
  service context. Step 7 restores admission, then runs each component's `repair` hook, then `host.resume()` resumes
  work. The jobs component's hook (`src/jobs/job_repair.ts`, `repairJobs`) applies the four repair rules of S-004
  REQ-018 to each job, writes each repair to the job's history, and then runs the turn-end check for In progress
  jobs. These rules are the only recovery the daemon applies to jobs (ADR-001 decision 4). The hook lists the
  conversations and reads their `intern.conversation` documents once, before the rules, and finds each job's lead and
  whether any of its conversations runs, parks or awaits in that index. A Done job with nothing active costs no
  conversation read, so startup does not slow down with every job the instance has run. Rule 1 also covers a start cut
  short: starting a lead is two pi-durable commits (the seated conversation, then the first input with request id
  `lead:<jobId>`), with the `"lead-created"` write point between them. For a To do job whose lead is known, rule 1
  reads whether that lead holds a submission with that request id (`hasSubmissionWithRequestId`), and owes the
  input when it doesn't. That read is made only for To do jobs with a known lead, so it adds nothing for a job in any
  other status. Rules 2 and 3 and the turn-end check read the lead of each Blocked or In progress job in their own way.
  Rule 4 applies to a Done job with a conversation that isn't closed, or that is closed but still runs, has a running
  compaction or has queued input: it closes the job's conversations and marks them for abort
  (`markJobConversationsForAbort`). Submitting input turns scheduling on (`Conversation.submit`), which the repair
  must leave off until `host.resume()`. So the hook submits nothing: it returns the first inputs rule 1 owes, the
  held messages rule 3 owes a lead (the job stays Blocked until they are delivered, so a crash before then applies
  the rule again) and the reminders the turn-end check owes, plus the conversations rules 1 and 4 marked. The
  component's `afterResume` submits them in that order, then waits for the marked conversations to end.
- **Job operations and tools.** The catalogue carries the `jobs.*` operations: `create`, `get`, `list`, `update`,
  `worklog.add`, `worklog.list`, `history.list`, `relate`, `unrelate`, `resume`, `complete`, `cancel` and `export`.
  `jobs.startLead` is no longer an operation: `jobs.create` starts the lead in-process
  (`src/service/job_operations.ts`). Every role carries the `intern.jobs` extension (`src/jobs/job_tools_extension.ts`),
  with the tools `read_job`, `update_job`, `add_worklog`, `create_job` and `relate_jobs` for every agent of the job, and
  `block_job` and `complete_job` for its lead only. A job's status changes only through the actions in
  `src/jobs/job_actions.ts`, and each job write is committed before the pi-durable change it goes with.
- **Job feed deltas.** The instance scope of the observation feed carries the jobs that aren't Done in its snapshot,
  then the deltas `job_created`, `job_changed`, `job_worklog_added`, `job_status_changed` and `job_done`, published
  after their job store commit (`src/feed/instance_feed.ts`).
- **Export and import.** `jobs.export` copies the whole database to a new owner-only file with SQLite's online backup
  on the daemon's connection, while work goes on (`src/host/database_copy.ts`, `backupDatabase`). `importDatabase` in
  `src/host/database_import.ts` places an exported file as the database of a stopped instance, under the single-owner
  lock; it converts nothing. `bob import` calls it (see Command line).
- **Front desk** (`src/desk/`, [S-001](../ai-team/specs/S-001-agent-roles-and-conversations.md) REQ-021 to REQ-025). The
  instance's one standing conversation, seated as the shipped `desk` role, with no job and no first input.
  `createDeskComponent` (`desk_component.ts`) returns a daemon component named `desk`. At startup step 6
  (`ensureWorkspaces`) it calls `ensureFrontDesk` (`front_desk.ts`), a keyed create under `FRONT_DESK_CREATION` in
  `desk_model.ts`: the key is written in the commit that creates the conversation, so a repeated start finds the
  conversation it already created (ADR-001 decision 4). `readFrontDeskId` reads it back. The component also holds the
  `desk.get` read operation, which answers the conversation id and its seat, read through `conversations.get` so the two
  never differ. `desk.get` is `not_found` when the instance has no front desk. The tools live in the opt-in extension
  `intern.desk` (`FRONT_DESK_EXTENSION_NAME`): `desk_tools_extension.ts` registers it, `desk_state_tools.ts` holds the
  read tools and `desk_steering_tools.ts` the tools that send to and stop a job's conversation. The component passes it
  as an `optInExtensions` entry, which the host installs but selects for no conversation. A conversation gets it from
  its seat: `extensionSelectionFor` in `src/host/seating.ts` adds `intern.desk` and removes `intern.coordination` and
  `intern.jobs` (`JOB_CONVERSATION_EXTENSION_NAMES`) when the origin is `front_desk`, as an `{ add, remove }` edit, so
  the other default extensions stay. Its tools that send to a job's conversation place an `intern.steer` entry with the
  front desk's agent as actor and the request id `steer:<frontDeskId>:<toolCallId>` (`desk_steering_tools.ts`; ADR-004
  decisions 2, 3 and 5). A team member's input to the front desk keeps the kind `conversations.submit` gives it, and no
  agent's input reaches it. The front desk is never a job: job operations given its id refuse it, and its job tools
  create jobs with origin `front_desk`.
- **Command line** (`src/cli/`, [S-005](../ai-team/specs/S-005-command-line.md)). `bob.ts` is the entry point: `main`
  parses the arguments with `parseCommandLine` (`command_line.ts`) against `COMMANDS` (`commands.ts`), prints help,
  usage errors and the notice for a reserved group, and otherwise runs the command and returns its exit code. The table
  lists `CommandSpec` entries (group, verb, positionals, options, `isData`, `callsService`, `run`), and the parser adds
  `--help` to each, `--json` to a data command and `--runtime-dir` to a command that calls the service. The groups are
  `jobs`, `conversations`, `roles`, `workspaces` and `models` (`jobs_commands.ts`, `conversations_commands.ts`,
  `roles_commands.ts`), and the top-level commands are `serve`, `status`, `usage`, `export`, `import`, `follow` and
  `chat` (`instance_commands.ts`, `follow_commands.ts`, `chat_command.ts`, `chat_terminal.ts`). Text output is built in
  `job_text.ts`, `conversation_text.ts` and `feed_text.ts`. Data an agent or a team member wrote goes through
  `terminal_text.ts` first (`flat`, `block` and `continued`), which removes control sequences and line breaks that would
  forge a line, and `writeLine` and `writeError` strip any that remain. `output.ts` writes data to standard output,
  errors to standard error and `--json` answers as one line. `chat_screen.ts` writes the front desk's answers on a
  terminal as they stream: a line of the answer that has ended goes above the prompt once, in one piece with no line
  feed inside it, so the terminal wraps it and a copy of it is one line. The line still arriving is a single
  transient row between them and the prompt, its last part that fits the width (`lastRow` in `text_rows.ts`), written
  again as it grows; it holds no line feed and never reaches the scrollback, so a very long line appears whole only
  when it ends. The line editor owns the prompt and the typed line, and the screen only asks it to draw them again
  (`prompt(true)`), so its history and cursor stay as they were. A data command ends with exit 0
  when the reader of its output closes it (`bob.ts`). Every command except `serve` and `import` is a thin client:
  `withClient` (`connection.ts`) resolves the socket from `--runtime-dir`, `BOB_RUNTIME_DIR` or the default runtime
  directory, calls the operations through the client library over `bob.sock`, and maps a refusal to exit 1 and an
  unreachable daemon to exit 3. The command table imports no daemon module except the path layout named below. `serve`
  and `import` load their code with a dynamic `import()` inside `run` (`serve.ts`; `host/database_import.ts` and
  `daemon/state_layout.ts`), so a command that only calls the service never loads the daemon. The one daemon file such
  a command loads is `daemon/state_layout.ts`, which `connection.ts` imports to resolve the runtime directory and which
  imports only Node modules. The following commands (`bob follow`,
  `bob jobs follow` and `bob chat`) read the feed through `followFeed` and `createEntryTracker` in `feed_follower.ts`:
  it subscribes, passes each snapshot and delta to the command, subscribes again when the feed ends `lagging` or the
  daemon is unreachable or `unavailable`, and pages `conversations.entries` forward from the cursor it kept, so a
  restart or a lag costs no entry. The command line keeps no file, cache or history of its own (S-005 REQ-016).
- **Failure.** A storage error closes the harness; the daemon exits non-zero rather than reopening the database
  (S-002, ADR-001). A failed job store write is one too: `createJobStore` reports it through `onWriteFailure`, and the
  daemon logs it and runs the same shutdown (S-004 REQ-020).

## Agents and conversations

This is how S-001's behaviour is built: where jobs start, how roles seat agents in conversations, and what reads them.
A requirement number with no spec named in this section is S-001's.

```
 job sources                        conversations (one database)                 roles (catalog)
┌──────────────────┐   new job   ┌────────────────────────────────────┐  seat   ┌──────────────────┐
│ request (CLI,    ├────────────►│ job A: lead conversation [bob]     │◄────────┤ bob  (default    │
│ web, email)      │             │   ├─ invokes #m      [role: gp]    │         │  lead), gp, desk,│
├──────────────────┤             │   │    └─ invokes …  [role: any]   │         │  team roles      │
│ schedule fire,   │──new job───►│   ├─ steerable or parked           │         │                  │
│ trigger          │             │   └─ handoff / reset: same conv,   │         │ each: instr.,    │
├──────────────────┤             │      next agent, context mode      │         │  tools, skills;  │
│ follow-up job    │──new job───►│ job B: lead conversation [gp]      │         │  default model,  │
│ (from an agent)  │             │ front desk [desk], no job          │         │  thinking,       │
│                  │             │ reports return as new input        │         │  workspace*      │
└──────────────────┘             └──────┬───────────────▲─────────────┘         └──────────────────┘
                                        │ role-attributed│ seat change, reset,   * team-set; a seat
                                        ▼ transcript     │ steer, invocation       may override them
                                 ┌──────────────┐  ┌─────┴───────────────┐      (registered workspaces)
                                 │ monitoring   │  │ agent coordination  │
                                 │ (list, jobs, │  │ (handoff, invoke,   │
                                 │ invocations, │  │  steer, report)     │
                                 │ live)        │  │ + caps, worker thr. │
                                 └──────────────┘  └─────────────────────┘
```

| Component | Responsibility | Notes |
|---|---|---|
| Role catalog | Holds the shipped roles (`bob`, `gp`, `desk`), the team's own roles, their instructions, tools, skills and defaults, and the registered workspaces, each checked when it is registered | Changed by team members through settings operations (REQ-003, REQ-018). Consumes the-intern's settings, its shipped tools and pi agent's default model and thinking level |
| Seating | Seats an agent of a role in a conversation, with optional model, thinking level and workspace overrides, so that later turns use that seat, and records who seated it | The only path that changes a conversation's seat. Consumes the role catalog and the pi-durable agent of each conversation |
| Role prompt | Builds what the model sees: the-intern's preamble, role instructions, role skills, workspace instructions (`AGENTS.md`/`CLAUDE.md`) and workspace skills | Stays byte-stable while the seat and the role are unchanged (AC-005.4) |
| Agent coordination | Agent-callable handoff, agent invocation and steer capabilities; parking and continuing invoking conversations; the report-back clean-up step; the depth cap and the worker threads | Every role is offered the same coordination capabilities in a job's conversations, and none in the front desk (REQ-022). Consumes seating, conversation reset, compaction and fork, conversation creation, the inbox of the target conversation, and each conversation's own `intern.conversation` document (below) |
| Entry routing | Starts a job's lead conversation for each job source with the role it names (`bob` when it names none) and records its origin; at startup, makes sure the front desk exists and records its conversation id (REQ-021); serves team members' requests to reset conversations | Holds no channel knowledge beyond choosing the role and recording the origin. Called by the Jobs component when a job is created, and by startup for the front desk |
| Front-desk tools | The tools offered only in the front desk: the job tools that name a job, the state reads and the steering of a job's conversations (REQ-022) | Calls the job operations (S-004) and the same paths as `conversations.submit` and `conversations.abort`, recording the jobs and the input it passes on as from the front desk (REQ-023) |
| Monitoring | Lists conversations with their job, lead flag, front-desk mark, seats, origins, status, invocation links and live transcripts | Read-only. Abort, reset and steer go through other components |

**The conversation's own document.** Each conversation's `intern.conversation` document holds the conversation's parked
state, the messages held for it while it is parked, the invoked conversations whose reports it awaits, its abort mark,
which records that its invoker is owed an "aborted" report (REQ-019), and its closed mark (REQ-026). They are facts
the-intern owns, written in the commit that changes them, and the only recovery from them is redelivery (ADR-001
decision 4). An abort's facts are written in one commit just before pi-durable's abort; when a job's abort closes the
conversation, the closed mark and the removal of its queued items are written in that same commit. The document is
internal to the daemon, not an external contract.

- **A role is configuration, not a process.** Seating an agent changes stored per-conversation configuration only.
  No process or connection is tied to a role or to an agent.

## Daemon internals

This is how S-002's behaviour is built: the components inside the daemon process and the rule that keeps its recovery
small.

```
 clients (S-003 listeners)        job sources                agents (tools)
 bob CLI (local socket) ·         schedules, triggers,        coordination tools (S-001)
 web interface (network)          email                             │
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
   supervisor (systemd / launchd, at machine startup)
```

| Component | Responsibility | Notes |
|---|---|---|
| Lifecycle | Startup sequence, single-owner lock, readiness, signals, shutdown, exit on a storage failure | Runs in the foreground; the supervisor handles daemonizing and restarts. Offers start and stop hooks so other components (listeners, scheduler) start after readiness and stop before the harness closes |
| Configuration | Produces one validated configuration from built-in defaults, the configuration file, command-line flags and the environment; refuses to start when it is invalid; persists settings changed through service operations | The file is read at startup and written only by settings operations |
| State layout | Resolves the instance's directories, creates them owner-only when they are missing, and refuses unsafe existing ones | Gives the paths of the database, the runtime directory (for S-003's socket), the data directory (for S-001's per-role default workspaces) and the configuration file |
| Model runtime | Resolves models and thinking levels through the pi agent login and model registry; validates model and thinking-level choices for the seat operations; maps pi agent settings into the harness explicitly; closes model connections on shutdown | Reads pi agent's folder only, apart from the login's own token refresh. The fake model replaces it in tests |
| Harness host | Opens the database, installs the-intern's extensions, applies settings, builds the execution environment for each tool call from the seat's workspace, then resumes | The only user of pi-durable outside the-intern's extensions; exposes the narrow host interface the service layer, admission and observation feed use |
| Admission | Counts worker threads, grants one to each ready agent run, holds the rest in arrival order, and keeps that order across restarts | Implements S-001 REQ-010. pi-durable has no concurrency cap of its own, so admission gates when runs start, including runs that resume after a restart. State kept in the daemon's admission document |
| Service layer | The catalogue of read and control operations, their validation and their error outcomes | Called by listeners, job sources and agent tools alike |
| Observation feed | Publishes snapshots and deltas for the instance and for each conversation, never a replay; drops a subscriber that falls too far behind | The source for the command line's and the web interface's live views and for monitoring |
| Status | Reports whether the daemon is starting, ready or stopping, its versions, start time, instance paths, and worker threads in use and waiting | A read operation and an instance-scope feed entry. The versions that last opened the database are kept in a daemon document, `intern.versions`, in that database, so a copy of the database carries them (S-002 REQ-020) |

- **Durability belongs to the runtime.** Recovery, exactly-once admission of input, queued input and checkpoints come
  from pi-durable. The daemon adds no retry loops, intake tables or recovery code of its own, except two bounded
  exceptions (ADR-001 decision 4). The first: the facts the-intern owns about a conversation (held messages, awaiting
  links, parked state, the abort mark, the closed mark and creation keys) live in its own documents, and the only
  recovery is redelivering the input those facts show as undelivered, made safe to repeat by pi-durable request ids.
  Each daemon-owned fact is committed in the same atomic commit as the change it describes, except for an abort. An
  abort's facts are written in one commit just before pi-durable's abort, not in pi-durable's abort commit. The
  second: job writes are committed before their pi-durable change, and four startup repair rules are the only job
  recovery (S-004 REQ-018).

## Rejected approaches

Implementation approaches weighed and rejected. ADR-001, Alternatives Considered, gives the full reasoning for the ones
it records.

- **One database per session or conversation** (durable-pi's layout). Rejected: S-001 fixes one database per
  instance, and the daemon keeps its own state as documents in that database, not in a second store.
- **Several processes sharing one database, or operating-system threads or worker processes per agent run.**
  Rejected: pi-durable allows one owner per storage. Worker threads stay a logical capacity unit
  (S-002 REQ-009).
- **A retry loop, intake table or recovery code of the daemon's own.** Rejected: durability belongs to pi-durable,
  with the two bounded exceptions under Daemon internals (ADR-001 decision 4).
- **pi-durable document families as the tables.** Atomic with conversation changes and watchable with no extra code,
  so no repair rules would be needed. Rejected by the product owner on 2026-11-02: the job record would be stored in
  pi-durable's format, which has no compatibility promise across versions, it can't be indexed or read with standard
  SQLite tools, and every filter scans a whole family.
- **The status in pi-durable documents and the other fields in tables.** Rejected: one job kept in two places.

## Components and owning specs

The components are those of S-000, Components, Solution. This table gives the responsibility in one line and the spec
that defines it.

| Component | Responsibility | Spec |
|---|---|---|
| Intern service | The one long-running process: saved state, many jobs at once, resume after a restart, models, the shared operations, the feed, the listeners | S-002 (process, service layer, feed); S-003 (listeners, client library) |
| Agents and roles | Roles, seats, the lead and handoff, invoking specialist agents, monitoring of who works on what, the front desk, closed conversations | S-001 (the front desk's tools and job operations also S-004) |
| Jobs | The job record and the life of a job, blocked jobs and answers, history, export and import | S-004 |
| Schedules and triggers | Starts jobs at set times and on events, with run history and on-demand runs | No spec yet |
| Email | The Intern's own mailbox as a way in and out | No spec yet |
| Web interface | The team's browser view and configuration, built only on service operations | No spec yet |
| Command line | The `bob` commands, built only on service operations | S-005 |
| Skills and instructions | Shipped skills and instructions, and the team's overlay | No spec yet |
| Team knowledge | Reaching, reading and updating the wiki and other knowledge sources | No spec yet |

Development infrastructure components (S-000, Components, Development infrastructure) are not part of the runtime and
are not described here.

## Module rule

- **Pure core.** Decision logic imports neither pi-durable nor I/O and is tested without a harness.
- **Jobs.** `src/jobs/job_model.ts` is the pure core of the job model (statuses, actions, letters, the turn-end
  decision) and imports nothing. `src/jobs/job_store.ts` imports no pi package: it uses only the host's `HostDatabase`
  type and never touches pi-durable's tables. Other files in `src/jobs/` reach pi-durable only through the host
  modules, except the `intern.jobs` extension, which is one of the-intern's own pi-durable extensions.
- **pi-durable only behind the host.** Only the harness host module and the-intern's own pi-durable extensions import
  pi-durable. The service layer and every other component depend on the host's interface, so an upgrade of the pi
  packages touches a few files.
- **Every job source ends in the same service operation.** Every way in and job source submits through the service layer.
- **The command table imports no daemon module besides the path layout.** A `bob` command reaches the daemon only
  through the client library, except `serve` and `import`, which load the daemon's code by a dynamic import inside
  `run` (S-005 REQ-016, ADR-005). The path layout, `src/daemon/state_layout.ts`, is the one daemon file every command
  loads (`connection.ts` uses it for the runtime directory); it imports only Node modules.
- **Listeners and the client library use only the service layer.** Listener and client library code imports neither
  the harness host nor any pi package. Listeners reach the daemon's state only through the catalogue, the feed and the
  lifecycle hooks, and import the daemon and feed modules only as types (S-003 REQ-013, ADR-001 decision 2). No service
  operation takes a request or connection as input (S-002 REQ-016, ADR-001 decision 2).

See [coding_guidelines.md](coding_guidelines.md), Module structure, for the full rules.
