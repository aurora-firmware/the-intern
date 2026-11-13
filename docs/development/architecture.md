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
        │                                job sources: schedules
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
  interface reach the daemon only through it (S-003 REQ-009). A subscription takes an `AbortSignal` (ADR-007 decision
  5).
- **Job origin.** The service layer builds a job's origin from the caller, never from the input: a team member's job
  records a request with the caller's way in, an agent's job a follow-up of its conversation, and only a job source
  states its own origin (S-002 REQ-012, AC-012.5). The scheduler and `schedules.run` are that job source; see Schedules.
- **Observation feed.** The one source of live data for clients: a snapshot, then deltas. A client that is slow or
  gone never affects an agent run (S-002). A conversation's snapshot and deltas carry its state and the entries each
  commit added, never its whole view, and clients read stored history through `conversations.entries`
  ([ADR-008](../ai-team/decisions/ADR-008-the-conversation-feed-sends-state-and-new-entries-never-the-whole-view.md)).
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
  jobs component registers the job status check at startup step 5 (`setJobStatusCheck`), because the host module
  must not import the job store. The service layer maps the errors to `conflict`.
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
  file. Its schema version lives in the `intern_schema` table, not in the file's `user_version`. The store also keeps
  skipped fires and answers the run history (see Schedules).
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
  with the tools `read_job` (which may name another job, read-only), `update_job`, `add_worklog`, `create_job`,
  `relate_jobs` and `read_schedule_runs` for every agent of the job, and `block_job` and `complete_job` for its lead
  only. A job's status changes only through the actions in
  `src/jobs/job_actions.ts`, and each job write is committed before the pi-durable change it goes with.
- **Job feed deltas.** The instance scope of the observation feed carries the jobs that aren't Done in its snapshot,
  then the deltas `job_created`, `job_changed`, `job_worklog_added`, `job_status_changed`, `job_related_changed` (with
  both short numbers, S-004 REQ-015), `job_done` and `schedule_fire_skipped` (S-007 Interfaces), published after their
  job store commit (`src/feed/instance_feed.ts`).
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
  `jobs`, `conversations`, `roles`, `workspaces`, `models`, `schedules`, `skills` and `instructions`
  (`jobs_commands.ts`, `conversations_commands.ts`, `roles_commands.ts`, `schedules_commands.ts`, `skills_commands.ts`,
  `instructions_commands.ts`), and the top-level commands are `serve`,
  `status`, `usage`, `export`, `import`, `follow` and
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
│ run on demand    │             │   └─ handoff / reset: same conv,   │         │ each: instr.,    │
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
| Role catalog | Holds the shipped roles (`bob`, `gp`, `desk`), the team's own roles, their tools, default skill names and defaults, and the registered workspaces, each checked when it is registered | Changed by team members through settings operations (REQ-003, REQ-018). A role's instructions are its instruction file in the internal folder, not a catalog value (S-008 REQ-007). Consumes the-intern's settings, its shipped tools and pi agent's default model and thinking level |
| Seating | Seats an agent of a role in a conversation, with optional model, thinking level and workspace overrides, so that later turns use that seat, and records who seated it | The only path that changes a conversation's seat. Each seat write also resets the agent's enabled set to the role's default skill names, in the same commit (S-008 REQ-006). Consumes the role catalog and the pi-durable agent of each conversation |
| Role prompt | Builds what the model sees before each model request: the common prompt, the role's instruction file, the lead's duty, the workspace's instructions (`AGENTS.md`/`CLAUDE.md`) and the listing of the agent's enabled skills | Reads every part again for each request and stays byte-stable while none of them changes (AC-005.4; S-008 REQ-007, REQ-015; ADR-009 decision 6). Built under Skills and instructions below |
| Agent coordination | Agent-callable handoff, agent invocation and steer capabilities; parking and continuing invoking conversations; the report-back clean-up step; the depth cap and the worker threads | Every role is offered the same coordination capabilities in a job's conversations, and none in the front desk (REQ-022). Consumes seating, conversation reset, compaction and fork, conversation creation, the inbox of the target conversation, and each conversation's own `intern.conversation` document (below) |
| Entry routing | Starts a job's lead conversation for each job source with the role it names (`bob` when it names none) and records its origin; at startup, makes sure the front desk exists and records its conversation id (REQ-021); serves team members' requests to reset conversations | Holds no channel knowledge beyond choosing the role and recording the origin. Called by the Jobs component when a job is created, and by startup for the front desk |
| Front-desk tools | The tools offered only in the front desk: the job tools that name a job, the state reads, the steering of a job's conversations and the schedule tools (REQ-022) | Calls the job operations (S-004), the `schedules.*` operations (S-007) and the same paths as `conversations.submit` and `conversations.abort`, recording the jobs and the input it passes on as from the front desk (REQ-023) |
| Monitoring | Lists conversations with their job, lead flag, front-desk mark, seats, origins, status, invocation links and live transcripts | Read-only. Abort, reset and steer go through other components |

**The conversation's own document.** Each conversation's `intern.conversation` document holds the conversation's parked
state, the messages held for it while it is parked, the invoked conversations whose reports it awaits, its abort mark,
which records that its invoker is owed an "aborted" report (REQ-019), its stop mark, which records that a team member's
abort stopped a job's lead (S-004 REQ-008), its closed mark (REQ-026) and its agent's enabled set (S-008 REQ-006). They
are facts
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
 bob CLI (local socket) ·         schedules,                  coordination tools (S-001)
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
  links, parked state, the abort mark, the stop mark, the closed mark, the enabled set and creation keys) live in its
  own documents, and the only recovery is redelivering the input those facts show as undelivered, made safe to repeat by
  pi-durable request ids. Each daemon-owned fact is committed in the same atomic commit as the change it describes,
  except for an abort. An abort's facts are written in one commit just before pi-durable's abort, not in pi-durable's
  abort commit. The second: job writes are committed before their pi-durable change, and four startup repair rules are
  the only job recovery (S-004 REQ-018).

## Web interface

This is how S-006's behaviour is built. A requirement number with no spec named in this section is S-006's. Technology
choices and their reasons are in
[ADR-006](../ai-team/decisions/ADR-006-web-pages-are-typescript-modules-with-no-build-step.md) and
[tech_stack.md](tech_stack.md), and the feed connections in
[ADR-007](../ai-team/decisions/ADR-007-one-shared-worker-holds-a-browser-s-feed-connections.md).

```
 browser profile
 ┌─ tab ────────────────────┐      ┌─ shared worker (feed_worker.ts) ─┐
 │ page (Preact, hash route)│◄────►│ instance feed: 1 stream          │──┐
 │ pure models, drafts      │ port │ conversations: 1 stream (union)  │──┤
 └───────────┬──────────────┘      │ daemon.status every 10 s         │──┤
 ┌─ tab ─────┼──────────────┐      └──────────────────────────────────┘  │ at most 2 streams
 │ page      │              │◄──── the same port protocol                │
 └───────────┤ calls        │                                            │
             │              └─ hidden iframe: GET /export                │
             ▼                                                           ▼
       network listener: /operations/<name>, /feed, /export, /ui/ (static_files.ts)
```

### Served files

`src/listeners/static_files.ts` serves `web/ui/` and the four table addresses of ADR-006 decision 4. It adds the content
types `.ts` and `.mjs` (`text/javascript; charset=utf-8`), `.woff2` (`font/woff2`), `.ico` (`image/x-icon`) and `.txt`
(`text/plain; charset=utf-8`). Each answer carries `cache-control: no-cache` and a content hash as `ETag`, and a
matching `If-None-Match` gets `304`. A `.ts` file's stripped text is kept in memory by path, modification time and size.
A file that can't be stripped answers `500 internal`; a unit test strips every shipped `.ts` file, so a release can't
hold one.

| Files | Where |
|---|---|
| Page shell and import map | `web/ui/index.html`, `web/ui/app.ts` |
| Pages and components | `web/ui/pages/`, `web/ui/components/` |
| Pure models | `web/ui/model/` |
| Feed worker, its logic, the tab's side | `web/ui/feed_worker.ts`, `web/ui/feed_hub.ts`, `web/ui/feed_connection.ts` |
| Tokens and component styles | `web/ui/style/` |
| Fonts, with `OFL.txt` | `web/ui/assets/fonts/` |
| Logo and favicon | `web/ui/assets/brand/` (Blanco as `logo.svg`, Secundario as `favicon.svg`) |
| Lucide's licence, next to the icon module | `web/ui/components/icons.ts`, `web/ui/components/ICONS_LICENSE.txt` |
| Brand manual and the other logo variants, for the style review (AC-016.1) | `docs/development/brand/` |

The fonts are the `woff2` files of `@fontsource/bruno-ace` 5.3.0 and `@fontsource-variable/josefin-sans` 5.3.0: the
`latin` and `latin-ext` subsets, with `unicode-range`, copied once and committed. They aren't npm dependencies, because
a font file changes only by a deliberate copy. `corporate_image/` holds no font files, only the manual's link to Google
Fonts, and The Round Table's `favicon.ico` is the Next.js default. Neither is copied. The page links `favicon.svg`,
which every target browser shows.

### Style

`web/ui/style/tokens.css` holds REQ-016's colours as custom properties, under The Round Table's names (`--color-orange`
and so on), and the two fonts. The measures follow The Round Table: `border-radius` 8 px on cards, 6 px on controls, a
1 px Medium Gray border and a small shadow on cards, a 2 px left border in Orange on the active sidebar link, and a 2 px
Orange focus ring with a 2 px offset.

Measured contrast limits what each colour may do under REQ-020's 4.5:1:

| Use | Colours | Contrast |
|---|---|---|
| Primary button | Dark Blue on Orange | 8.53 |
| Destructive button | Dark Blue on Red | 4.65 |
| Secondary text on cards and content | Text Gray on White, on Light Gray | 4.94, 4.54 |
| Status badge | Dark Blue on Success Green, Info Blue, Status Gray | 8.54, 5.29, 7.66 |
| Sidebar | White or Orange on Dark Blue | 19.46, 8.53 |

So Red, Orange, Success Green, Info Blue and Status Gray are never text colours on a light surface: they measure 4.18,
2.28, 2.28, 3.68 and 2.54 on White. White on Red measures 4.18, so a destructive button's text is Dark Blue, as text on
Orange is. An error shows as Dark Blue text on Orange Subtle, with a Red left border and an icon. A Blocked card has a
Red left border, its reason in Dark Blue text and a `Blocked` badge, so it stands out by more than its column (REQ-002).

### Pages and data

Each page reads through `createClient(browserTransport(location.origin))` and hears changes from the worker. A tab asks
the worker to follow, then reads with the operations S-006 Interfaces names, and applies the deltas that came in
meanwhile, so a read can't hide a change. The pages decide nothing about what's allowed (REQ-013): a refusal's `message`
shows next to the action, and the typed text stays.

- **Board.** `jobs.list` per status: every page of To do, In progress and Blocked, the first 50 of Done, and more of
  Done on request with the `cursor`. Job deltas move and change the cards. CSS `content-visibility: auto` keeps a column
  of hundreds cheap to draw.
- **Job page.** `jobs.get`, then history and worklog, then `conversations.invocations` from the lead for the tree of
  agents. Each conversation shows in its own collapsible section, under its role's name. A `conversation_created` delta
  leads to ADR-007 decision 3.
- **Status page.** It reads `daemon.status` and `usage.get` again after each instance delta, at most once a second, and
  `models.list` after a `settings_changed` delta.
- **Roles and Workspaces.** The list is read again after a `settings_changed` delta.
- **Connection banner and typed text.** Connection state comes from the worker (ADR-007 decision 6), and a tab's own
  call that fails as unreachable or `unavailable` shows the banner at once with no refusal message (REQ-014). Each text
  box keeps its text in `sessionStorage`, keyed by page and box, and clears it after the call succeeds.

### Reading entries

`conversations.entries` gains an optional input `order`, `"ascending"` by default as today (S-002 AC-012.4) or
`"descending"`. pi-durable's entry scan already reads in both orders, and its cursor keeps the order. Pages read only
newest first:

- **Opening.** A conversation's or the front desk's newest 200 entries. Reaching the top of the list loads the next page
  through `next`. This is what makes a long-lived front desk open as fast as a new one.
- **Catching up.** ADR-007 decision 4 reads newest first until it reaches an entry the tab already has.
- **The seat on a descending page.** The first page takes the current seat from the `intern.conversation` document and
  walks back through the page, each `intern.seat` record giving the seat before it through its `previous`. A later page
  first reads forward from its newest entry to the next seat record, and uses that record's `previous`, or the current
  seat when there's none. The read costs what the team member has already scrolled through, not the whole transcript.

An `intern.steer` record with no `content` marks a message held for a parked conversation. The page shows it as "held
until it continues", and only the delivered entry shows the words, so they appear once (ADR-004 decision 4; AC-006.4).

Long output collapses above 20 lines or 2 KiB, with its first lines showing. The full text is put in the DOM only when
it is expanded, as one text node, which is what keeps expanding a 1 MiB result within REQ-019's 500 milliseconds.
Entries use `content-visibility: auto` too.

### The export download

The Status page starts the download by pointing a hidden, same-origin `<iframe>` at `/export`, after the confirmation.
The browser's download manager writes the file straight to disk, so the page holds nothing of it. Chrome's memory rose
by 25 MiB for a 1 GiB download this way, against 1,034 MiB for `fetch` and a `Blob`. `showSaveFilePicker` and a service
worker aren't available over plain HTTP.

- **Before the first byte.** A refusal has no `Content-Disposition`, so the frame loads it as a document and fires
  `load`. The page reads the frame's text and shows the error's `message`, in place. A text that doesn't parse, such as
  the browser's own error page, shows a general error. Measured on Chrome, Firefox, with its JSON viewer on, and Edge.
- **Success.** No `load` fires, and the browser's download list takes over. The page says the copy is being made and the
  browser will show the download, and that only a finished download is a good backup. It never says the download
  succeeded, because it can't know (REQ-012).
- **After the first byte.** The route closes the connection short of its `Content-Length`, and the browser marks the
  download failed: `canceled` in Chrome and Edge and `NS_ERROR_NET_PARTIAL_TRANSFER` in Firefox, as measured.

### The export route

ADR-001 decision 2 fixes its order and its folder. This adds the following.

- **The margin** is `EXPORT_FREE_SPACE_MARGIN_BYTES`, 256 MiB, in `src/listeners/export_route.ts`. The route refuses
  when the free space is under the database's size, plus its `-wal` file's, plus the margin. The copy itself fits in the
  first two, because `jobs.export` copies all pages in one step. The margin keeps room for what running jobs write while
  the file downloads, because the live database shares that disk and a failed write ends the daemon (ADR-001 decision
  5). The figure is an estimate: 32 worker threads at about 50 KiB/s each is 1.6 MiB/s, so 256 MiB lasts about 160
  seconds at that peak, and a 1 GiB download takes about 10 seconds on a gigabit network.
- **The file name** is `the-intern-<instance>-<YYYY-MM-DD>.sqlite`, where `<instance>` is the last folder of the state
  directory from `daemon.status`, keeping only letters, digits, `.`, `-` and `_`, and the date is the daemon's UTC date.
- **The response** is `application/vnd.sqlite3`, with `Content-Disposition: attachment`, the size from `jobs.export` as
  `Content-Length`, and the body from a read stream that respects the connection's back-pressure.
- **A stalled client.** The route leaves the listener's idle timeout on, unlike a feed stream, so a client that stops
  reading frees the slot and the copy when the timeout ends the connection.
- **Test switch.** `NetworkListenerOptions` takes a test-only `readFreeSpace` for AC-016.8, as it takes `freePort`.

### Stop mark

ADR-001 decision 4 states the rule. It's built at these points.

- **The field.** `ConversationMeta.stopped?: string` in `src/host/seating.ts` holds the entry ID.
- **Setting it.** `abortWithAwaited` in `src/host/invocation.ts` has two callers, `conversations.abort` and the front
  desk's `stop_conversation`, and both name what a team member's abort names. In the section, for the root only and
  before clearing, it decides whether a mark is due: the conversation is a lead, its job is In progress, and it's busy,
  has input queued (`hasQueuedUserInput`), is parked or awaits a report. `clearWaiting` writes the mark, the ID
  from `readNewestEntryId`, in the commit it already makes. A cascade and `closeJobConversations` never set it.
- **The job's status.** The host can't read the job store, so `setJobStatusCheck` in `src/host/job_section.ts` answers
  the job's status, with `refuseIfJobDone` built on it. The jobs component registers it
  at startup step 5, as today.
- **Whether a mark is live.** `isStopMarkLive(host, conversationId, meta)` in `src/host/conversation_control.ts` is
  `hasInputSince` on the mark's entry, the read repair rule 3 makes, with the same input entry kinds.
- **The decision.** `turnEndDecision` in `src/jobs/job_model.ts` takes `isStopped`, tested first, and blocks with the
  reason "stopped by a team member" whatever the definition of done holds. `evaluateTurnEnd` in
  `src/jobs/turn_end_rule.ts` passes it after `isLeadWaiting`, so input that reached the lead first leaves it something
  to wait for. The block is the daemon's `blockJob`, with its usual job write and then park.
- **When the rule runs.** A lead's run ending works as today. For a run of another conversation of the job ending,
  `check` in `startTurnEndRule` reads the job's lead, and goes on only when that lead's mark is live, so nothing changes
  for a job with no mark. For an abort that set a mark, `abortWithAwaited` calls a listener registered with
  `onLeadStopped(host, listener)` in `src/host/invocation.ts`, in the manner of `onInputSubmitted`, once its last abort
  has ended. The jobs component passes that to the rule's one serial queue. All three pass the `turn-ended` write point,
  so the crash tests of S-004 AC-008.6 use it.
- **At startup.** `evaluateTurnEnd` runs in the turn-end check as today and reads the mark itself, so there's no new
  rule and no new read for a job that isn't In progress with an idle lead.

### Browser tests

`test/web/` runs real pages against a real daemon child (`test/support/daemon_process.ts`) on the fake model, with a
hermetic instance and `[network]` on a free port. Decision logic in `web/ui/model/` and `web/ui/feed_hub.ts` is tested
in `test/unit/`. `test/support/browser.ts` launches a browser. It opens pages at `http://intern.test:<port>/ui/`, the
name mapped to the daemon's loopback address, so the pages run outside a secure context as on a team's network. ADR-007
decision 10 covers the proxy for what a worker does. Tool choices are in [tech_stack.md](tech_stack.md).

Chrome and Firefox are the required browsers; Edge is good to have (S-006 REQ-021).

| Runs in | Tests |
|---|---|
| Chrome | Every browser test |
| Firefox as well | 21 tests, in nine groups: the page shell (`shell.test.ts`, 5), the connection banner (`connection_banner.test.ts`, 5), moving between pages (`navigation.test.ts`, 2), the shared worker (`feed_worker.test.ts`, 2), long activity (`activity_scale.test.ts`, 2), timeliness and a full board (`board_scale.test.ts`, 2), the journey (`browsers.test.ts`, 1), many agents (`many_agents.test.ts`, 1) and the host probe (`browser_support.test.ts`, 1). They carry AC-021.1, AC-005.4 and AC-001.2, which depend on the shared worker (ADR-007). Firefox doesn't reach the connection limit with 6 streams, so there AC-005.4 checks the shared worker and not the limit, which only Chrome and Edge test. Long activity and the full board carry AC-018.1 and AC-019.1 to AC-019.3 |
| Edge as well, where it is installed | The same tests as Firefox. Edge is good to have, not required: its tests are skipped where it isn't installed |

## Schedules

This is how S-007's behaviour is built. A requirement number with no spec named in this section is S-007's. The library
question is answered in [tech_stack.md](tech_stack.md). The durable parts are already decided: `intern_` tables in
ADR-001 decision 1, a fire as a job source in ADR-001 decision 4, and the first input in ADR-004 decision 5. Everything
else here can change inside its module, so this feature adds no ADR.

```
 bob schedules · Schedules page · front desk tools
        │ schedules.create, change, remove
        ▼
 config store ──► config.toml [[schedule]]
        │ current entries
        ▼
 scheduler (clock, a tick each minute)      schedules.run
        │ fire                                   │ run on demand
        └──────────► startScheduledRun ◄─────────┘
                       │ seat and folder checks
                       ▼
                     createJob ──► job store, one transaction: key, open run, number, job ──► lead start
                       │ refused
          ┌────────────┴─────────────┐
          ▼                          ▼
 fire: skip row, feed delta    run on demand: the refusal
```

### Modules

| Part | Where | Holds |
|---|---|---|
| Pure model | `src/schedules/schedule_model.ts` | The entry's type, the rules of REQ-001 that need no other component, the fire's key |
| Pure time | `src/schedules/schedule_time.ts` | Reading a cron expression, the next due time, the local time text |
| Configuration | `src/schedules/schedule_section.ts` | The `schedule` section |
| Scheduler | `src/schedules/scheduler.ts` | The tick and the clock. It imports no pi package |
| Component | `src/schedules/schedules_component.ts` | The daemon hooks, the holds on roles and workspaces, the test clock |
| Operations | `src/service/schedule_operations.ts` | `schedules.*` and `startScheduledRun` |
| Saved history | `src/jobs/schedule_history.ts`, called by `job_store.ts` | The skip rows and the run history queries |
| Front desk tools | `src/desk/desk_schedule_tools.ts` | The schedule tools, including the front desk's `read_schedule_runs` |
| Commands | `src/cli/schedules_commands.ts`, `src/cli/schedule_text.ts` | S-005's conventions, on the client library |
| Page | `web/ui/pages/schedules.ts`, `web/ui/model/schedules.ts` | The page and its pure model |

`serve.ts` places the component after `desk` and before the listeners, and adds the section to `sections`. The component
needs the agents component, for the catalog, and the jobs component's options, for `createJob`. The tools reach the
operations by name through the catalogue, so the jobs and desk components don't import the schedules component.

### Due times

A due time is a whole minute. `nextDueTime(cron, after)` walks calendar dates forward, starting one day before the local
date of `after`. On each date the month and day fields match, it tries each matching hour and minute in order, builds
`new Date(y, m, d, h, min)` and reads the local fields back:

- A local time that doesn't exist reads back differently, because JavaScript moves it forward. It's passed over, so it
  doesn't fire (REQ-005).
- A repeated local time gives the earlier of its two instants, by the language's rule. So it's due once, and the second
  pass of the hour holds no due time, whichever minutes the expression names.

This also holds for a change of 30 minutes (Lord Howe) and one at midnight (Havana). The walk reads no clock: the caller
passes `after`. Its bound is 8 years, the longest gap between two 29 Februaries.

The reading rules are REQ-005's and no more:

- Fields are separated by one or more spaces, and there are exactly five.
- A field is a comma-separated list. Each item is `*`, a number or a range, and `*` or a range may carry a `/step`. So
  `5/15` is refused, and `5-59/15` says what it means. A range runs upward.
- Names, `?`, `L`, `W`, `#` and shortcuts such as `@daily` are refused.
- Day of week 7 reads as 0.
- A day field counts as restricted when its values don't cover its whole range. So `*/2` is restricted, and `*/1` and
  `0-7` aren't. When both day fields are restricted, a match on either is due.
- An expression whose month and day of month can never meet, with day of week unrestricted, such as `0 0 31 2 *`, has
  no due time. It's refused as not valid.

Fire times, due times and next due times are text in the machine's local time with its offset:
`2026-11-08T02:00:00.000+01:00`. A team member reads 02:00 for `0 2 * * *` wherever the browser is, and `Date` parses
the text to the right instant. History orders by that instant. The zone is the daemon process's own.

### The scheduler

The scheduler wakes at each whole minute of the clock, and holds one value, `checkedUntil`, which starts at the moment
it starts. A tick at time `T` does this:

1. If the daemon's phase isn't `ready`, it sets `checkedUntil` to `T` and fires nothing.
2. It takes `from`, the later of `T` minus one minute and the earlier of `checkedUntil` and `T`.
3. For each entry in `config.current`, it starts a fire for each due time after `from` and up to `T`.
4. It sets `checkedUntil` to `T`.

| Case | What the rule gives |
|---|---|
| Stopped or starting at a due time | The window opens at the start, so nothing earlier fires and nothing is recorded (REQ-007) |
| Clock jumps from 01:59 to 02:30 | `from` is 02:29, so 02:00 has no job and no skip (AC-007.2) |
| Clock goes back | Due times pass again. The fire's key returns the existing job, and the skip's key writes nothing (REQ-016) |
| An entry changed or added at 02:00:20 | `checkedUntil` has passed 02:00, so the new values only reach later due times (REQ-003) |
| Run on demand | The scheduler holds nothing about it, so the next due time doesn't move (REQ-008) |
| No keeping up after a stall | A tick later than one minute gives up the older due times (REQ-007, REQ-015) |

Every entry is read at each tick, so a write through the operations applies at once. The tick doesn't wait for its
fires, so a slow one holds back neither the next tick nor another entry. `stop` ends the wait and waits for the fires in
flight, and the component stops before the host closes.

### One path for fires and runs on demand

`startScheduledRun(ctx, jobs, entry, { fireTime, onDemand, idempotencyKey })` makes the three checks of REQ-006 and
REQ-008 in one place:

1. `catalog.seatFor(role ?? bob, overrides)` resolves the seat, and refuses a model that has gone, as `invalid_input`.
2. It checks that a folder exists at the seat's workspace, and refuses as `invalid_input` naming the folder. Only a
   missing folder counts; the ownership checks of registering a workspace don't run here.
3. `createJob` runs, with the caller `{ kind: "job_source", source: "schedule" }`, the entry's request as `text` and the
   entry's values as the role and overrides.

Its callers differ only in what they do with a refusal. A fire records `busy`, `invalid_input`, `not_found` or
`conflict` as a skipped fire with the message. `unavailable` and `internal` aren't refusals of the job, so the fire logs
them and records nothing, and that due time is missed. `schedules.run` passes every refusal to its caller and records
nothing. A refusal after the job is written is `createJob`'s existing cancel, which gives a cancelled scheduled run
(S-004 REQ-007).

So the reason a fire names follows that order: when the folder is gone and a run is open, the reason names the folder.

**The fire's identity.** The fire's `idempotencyKey` is `schedule:<entry>:<due time>`, in the `schedule.fire`
key space, so the job and its key are one commit (REQ-016). A crash before that commit leaves the due time missed. A crash
after it leaves the existing pairing of a job and its lead start, which repair rule 1 finishes (S-004 REQ-018; ADR-001
decision 4).

**The open run check.** `NewJob` gains `schedule: { entry, firedAt }`, which `createJob` takes from the origin.
`insertIn` works in this order inside its one transaction:

1. It looks up the key, so a repeat returns its original job, even an open one (REQ-008).
2. When `schedule` is given, it reads for a job of that entry with status `to_do` or `in_progress`. If it finds one, it
   throws a refusal carrying the short number, before a number is allocated.
3. It allocates the number and writes the job.

The file has one connection and one transaction queue, so two starts of one entry can't both pass (REQ-006). The refusal
counts as a refusal in `transact`, not a storage failure. `createJob` maps it to a `busy` `ServiceError` subclass that
carries the short number, so the fire can write it to the skip. Re-adding a removed name counts earlier runs, because
the check reads jobs and not entries (REQ-003).

**`schedules.run`.** It reads for its key first, so a repeat returns the original job even if the entry has since gone
or its folder is missing. It then answers `not_found` for an unknown entry, and calls `startScheduledRun`. Its key is
stored in the `schedules.run` key space, separate from `jobs.create` and `schedule.fire` (Saved data, job schema
version 4). The key is optional, as on `jobs.create` and `roles.create`. The limit of 200 characters applies to the
caller's key, before the prefix: `schedules.run` checks it, and `checkBeforeWrite` keeps the check for every caller
other than a job source, which only in-process code can be. A team member or the front desk can call it; any other
actor is refused `invalid_input`.

### The origin

```
{ kind: "schedule"; entry; fireTime; onDemand?: { wayIn; observed?; frontDesk? } }
```

`schedules.run` builds `onDemand` from its caller, as `describeCaller` does for a request: a team member's way in and
observed details, or the front desk's way in and its conversation id, with no address (REQ-008, REQ-013). The input
can't state it, because `parseOrigin` is reached only by a job source, so a team member's `jobs.create` naming any
origin stays refused (S-002 AC-012.5).

- `checkBeforeWrite` refuses overrides only for a follow-up, as S-001 AC-012.3 now reads.
- `leadOrigin` drops `onDemand`, as it drops a request's observed details, so the conversation's origin stays entry and
  fire time.
- The job source is the seat actor in both cases (S-001 AC-012.2), and the job's origin records who asked.
- `leadStart` stores the overrides when the job is written, so a later change of the entry leaves a running job and its
  repair as they were (REQ-003).

### Saved data

Job schema version 3 adds, as one migration in `JOB_MIGRATIONS`:

- `intern_jobs.schedule_entry` and `intern_jobs.schedule_fired_at` (the local-offset text the run shows), with an
  index on the two. No backfill: no job source has ever written an `S` job.
- `intern_schedule_skips (entry, due_at, due_time, reason, open_run)`, with the primary key `(entry, due_at)`. `due_at`
  is UTC and `due_time` is the local text. `open_run` is a short number or null.

The table sits in the job store's file, so skips survive a restart and travel with `bob export` and `bob import`, and an
imported older file migrates at its next start (S-004 REQ-017). `recordSkip` inserts and ignores a row that exists, and
reports a new `JobChange` only when it wrote one.

Job schema version 4 adds `intern_job_keys (scope, key, job)`, with the primary key `(scope, key)`. Every idempotency
key of a job is stored there in the space of the operation that wrote it: `jobs.create`, `schedules.run` or
`schedule.fire`. A caller of one operation can't name a key that returns another operation's job, whatever text it
sends. The migration copies each existing `intern_jobs.idempotency_key` into its space by the job's stored origin, not
by the key's text: a schedule origin with `onDemand` goes to `schedules.run`, any other schedule origin to
`schedule.fire`, and every other job to `jobs.create`. New jobs leave `intern_jobs.idempotency_key` empty.

Job schema version 5 adds the index `intern_jobs_by_schedule_instant` on `schedule_entry` and the fire time as epoch
milliseconds (`unixepoch(schedule_fired_at, 'subsec')`). Fire times are local-offset text and skip due times are UTC
text, so neither text order nor a mix of the two is instant order. Ordering and the history cursor use the instant, and
the migration indexes the rows already stored without rewriting them.

### Reading schedules

- **`schedules.runs`** reads the newest `limit + 1` of the entry's jobs and of its skips, each from its index, and
  merges them by instant, a run before a skip at the same instant. The cursor holds the instant in epoch milliseconds,
  the kind and the rowid, encoded as the job list's cursor is. The limit rules are the job list's. It answers
  `not_found` when the entry isn't in the configuration and the first page is empty, so a removed entry with history
  works.
- **`jobs.list`** gains the `schedule` condition on `schedule_entry`.
- **`schedules.list` and `schedules.get`** read the entries from the configuration store and take the next due time from
  `nextDueTime(cron, clock.now())`, so the test clock applies. `schedules.list` reads each entry's newest job.

### Entries in the file

`[[schedule]]` is a top-level array, so `ConfigSection.serialize` widens to return an array as well as a table. `parse`
already takes `unknown`, `renderToml` already leaves out a value equal to the default `[]`, and `smol-toml` writes the
array back as `[[schedule]]` sections. Nothing else in the writer changes, so the atomic owner-only write and the
fingerprint conflict come as they are (S-002 REQ-022).

The checks fall into two places, because `parse` can't see the catalog:

- **`parse`** applies what needs no other component: the keys, the name, a unique name, the cron expression, a non-empty
  request, an absolute workspace path and a known thinking level. pi-ai's main entry doesn't export its list of levels,
  so `schedule_model.ts` holds one, and a unit test checks that every level the registered models report is in it, which
  catches a pi upgrade that adds one. A failure at startup stops step 1, and `ConfigError` names the file and
  `schedule.<name>.<key>`, or the entry's position when it has no name (REQ-002).
- **The component's `ensureWorkspaces` hook** checks that each entry's role exists and its workspace is registered. It
  runs at step 6, after the agents component, because an entry may name a per-role default workspace and those are
  ensured there. A failure throws the same `ConfigError`, and nothing has fired by then. Model availability isn't
  checked at startup (REQ-002).

**Writes.** `ConfigStore` gains `update(section, (current) => next)`, which runs the function inside the store's serial
queue. Today's callers compute `next` before they queue it, so two creates at once would lose one. The operations use
`update` to check and write as one step:

- `schedules.create` refuses a taken name `conflict`. It then checks the entry with `catalog.seatFor`, the same call a
  fire makes, which refuses an unknown role, an unregistered workspace, a model that isn't available and an unsupported
  thinking level. Each of these is `invalid_input`, naming the entry and the key (AC-001.1), including the catalog's
  `not_found` for a role. `ConfigChangeRefused` maps as `role_operations.ts` maps it.
- `schedules.change` does the same on the entry merged with the change. A value absent from the input is left alone, and
  `null` clears an optional value. So a change to an entry whose model has gone is refused until the model is changed or
  cleared, as `roles.change` checks a whole role.
- `schedules.remove` filters the entry out.

`schedules.create` with a key follows `roles.create`: `settingsResultOnce`, with a body that returns an identical
existing entry, so a repeat after a crash between the file write and the key's record doesn't answer `conflict`.

**Holds.** The component registers `catalog.addReferenceSource` at step 5. Its `referrersOf(role)` names each entry
whose `role` is that role, and each entry whose `workspace` is that role's per-role default workspace (S-001 REQ-018),
listed by `workspaces.list()` with `kind: "role_default"`, because removing the role would unregister the path and the
next start would stop. A role whose default workspace is one a team member set isn't held by that. `WorkspaceRegistry`
gains the same `addReferenceSource`, and `unregister` refuses with each entry named (REQ-003).

`roles.change` isn't held: S-001 REQ-003 lets a team member change any role's default workspace. Setting a workspace on
a role whose per-role default an entry names stops that path being registered at the next start, and startup then stops
with an error naming the file, the entry and the reason (REQ-002).

### What the lead is told

`leadStartFor` adds `scheduledRunNotice(entry)` to the first input for a job with a schedule origin, between the Request
text and `LEAD_DUTY`. The notice sits beside `LEAD_DUTY` in `src/prompt/role_prompt.ts`, and names the entry and the
`read_schedule_runs` tool. The first input stays plain `pi.user` (ADR-004 decision 5), and `job.request.text` holds the
entry's request exactly. Because the text comes from the job's origin and is never stored, repair rule 1 rebuilds the
same text, and the request id `lead:<jobId>` still deduplicates it. A job of any other letter gets no notice (AC-010.2).
The system prompt doesn't change, so S-001 AC-005.4 holds.

### Tools

`read_schedule_runs` joins `JOB_TOOL_NAMES`, so every agent of a job has it, and `FRONT_DESK_TOOL_NAMES`, with the five
tools below. It calls `schedules.runs` through the catalogue, so an unknown name is an error result and the run goes on
(REQ-010). `read_job` gains an optional `job` for S-004 REQ-013, which it lacks today.

pi-durable never runs one of these tools again after a crash. A call cut short settles as an error result, "Tool X was
interrupted and may have partially run", because only a tool declared `replay: "safe"` reruns, and
`docs/research/pi-durable-knowledge.md` keeps that for read-only tools. The model can then call again with a new call
id, so the key doesn't match it, and the operation's own rules make it act once. A same-id repeat is the case S-004's
`create_job` covers, and the tools key it the same way, as `<tool>:<conversationId>:<callId>`.

| Tool | Acts through | Same call id again | A new call after an interrupted one |
|---|---|---|---|
| `list_schedules` | `schedules.list` | Only reads | Only reads |
| `create_schedule` | `schedules.create` with the key | The recorded result, or the identical entry | The identical entry, if the first call wrote the same values; otherwise `conflict` naming the entry |
| `change_schedule` | `settingsResultOnce` around `schedules.change` | The recorded result | Writes the same values, which leaves the same end state |
| `remove_schedule` | `settingsResultOnce` around `schedules.remove` | The recorded result | `not_found`, if the first call removed it |
| `run_schedule` | `schedules.run` with the key | The original job: the job and its key are one commit | `busy` naming the run, while it's open |

The tools that act take the front desk's caller, with `latestWayIn` as `create_job` does, and are refused while no team
member has written. A refusal is an error result and the run goes on.

### Feed, commands and page

`JobChange` gains `schedule_fire_skipped`, and `instance_feed.ts` publishes it after the commit, as it does the job
deltas. Entry changes arrive as `settings_changed` with the section `schedule`, from the existing config listener. The
page reads `schedules.list` again after that delta and after a job delta for an `S` number, and adds a skip from its
delta. A read can straddle a skip delta, so the page keeps the skips it learned of while a read ran and puts them back
into that read's result with `addSkips` (B-035). `job_record.ts` shows the origin's entry, fire time and `onDemand`.

### Removing triggers

The trigger origin and the letter `T` leave these places. The letter lists don't show in a search for "trigger":

- `Letter`, `LETTERS`, `JobOrigin` and `letterFor` in `src/jobs/job_model.ts`
- `LETTERS` in `src/service/job_record_operations.ts`, and the letter union in `src/desk/desk_tools_extension.ts`
- `SourceOrigin`, `ORIGIN_FIELDS` and `sourceOrigin` in `src/service/job_operations.ts`
- `Origin` in `src/host/seating.ts`
- the reserved groups in `src/cli/command_line.ts`; `schedules` leaves that list later, in the change that adds
  `bob schedules` (`docs/development/coding_guidelines.md`, Command line)
- `src/roles/shipped/bob.md` and `web/ui/components/job_record.ts`

`sourceOrigin` then refuses anything but a schedule origin, so a trigger origin is `invalid_input` and uses no number
(AC-014.2). A short number such as `T-1` then reads as an ID and names no job.

### Tests

`SchedulesComponentOptions.clock` is a test-only `{ now(); wait(until, signal) }`, passed as `afterWrite` is, and
`daemon_child.ts` takes a switch for it, so a child process can run under the test clock. The real clock is `Date.now`
and `setTimeout`. `schedule_time.test.ts` sets `process.env.TZ`, which Node applies at once, to reach each clock change.

Restarting within the same minute doesn't reach the key, because the new window opens after the due time. So AC-016.1
also restarts with the test clock set back before the due time, which is the case the key is for.

## Skills and instructions

This is how S-008's behaviour is built. A requirement number with no spec named in this section is S-008's. The
durable parts are decided in ADR-009 (the internal folder, its manifest, the version token and the reads before each
model request) and ADR-001 decision 4 (the enabled set and its upgrade write). Library questions are answered in
[tech_stack.md](tech_stack.md), Skills and instructions. Everything else here can change inside its module.

```
 package src/shipped/ ──step 3: seed, upgrade (manifest)──► <data dir>/instructions, skills, shipped-files.json
                                                                   │ read before each model request
 config.toml [skills] paths, [roles.*] skills ──► skill catalog ◄──┤ (internal, search paths, workspace .pi/skills)
                                                       │           │
 intern.conversation: seat, enabledSkills ─────────────┼──► role prompt sections ──► model
                                                       └──► skill tool ◄── agent
 skills.*, instructions.*, files.*, roles.* ──► file store (one serial queue, tokens) ──► files_changed
 skills.enable/disable (conversation) ──► one commit: enabledSkills + intern.skills entry ──► skills_changed
```

### Modules

| Part | Where | Holds |
|---|---|---|
| Shipped text | `src/shipped/` | `instructions/common.md`, `instructions/roles/{bob,gp,desk}.md` and `skills/{carry-out-a-part,about-the-intern,bob-command-line}/`, laid out as the internal folder is (ADR-009 decision 1). It replaces `src/roles/shipped/`; `preamble.md` becomes `common.md` |
| Shipped roles | `src/roles/shipped_roles.ts` | The shipped role names, their tools and their default skill names (REQ-001's table). It no longer reads any text |
| Internal folder | `src/skills/internal_folder.ts` | The paths (`instructions/common.md`, `roleInstructionPath(dataDir, role)`, `skills/`), the manifest, ADR-009's start rule and the restores |
| File store | `src/skills/file_store.ts` | The one serial queue for every write to an instruction or skill file, the version token, the atomic write, the allowed files of REQ-010 and the `files_changed` events |
| Discovery | `src/skills/skill_discovery.ts` | Walks one source and reads each `SKILL.md` |
| Resolution | `src/skills/skill_resolution.ts` | Pure: priority between sources, the order inside a source, shadowed copies, an agent's enabled skills and the missing names |
| Configuration | `src/skills/skills_section.ts`, `src/roles/roles_section.ts` | `[skills] paths`, and roles whose `skills` are names, with the older forms kept for the migration |
| Migration | `src/skills/config_migration.ts` | REQ-011's conversion at step 3 |
| Prompt | `src/prompt/role_prompt.ts`, `src/prompt/prompt_sources.ts`, `src/prompt/role_prompt_extension.ts` | The pure rendering and the skill listing; the reads before each request, which replace `workspace_context.ts` and its cache; the sections |
| `skill` tool | `src/skills/skill_tool_extension.ts` | The pi-durable extension `intern.skill-tool` |
| Enabled set | `src/host/seating.ts`, `src/host/skill_set.ts` | The seat write that resets it; the enable and disable commit with its `intern.skills` entry; the upgrade write |
| Component | `src/skills/skills_component.ts` | The daemon hooks, the extensions, the operations |
| Operations | `src/service/skill_operations.ts`, `src/service/instruction_operations.ts`, `src/service/file_operations.ts`, `src/service/role_operations.ts` | `skills.*`, `instructions.*`, `files.*`, and the role operations' file writes |
| Commands | `src/cli/skills_commands.ts`, `src/cli/instructions_commands.ts`, `src/cli/skill_text.ts` | S-005's conventions, on the client library |
| Pages | `web/ui/components/skills_panel.ts`, `web/ui/components/file_editor.ts`, `web/ui/model/skills.ts`, `web/ui/pages/roles.ts` | The panel, the editor, their pure model, and the Roles page's Skills and instructions section |

The agents component holds the skills component, so every daemon that composes the agents component has it, and
`serve.ts` and the test fixtures don't change. `createAgentsComponent({ logger, skills? })` takes a skills component,
or creates one with `createSkillsComponent({ logger })` when none is given; a test that needs a test-only switch, such as
`shippedRoot`, passes its own. The agents component's `sections`, `operations` and `extensions` begin with the skills
component's, and each of its daemon hooks first runs the skills component's hook of the same name (`prepareFiles`,
`checkModels`, `ensureWorkspaces`, `repair`, `afterResume`, `start`); `stop` runs the skills component's last. So step
3's `prepareFiles` runs as before, and the step 7 upgrade write runs before the jobs component's repair rules, because
the agents component comes before the jobs component in every composition. The skills component also stays a
`DaemonComponent` of its own, which a test may run without the agents component. Its operations reach the role catalog
and the workspace registry through the agents component's `runtime()`, which `createAgentsComponent` hands it with
`connectAgents`, read lazily, as the coordination extension does. The role catalog takes the internal folder's paths and
the file store from the skills component. The module rule holds: only `src/host/` and the-intern's extensions import pi-durable, and
`skill_resolution.ts`, `role_prompt.ts` and the internal folder's start rule decide without a harness.

### Startup

- **Step 1.** `rolesSection.parse` accepts a team role with no `instructions` key. It keeps the two older forms, an
  `instructions` string and absolute paths in `skills`, apart from the names, and checks them as before (a non-empty
  text, an absolute path). `skillsSection.parse` takes `paths`: a list of absolute paths, none listed twice.
  `ConfigSection` gains an optional `check(value): Promise<void>`, which `loadConfig` runs after `parse`, and the
  skills section uses it to check each path with the workspace check, `checkWorkspaceFolder` in
  `src/workspaces/workspace_folder.ts` (S-001 REQ-018). A failure is a `ConfigError` naming `skills.paths` and the path.
- **Step 3.** `DaemonComponent` gains `prepareFiles?({ dirs, config, logger })`, which `startUp` runs for each
  component right after `acquireOwnership`, as part of step 3. It may return a new `LoadedConfig`, and step 4 builds the
  `ConfigStore` from that. The skills component's hook runs ADR-009 decision 3, writes the `bob` launcher (Agents reach
  `bob`), then the migration:
  1. It checks first and writes nothing until every check passes. Each older skill path must be a source that is
     itself a valid skill (it holds a `SKILL.md` that discovery reads with a description), must pass the search path
     check, and must not give a name that another migrated path, in another folder, also gives. A failure stops
     startup naming the role and the path, and says that the folder must be accessible only to the service account
     when that is the reason.
  2. It writes each role's `instructions` text to the role's instruction file through the file store. A shipped role's
     file then differs from the manifest's hash, so it counts as edited.
  3. It renders the file without the older keys, with each path replaced by the skill's name and each skill folder
     added to `[skills] paths` after the existing ones, and writes it once with the configuration writer's atomic
     `replaceFile`, refusing when the file's fingerprint has moved since step 1. It returns the configuration read
     back from the new text. A crash between steps 2 and 3 leaves the older keys in the file, so the next start writes
     the same instruction text again and then rewrites the file.
- **Step 7.** The skills component's `repair` hook makes ADR-001's upgrade write before the jobs component's repair
  rules run. The flag sits in the daemon document `intern.upgrades`, `{ done: string[] }`, with the entry
  `enabled-skills`.

### The skill catalog

`readCatalog({ searchPaths, workspace })` reads every source before each use: a prompt, a `skill` call, `skills.list`,
`skills.enable` and the allowed files of REQ-010. Nothing is cached between reads.

- **Sources**, in rising priority: `<data dir>/skills`, each search path in its order, then `<workspace>/.pi/skills`. A
  role's catalog uses the role's default workspace: its `workspace`, or its per-role default (S-001 REQ-003).
- **Discovery.** A source folder that holds `SKILL.md` is one skill. Otherwise the walk reads its subfolders at any
  depth, with `readdir` from `node:fs/promises` so the event loop isn't held, in byte order of the names. A folder that
  holds `SKILL.md` is a skill, and the walk doesn't go into it: its other files are its bundled files. A file is never a
  skill on its own. Symbolic links to folders are followed, and a set of real paths per source stops a cycle. A missing
  source holds nothing; a missing search path also gives a diagnostic.
- **Reading a skill.** `parseFrontmatter` from `@earendil-works/pi-coding-agent` reads the frontmatter, as pi agent's
  loader does. The name is the frontmatter's `name`, or the folder's name when it has none. A file that can't be read
  or parsed, or has no non-empty `description`, is left out with the reason. A name that breaks the Agent Skills name
  rule is kept with a diagnostic, as pi agent keeps it. Every other field is ignored, `disable-model-invocation`
  included (REQ-008).
- **Resolution.** Inside a source, the copy whose folder path sorts first by bytes (`Buffer.compare`) is used and the
  others are shadowed, with the diagnostic "shadowed inside its source". Between sources, the higher source's copy is
  used. Each catalog skill carries its name, description, folder, `SKILL.md` path and source (`internal`, `path` with
  the search path, or `workspace`), and for the internal source its shipped and edited marks from the manifest.
- **An agent's enabled skills** are the names of its `enabledSkills` that the catalog uses, plus every skill the
  workspace source supplies. A name of the set the catalog doesn't hold is missing. The prompt, the `skill` tool and
  `skills.list` call the same function, so they never differ.
- **Diagnostics** from a prompt read are logged once per path and reason, and again only after the problem has gone
  and come back, so a broken skill doesn't fill the log at every request.

### The enabled set

`ConversationMeta.enabledSkills: string[]` is the fact ADR-001 decision 4 names. The stored seat keeps role, model,
thinking level, workspace and tools. `resolveSeat` returns the role's default skill names, and `writeSeat` writes them
to `enabledSkills` and stores the seat without them, so the four seat paths (creation, `conversations.seat`, a handoff
and a reset with a seat) reset the set in their own commit. A seat no longer holds instruction text: older documents
still carry `seat.instructions` and `seat.skills`, and no reader uses them.

`setEnabledSkill(host, conversationId, { name, enable, actor })` in `src/host/skill_set.ts` runs in
`inOpenConversation`, so a closed conversation is refused `conflict` with `ConversationClosedError`. In one commit it
reads the document, changes the set and appends the `intern.skills` entry, data `{ actor, skill, change: "enabled" |
"disabled", enabledSkills }`, with `defineEntry` as the seat record is. Enabling a name already in the set, or disabling
one that isn't, changes nothing, commits nothing and returns the set. The operation checks first, against the agent's
catalog: an unknown conversation or a name the catalog doesn't hold is `not_found`, except that disabling a name in the
set that the catalog no longer holds is allowed; a name the workspace source supplies is `invalid_input` for a disable.
An agent's `bob` call arrives over the local socket like any other, so its actor is a team member with the way in
`command line` (ADR-002).

`skills.enable` and `skills.disable` with a `role` change the role's `skills` through `ConfigStore.update`, so the check
and the write are one step. A shipped role with no `skills` key gets the full list written: its current defaults with
the change. The name is checked against the role catalog.

### The system prompt

The role prompt extension keeps one rendering per request preparation (`renderedByRequest`). For each, it reads the
conversation's document, then in parallel the common prompt, the seat's role file, the workspace's context files
(`loadProjectContextFiles` with the empty agent folder, as today) and the catalog, and renders these sections, in this
order, each as a pure function of what was read:

| Section | Text | When it is left out |
|---|---|---|
| `intern-common` | `common.md` | The file is missing or empty, with a diagnostic |
| `intern-role` | The seat's role's instruction file | The file is missing or empty, with a diagnostic |
| `intern-lead-duty` | `LEAD_DUTY` | The conversation isn't a job's lead |
| `intern-workspace-context` | "Your workspace is …" and each context file | Never |
| `intern-skills` | The listing of the enabled skills | The agent has none |

`renderSkillListing` in `role_prompt.ts` writes the listing, not pi agent's `formatSkillsForPrompt`, because REQ-008
asks the listing to name `skill`. It keeps the Agent Skills `<available_skills>` shape, one `<skill>` per enabled skill
with `<name>`, `<description>` and `<location>` (the `SKILL.md` path, which an agent with `bash` needs to run a bundled
script), sorted by name in byte order and escaped as pi agent escapes it. Fixed text before it says to load a skill with
the `skill` tool and its `name` when the task matches the description, and a file the skill names with `file`, relative
to the skill's folder. A conversation without a document gets `intern-common` only. Equal files and an equal set give
equal bytes, and a change touches only its section (REQ-015).

### Roles and their instruction files

- `RoleDefinition` loses `instructions`. `roles.list` reads each role's file through the file store and returns its
  text and version token; a team role whose file is missing comes with no text and the missing mark.
- `catalog.seatFor` refuses a team role whose file is missing or holds only white space, as `RoleRefusedError` of kind
  `invalid` naming the file's path, before any write. Every way of seating calls it (`conversations.seat`, a handoff,
  an invocation, `jobs.create`, a fire and `schedules.run`), so each refusal of REQ-007 comes from there. The read is
  synchronous, as `seatFor` is, and the file is at most 1 MiB. A shipped role's missing file doesn't refuse.
- `roles.create` writes the instruction file, replacing one left without a table, then the table. A crash between the
  two leaves a file with no table, which isn't a role.
- `roles.change` with instructions needs the token (`instructionsVersion`), and refuses `invalid_input` without it. It
  checks the role change first, then checks the token and writes the file in the file store's queue, then writes the
  table.
- `roles.restore` removes the table's changes, then restores the shipped file (ADR-009 decision 4).
- `roles.remove` lists the open conversations whose seat has the role, refuses `conflict` naming them, then removes the
  table, then deletes the file. A crash between the last two leaves a file with no table.
- Each file a role operation writes or deletes publishes `files_changed`.

### Files through the service

`files.read` and `files.write` resolve the path first. They take the real path of the nearest existing folder on the
path and add the rest, so a missing file and a symbolic link both resolve before the check. The allowed files are:

- a file below the real path of any skill folder the catalog found, used, shadowed or left out, in the internal folder,
  a search path or the `.pi/skills` of a workspace `workspaces.list()` returns, per-role defaults included;
- a file below the real path of `<data dir>/instructions`;
- the real paths of `AGENTS.md` and `CLAUDE.md` directly inside such a workspace.

They then refuse in this order: a path outside them `invalid_input`, a missing file `not_found`, a folder, a file over
1 MiB or text that isn't UTF-8 (`TextDecoder` with `fatal: true`) `invalid_input`. `files.write` also refuses text over
1 MiB. The kind that `files_changed` and `instructions.list` give is `common`, `role` (under `instructions/roles/`),
`instructions` (any other file of that folder), `workspace` or `skill`.

### The `skill` tool

The extension `intern.skill-tool` registers `skill`, input `{ name: string, file?: string }`, marked `replay: "safe"`
because it only reads. `placeTools` adds `skill` to every seat's tools, in a job's conversation and in the front desk,
so it is offered whatever the role's tools are, and ADR-001's upgrade write adds it to older conversations.

A call reads the conversation's document through the tool's `DocumentReader` and the catalog, and resolves the agent's
enabled skills as the prompt does. It returns an error result, and the run goes on, for a name that isn't enabled, a
`file` that is absolute or whose real path leaves the real path of the skill's folder, and a file that is missing or is
a folder. Without `file` it returns `SKILL.md`, frontmatter included. The text is cut with pi agent's `truncateHead` at
`DEFAULT_MAX_LINES` and `DEFAULT_MAX_BYTES`, the limits of its `read` tool, with a closing line saying so.

### Agents reach `bob`

`shippedToolsExtension` becomes a factory that builds `bash` with pi-durable's `createBashTool({ prepare })`. `prepare`
sets `BOB_RUNTIME_DIR` to the instance's runtime directory and `BOB_CONVERSATION_ID` to the call's conversation id, and
puts `<runtime dir>/bin` first on `PATH`. At step 3 the skills component writes `<runtime dir>/bin/bob`, owner-only
(`0700`), a shell script that runs `process.execPath` on this package's `src/cli/bob.ts` with the arguments. So an
agent's `bob` is the daemon's own version and reaches its own instance (REQ-014), and `bob-command-line` tells the agent
to use `$BOB_CONVERSATION_ID`.

### Feed, commands and pages

- **Instance feed.** `factsOf` adds `enabledSkills`, and the snapshot's conversations carry it. `applyMeta` publishes
  `skills_changed { conversationId, enabledSkills }` right after `seat_changed` whenever it publishes that, and on its
  own whenever the set differs. `files_changed { path, kind }` comes from a change hub the daemon creates and puts in
  the `ServiceContext` as `fileChanges`; the file store publishes to it after each write, and `createInstanceFeed`
  listens as it listens to the configuration. `[skills]` and role changes arrive as `settings_changed` from the
  existing configuration listener.
- **Reads.** `ConversationListing` gains `enabledSkills`, so `conversations.get` and `conversations.list` return it.
  `toHostEntry` shows an `intern.skills` entry by its data, as it shows a seat record, in `conversations.entries` and
  the conversation feed.
- **`skills.list`** returns `{ skills, missing, leftOut, seat? }`. Each skill has `name`, `description`, `source`
  (`{ kind, path? }`), `path` (its folder), `enabled`, `shipped`, `edited` and `shadowed` (each `{ path, source }`). A
  shipped skill whose folder is deleted is listed with `edited: true` and `deleted: true`. `leftOut` holds `{ path,
  reason }`. `instructions.list` returns `{ files }`, each `{ kind, path, shipped, edited, missing }`, in REQ-007's
  order, the workspace's parent folders included.
- **Commands.** `skills` and `instructions` leave `RESERVED_GROUPS` in `command_line.ts`. A shadowed copy prints on an
  indented line under the copy in use; marks print as words. No command prints file text.
- **Pages.** The Skills panel reads `skills.list` and again after a `skills_changed` delta for its conversation, a
  `settings_changed` delta, or a `files_changed` delta. The editor reads with `files.read`, keeps the token, and on a
  `conflict` keeps the typed text and offers the disk text from a new `files.read`, whose token it then keeps. The Job
  page renders an `intern.skills` entry in the activity as it renders a seat record. The Schedules page opens the panel
  for the entry's role, or `bob`.

### The manual and the `about-the-intern` skill

The skill folder holds a `SKILL.md` written by hand, which says what each page covers and how to load it with `skill`
and `file`, and a `manual/` folder of byte copies of the manual pages it draws from, under their names in
`docs/manual/`. `test/unit/about_the_intern_skill.test.ts`, which `npm run check` runs through `test:unit`, fails naming
the page when a copy differs from `docs/manual/<page>`, when a copied page no longer exists, or when `SKILL.md` doesn't
name a copied page. Updating the skill is copying the page. A new manual page, `docs/manual/skills_and_instructions.md`,
covers REQ-017's topics and says that `shipped-files.json` is the daemon's own record.

### Tests

The tests are the files S-008's acceptance criteria name. The upgrade tests (AC-003.1, AC-003.2) run a daemon on a
package root whose `src/shipped/` a test changes: `SkillsComponentOptions.shippedRoot` is a test-only switch, passed as
the schedules component's clock is. The crash test of AC-006.4 kills the daemon child before and after the handoff's
one commit, as S-001's seat crash tests do. `npm run test:live:skills` runs `test/live/live_skills.ts`, as
`test:live:desk` runs its file.

## Rejected approaches

Implementation approaches weighed and rejected. ADR-001, Alternatives Considered, gives the full reasoning for the ones
it records.

- **pi agent's skill loader for the catalog, or its `formatSkillsForPrompt` for the listing.** See
  [tech_stack.md](tech_stack.md), Skills and instructions.
- **A skill cache cleared by file watches, or a per-seat cache as before S-008.** See ADR-009, Alternative D.
- **The `read` tool for the front desk, or skill text inlined in the prompt.** S-008, Alternatives Considered.
- **The enabled set inside the seat.** S-008 REQ-006 makes it no part of the seat, and a change records no seat change;
  it sits beside the seat in the same document, so a seat write still resets it in the same commit.
- **A scheduling library, or one timer per entry.** See [tech_stack.md](tech_stack.md), Schedules. One tick reads the
  entries as they are, so a change needs no timers rebuilt, and a clock jump needs no special case.
- **Skipped fires as pi-durable documents or a file.** S-004 chose tables for saved job data (ADR-001, Alternative G),
  and skips must travel with the database and be read in order with jobs.
- **The open run check in the scheduler, before `createJob`.** Two starts could both pass it. REQ-006 asks for one step,
  and only the store's transaction gives it.
- **A notice stored in the job, or a new input kind for it.** Storing it risks the Request's exactness, and ADR-004
  decision 5 keeps a first input `pi.user`.
- **Noticing a machine's sleep by comparing the wall clock with a monotonic one.** It would also drop a due time that
  passed while awake in the same minute, against REQ-015.
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
- **Next.js, or a compile step for the pages.** Rejected: see ADR-006, Alternatives Considered.
- **A feed stream in each browser tab, or a whole view in each delta.** Rejected: see ADR-007 and ADR-008, Alternatives
  Considered.

## Components and owning specs

The components are those of S-000, Components, Solution. This table gives the responsibility in one line and the spec
that defines it.

| Component | Responsibility | Spec |
|---|---|---|
| Intern service | The one long-running process: saved state, many jobs at once, resume after a restart, models, the shared operations, the feed, the listeners | S-002 (process, service layer, feed); S-003 (listeners, client library) |
| Agents and roles | Roles, seats, the lead and handoff, invoking specialist agents, monitoring of who works on what, the front desk, closed conversations | S-001 (the front desk's tools and job operations also S-004) |
| Jobs | The job record and the life of a job, blocked jobs and answers, history, export and import | S-004 |
| Schedules | Starts jobs at set times, with run history and on-demand runs | S-007 |
| Email | The Intern's own mailbox as a way in and out | No spec yet |
| Web interface | The team's browser view and configuration, built only on service operations | S-006 for jobs, conversations, roles, workspaces, status and the export download; later specs add their own pages |
| Command line | The `bob` commands, built only on service operations | S-005 |
| Skills and instructions | The common prompt, the roles' instruction files and the shipped skills in the internal folder, the skill catalog and its search paths, each agent's enabled set, and the `skill` tool | S-008 |
| Team knowledge | Reaching, reading and updating the wiki and other knowledge sources | No spec yet |

Development infrastructure components (S-000, Components, Development infrastructure) are not part of the runtime and
are not described here.

## Module rule

- **Pure core.** Decision logic imports neither pi-durable nor I/O and is tested without a harness.
- **Jobs.** `src/jobs/job_model.ts` is the pure core of the job model (statuses, actions, letters, the turn-end
  decision) and imports nothing. `src/jobs/job_store.ts` imports no pi package: it uses only the host's `HostDatabase`
  type and never touches pi-durable's tables. Other files in `src/jobs/` reach pi-durable only through the host
  modules, except the `intern.jobs` extension, which is one of the-intern's own pi-durable extensions.
- **Schedules.** `src/schedules/schedule_model.ts` and `schedule_time.ts` import nothing with I/O or a clock, so
  REQ-005's rules are tested without a daemon. `scheduler.ts` imports no pi package.
- **pi-durable only behind the host.** Only the harness host module and the-intern's own pi-durable extensions import
  pi-durable. The service layer and every other component depend on the host's interface, so an upgrade of the pi
  packages touches a few files.
- **Skills and instructions.** `src/skills/skill_resolution.ts` and `src/prompt/role_prompt.ts` import nothing with
  I/O. Only `src/host/skill_set.ts` and `src/host/seating.ts` write the enabled set, and only the skills component's
  file store writes an instruction or skill file (ADR-009 decision 5).
- **Every job source ends in the same service operation.** Every way in and job source submits through the service layer.
- **The command table imports no daemon module besides the path layout.** A `bob` command reaches the daemon only
  through the client library, except `serve` and `import`, which load the daemon's code by a dynamic import inside
  `run` (S-005 REQ-016, ADR-005). The path layout, `src/daemon/state_layout.ts`, is the one daemon file every command
  loads (`connection.ts` uses it for the runtime directory); it imports only Node modules.
- **Web pages stay in the browser's own world.** Modules in `web/ui/` import only each other, `preact`, `preact/hooks`
  and the two browser-safe client modules, by relative path in a worker (ADR-006). They use no secure-context API
  (ADR-007 decision 8). Decision logic such as the board's columns, the catch-up of entries and the worker's feed loop
  sits in pure modules with no DOM, which `test/unit` runs on Node.
- **Listeners and the client library use only the service layer.** Listener and client library code imports neither
  the harness host nor any pi package. Listeners reach the daemon's state only through the catalogue, the feed and the
  lifecycle hooks, and import the daemon and feed modules only as types (S-003 REQ-013, ADR-001 decision 2). No service
  operation takes a request or connection as input (S-002 REQ-016, ADR-001 decision 2).

See [coding_guidelines.md](coding_guidelines.md), Module structure, for the full rules.
