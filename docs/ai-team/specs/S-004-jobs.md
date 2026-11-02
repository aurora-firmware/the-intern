---
id: S-004
title: Jobs
version: '0.4'
status: approved  # draft | review | approved | superseded
created: '2026-11-02'
author: planner
---

# Jobs

## Purpose

This spec covers S-000's **Jobs** component: the job record and the life of a job. S-001 starts and coordinates the
conversations that work on a job, but nothing yet records what a job is, what it must deliver, whether it is blocked
and why, or how it ended, so no job source can create a job and no way in can show one. This spec fixes the job
record in the-intern's own tables in the instance's one SQLite file, the four statuses and the five actions that move
them, the worklog agents keep for each other, the history of every change, the job operations and the job tools every
role carries, and the export and import of the whole database. When it is done, a team member creates a job from any
way in, its lead agent writes the definition of done or blocks the job with a reason, an answer resumes it, and it
ends Done with a resolution and justification that triggers and team members can see (Success Criteria).

## Definitions

This spec uses the Definitions of S-001, S-002 and S-003 (job, lead conversation, lead agent, specialist agent, job
source, origin, way in, caller, service operation, observation feed) and the shared vocabulary of
`docs/system_overview.html`. It adds these terms:

| Term | Meaning in this spec |
|---|---|
| Job record | Every job with its fields, worklog, history and Related links, kept in the job store. |
| Job store | The-intern's own tables in the instance's SQLite file that hold the job record (REQ-001). |
| Job ID | The internal unique identifier of a job. Opaque; never shown as the job's name. |
| Short number | The name people use for a job: its origin letter, a hyphen and a counter per letter, such as `E-14` (REQ-002). |
| Origin letter | One letter naming where a job came from: `C` command line, `W` web interface, `E` email, `S` schedule, `T` trigger, `A` agent. |
| Request | The text a job was created with, exactly as received, and everything known about where it came from (REQ-003). |
| Definition of done | A clear deliverable, action or end state that decides whether the job is done. Goal, needs, plan and analysis belong in the description. |
| Blocked reason | What the job lacks to go on: missing information, a decision, or access the service account doesn't have. Set when the job blocks, cleared when it resumes. |
| Resolution | How a Done job ended: `completed` or `cancelled`, with a short justification. |
| Action | One of the five named moves of a job's status: start, block, resume, complete, cancel (REQ-005). |
| Worklog | The notes agents and team members write on a job: what was tried, what was done, what is left. It lets another agent take over without the conversation history (REQ-010). |
| History | The automatic, append-only record of every change to a job's fields, status and resolution, and of every repair (REQ-011, REQ-018). |
| Related | An undirected link between two jobs (REQ-009). |
| Follow-up job | A job an agent creates while it works on another job; its origin letter is `A`. |
| Repair rule | One of the four startup checks that bring a job and its lead conversation back in step after a crash (REQ-018). |

## Users and Journeys

| Actor | Goal |
|---|---|
| Team member | Hands The Intern a job from the command line, the web interface or email, follows it, answers it when it is blocked, edits it or cancels it. |
| Lead agent | Writes the definition of done, keeps the description and the worklog, blocks the job when it lacks something and completes it. |
| Specialist agent | Reads the job it works on, adds to its worklog and creates new jobs it finds. |
| Job sources and Email (downstream systems) | Schedules and triggers create jobs in-process with their own origin details; Email, a way in, passes a team member's request with the message ID and sender it observes. |
| Later specs (downstream systems) | The Command line and Web interface specs present jobs; the Schedules and triggers spec listens for jobs ending; all call this spec's operations and follow its feed events. |
| Developer | Tests the job lifecycle on the fake model, including crashes between a job write and its pi-durable change. |

Journeys, in priority order:

1. **Hand over a job.** A team member creates a job; it gets a short number, its lead conversation starts, the lead
   writes the definition of done and the description, works, logs its steps and completes it with a justification.
   Delivered by REQ-001 to REQ-008, REQ-010, REQ-012, REQ-013.
2. **Answer a blocked job.** The lead can't write a definition of done, or can't go on, and blocks the job with a
   reason; its lead conversation parks without a worker thread; a team member answers from any way in and the job
   resumes. Delivered by REQ-005, REQ-006, REQ-007, REQ-008.
3. **Find and follow jobs.** A team member names a job by its short number, lists jobs by status or origin letter,
   reads its worklog and history, and follows changes live. Delivered by REQ-002, REQ-010, REQ-011, REQ-014, REQ-015.
4. **Stop a job.** A team member cancels a job with a reason; every conversation of the job stops. Delivered by
   REQ-005, REQ-007.
5. **Work found along the way.** An agent creates a new job that is Related to the job it came from. Delivered by
   REQ-003, REQ-009, REQ-013.
6. **Keep and move the record.** A team member exports the whole database while The Intern works, and imports it on
   another computer or keeps it as a backup. Delivered by REQ-016, REQ-017.
7. **Nothing is lost in a crash.** A crash between a job write and its pi-durable change is repaired at the next
   start. Delivered by REQ-018.

## Exclusions

What this specification explicitly does NOT cover:

- **Priorities, due dates, estimates and time tracking.** Admission is first in, first out (S-002 REQ-010), and no
  field orders or schedules jobs.
- **Assigning jobs to people, watchers, votes, labels and attachments.** All team members are equal (ADR-002), and the
  lead conversation is the only owner a job has.
- **Reopening a Done job.** Done is final; more work becomes a new job, Related to the old one.
- **Sub-tasks and dependencies between jobs.** Related is the only link. Invoked agents take the place of sub-tasks
  (S-001 REQ-008).
- **A team member blocking a job.** Only the lead agent blocks, so Blocked is never used as a pause.
- **Per-field or per-person permissions.** Anyone who reaches a way in can change any editable field (ADR-002).
- **Syncing with outside ticket trackers** (S-000).
- **Deleting jobs, and retention of old jobs.** The first version keeps every job; retention is an open item of S-000.
- **Converting a database between incompatible versions.** Import restores a copy into a version that can read it.
  Converting pi-durable's stored format is not part of this spec.
- **How jobs are presented.** The `bob` commands, the web board and the import command's name belong to the Command
  line and Web interface specs.
- **Reading mail, sending notices about blocked jobs, and when schedules and triggers fire.** The Email and Schedules
  and triggers specs own them. This spec records the origin details they pass and publishes the events they listen to.
- **How agents work, hand off and invoke one another.** S-001 owns it.

## Architecture

### Design Principles

- **One job record, one writer.** Only the daemon reads and writes the job store, and every way in and every role
  uses the same job operations (ADR-001 decision 1; REQ-012, REQ-013).
- **The job record outlives pi-durable's format.** The job store has its own schema version and migrations and never
  depends on how pi-durable stores conversations (REQ-001, REQ-017).
- **Status moves only through actions.** Status and resolution are never written as fields. Each action's guard and
  side effect live in one place, so a rule changes in one table and no field serves as a workaround (REQ-005).
- **Everything else stays flexible.** Any team member and any agent of the job can change the editable fields
  (REQ-004).
- **Blocked means no agent is working.** A blocked job holds no worker thread, and a job never sits in progress with
  no agent working on it (REQ-006, REQ-008; S-001 REQ-014).
- **Writes are ordered, and repair is bounded.** A job write is committed before the pi-durable change it goes with;
  the only recovery is the four repair rules at startup (REQ-018; ADR-001 amendment).
- **Origins are observed, not claimed.** Origin details come from the listener or the in-process job source; a
  client's self-stated name is kept apart and labelled as not checked (REQ-003; S-002 AC-012.5, S-003 AC-007.2).

### Alternatives Considered

- **pi-durable document families as the tables.** Atomic with conversation changes and watchable with no extra code,
  so no repair rules would be needed. Rejected by the product owner on 2026-11-02: the job record would be stored in
  pi-durable's format, which has no compatibility promise across versions, it can't be indexed or read with standard
  SQLite tools, and every filter scans a whole family.
- **Status as an ordinary field, checked on every write.** One generic update, with a validation table and observers
  firing the side effects. Rejected: side effects hide behind field writes, a refused write is the only feedback, and
  a field becomes the workaround for a rule.
- **The lead keeping the job as a file in its workspace, synced into the database.** Rejected: two sources of truth,
  conflicts when a team member edits the job meanwhile, and no guard at the moment of change.
- **The status in pi-durable documents and the other fields in tables.** Rejected: one job kept in two places.
- **Separate goal, needs, plan and evidence fields.** Rejected by the product owner: the definition of done is the
  only field that controls completion; goal, needs, plan and analysis go in the description, and the evidence is the
  resolution's justification with the job's worklog and conversations.
- **A statuses-per-step model** (defining, working, verifying) and a stored step field. Rejected: the steps are
  conditions on fields (a job can't complete without a definition of done), not statuses.
- **Questions and answers as their own records.** Rejected: the Blocked reason states what is missing, and the
  worklog keeps the exchange.
- **One global counter (`J-1`, `J-2`).** Rejected: the letter tells a team member where a job came from without
  opening it, and each letter has its own counter.
- **Returning to To do when a blocked job is answered.** Rejected: a job leaves To do once and goes back and forth
  between In progress and Blocked until it is Done.
- **Holding a stalled job in progress, or a separate stalled status.** Rejected: the lead is reminded once and then
  the job blocks, so Blocked keeps meaning that no agent works on it (REQ-008).

## Interfaces

### Exposed: the job fields

**Contract** (fields of a job, as job operations return them; times are ISO 8601 in UTC):

| Field | Set by | Editable | Meaning |
|---|---|---|---|
| `id` | the job store, at creation | no | Job ID, opaque and unique |
| `number` | the job store, at creation | no | Short number, such as `E-14` (REQ-002) |
| `createdAt`, `updatedAt`, `doneAt` | the job store | no | Creation, last change, and the time it became Done (absent until then) |
| `request` | the job store, at creation | no | `text` and `origin` (REQ-003) |
| `title` | the creator or anyone later | yes | Short name; may be empty until the lead writes one |
| `description` | anyone | yes | Goal, needs, plan and analysis |
| `definitionOfDone` | anyone | yes | What decides that the job is done; may be empty until the lead writes one |
| `leadConversation` | read from the conversation that records the job as its lead (S-001 REQ-012) | no | The job's lead conversation (S-001 REQ-012); the lead agent is the one seated in it |
| `status` | actions only | no | `to_do`, `in_progress`, `blocked` or `done` (REQ-005) |
| `blockedReason` | the block action | no | Present only while `status` is `blocked` |
| `resolution` | the complete and cancel actions | no | `{ "kind": "completed" \| "cancelled", "justification": <text> }`, present only when `status` is `done` |
| `related` | relate and unrelate | through those operations | The short numbers of the Related jobs |

The job also holds an internal `blockedAfterEntry`: the ID of the lead conversation's newest transcript entry when the
job blocked, or null (REQ-006, REQ-018). The block sets it and the resume clears it, each in the same write as the
status change. It is not part of the job fields that `jobs.get` returns, and the history doesn't record it.

Worklog and history entries are returned by `jobs.get` and paged by `jobs.worklog.list` and `jobs.history.list`.

**Contract** (worklog entry): `at`, `author`, `text`. **History entry:** `at`, `author`, `field` (a field name,
`status`, `resolution`, or `repair` for a repair of REQ-018), `old`, `new`. A `repair` entry has `old` null and `new`
naming the rule and what it did, as `{ "rule": <1 to 4>, "did": <text> }`.

**Contract** (author of a worklog or history entry): an agent, with its conversation and seated role; a team member,
with the way in and the observed details of REQ-003; or the daemon, for automatic changes (start, a resume on input to
the lead, the reminder rule, a cancel after a refused start, and repair).

### Exposed: job operations

Added to S-002's catalogue, so S-003's listeners carry them. Errors are S-002's codes. Every operation that names a
job accepts its job ID or its short number in any letter case (REQ-002).

| Operation | Kind | Input | Result | Requirement |
|---|---|---|---|---|
| `jobs.create` | control | `text` (required), `title`, `statedBy`, `idempotencyKey` (S-002 REQ-013), the role, model, thinking level and registered workspace a team member may name (S-001 REQ-012), and `origin`: job sources only (a schedule's entry and fire time, a trigger and its event); refused from any other caller (S-002 AC-012.5) | the new job | REQ-003, REQ-007 |
| `jobs.get` | read | job | the job with its worklog and history, newest last | REQ-014 |
| `jobs.list` | read | optional `status`, `letter`, `relatedTo`, `limit`, `cursor` | jobs without worklog and history, newest first, and a cursor | REQ-014 |
| `jobs.update` | control | job and any of `title`, `description`, `definitionOfDone` | the job | REQ-004 |
| `jobs.worklog.add` | control | job, `text` | the entry | REQ-010 |
| `jobs.worklog.list`, `jobs.history.list` | read | job, `limit`, `cursor` | entries, oldest first, and a cursor | REQ-010, REQ-011 |
| `jobs.relate`, `jobs.unrelate` | control | two jobs | both jobs' `related` | REQ-009 |
| `jobs.resume` | control | job, optional `text` delivered to the lead | the job | REQ-005, REQ-006 |
| `jobs.complete` | control | job, `justification` | the job | REQ-005, REQ-007 |
| `jobs.cancel` | control | job, `justification` | the job | REQ-005, REQ-007 |
| `jobs.export` | control | `path`: an absolute file path on the machine that doesn't exist yet | the path and size written | REQ-016 |

There is no block operation for team members. `jobs.startLead` (S-001 REQ-012, S-002 REQ-012) stops being a
catalogue operation: `jobs.create` calls it in-process, so no lead conversation exists without a job.

**Contract** (refusals): an unknown job is `not_found`; a missing required input, a failed guard or an edit of a
field that isn't editable is `invalid_input` with a message naming the field; an action not allowed from the job's
status, or any change to a Done job other than relate and unrelate, is `conflict`.

### Exposed: job tools

Every role carries the job tools, and a tool set can't leave them out, as with S-001's coordination capabilities
(S-001 REQ-003). A tool acts on the job of the conversation it runs in.

| Tool | Who | Does |
|---|---|---|
| read job | every agent of the job | returns the job, its worklog and its history |
| update job | every agent of the job | changes the editable fields (REQ-004) |
| add to worklog | every agent of the job | adds an entry (REQ-010) |
| create job | every agent of the job | creates a follow-up job, Related to this one, keyed by its tool call id (REQ-003, REQ-007, REQ-009) |
| relate jobs | every agent of the job | relates or unrelates this job and another (REQ-009) |
| block job | the lead agent | blocks with a Blocked reason (REQ-005, REQ-006) |
| complete job | the lead agent | completes with a justification (REQ-005) |

A refused tool call returns an error result to the agent and its run goes on. Tool names and parameter layouts are
not contract; the tasks fix them.

### Exposed: feed events

The instance scope of the observation feed (S-002 REQ-014) carries the jobs that aren't Done in its snapshot, each
with its short number, title and status, and these deltas (REQ-015):

| Delta | Carries |
|---|---|
| job created | the job without worklog and history |
| job changed | the short number and the changed editable fields |
| worklog entry added | the short number and the entry |
| status changed | the short number, old and new status, and the Blocked reason when it blocks. A change to Done publishes "job done" instead |
| job done | the short number and the resolution |

### Consumed

- S-001: starting a job's lead conversation (REQ-012); parking and continuing it (REQ-014); submitting input to a
  conversation and the arrival of reports as input (REQ-019); the capability that aborts every conversation of a job
  (REQ-008); the job links each conversation records (REQ-012); the coordination capabilities' place in every role
  (REQ-003).
- S-002: the catalogue with its read and control kinds, errors and callers (REQ-012, REQ-013, REQ-017); origins built
  from the caller (AC-012.5); the observation feed (REQ-014); startup order, readiness and the database file (REQ-002,
  REQ-003, REQ-006); storage failure handling (REQ-007).
- S-003: the way in each listener stamps, and the observed caller details it passes (REQ-007, amended, see
  Assumptions and Dependencies).

## Workflow

The life of a job from its source to Done, with its refusals, the reminder rule, crash repair, and export and import:

```
Job source: team member (any way in), schedule fire, trigger, agent                       REQ-003
  ↓
jobs.create → role and overrides checked                                                    REQ-007
  (unknown role or bad override → refused, no job and no number)                           REQ-007
  (same idempotency key → the original job, no new number)                                 REQ-007
  → job written (To do, number allocated) → lead conversation started                      REQ-001, REQ-002, REQ-007
  (start still refused after the write → Done, cancelled, the daemon as author)            REQ-007
  ↓
Waits for a worker thread if all are busy; still To do                                      REQ-005
  ↓
start: lead's first run → In progress                                                       REQ-005
  ↓
Lead makes sure a definition of done exists                                                REQ-008
  ├─ can't → block (reason) → Blocked, lead parked, no worker thread                        REQ-006
  └─ writes it, writes the description, works, logs its steps                               REQ-004, REQ-010
  ↓
Lacks something → block (reason) → Blocked                                                 REQ-006
  (block refused while an invoked agent of the job still works)                             REQ-006
  answer: any input to the lead, or jobs.resume → In progress, reason cleared               REQ-006
  ↓
Lead's turn ends with the job neither Blocked nor Done                                     REQ-008
  → reminder once → ends again → Blocked "the lead stopped without completing or blocking"
  → no definition of done → Blocked "no definition of done"
  ↓
complete (definition of done and justification) → Done, completed                          REQ-005, REQ-007
cancel at any time but Done (justification) → Done, cancelled, conversations aborted        REQ-005, REQ-007
  ↓
Every change → history; every change → feed delta                                         REQ-011, REQ-015
Done → no field, worklog or action change; relate and unrelate still allowed               REQ-005

Crash between a job write and its pi-durable change → startup repair, before resume        REQ-018
Startup, after repair: the reminder rule for each idle In progress job                     REQ-008, REQ-018
Export while running → consistent copy; import into a stopped instance only                REQ-016, REQ-017
```

## Behavioral Requirements

### REQ-001 — The job store

The daemon SHALL keep the job record (jobs, per-letter counters, worklog entries, history entries and Related links)
in the-intern's own tables in the instance's SQLite file, named with the prefix `intern_`, with a job schema version
of its own. At startup step 4 (S-002 REQ-002) the daemon SHALL create the tables in a new database, migrate them
forward in an older one, and stop startup with an error naming the job schema version when the database holds a newer
one. The daemon SHALL read the job schema version before pi-durable opens the database, so a refused start leaves the
file unchanged. The job store MUST NOT read or write pi-durable's tables.

#### AC-001.1 — Created in a new database

- **Given:** an instance with no database
- **When:** the daemon starts
- **Then:** the database file holds the `intern_` tables at the current job schema version beside pi-durable's
  tables, and `jobs.list` returns no jobs

**Verification:** test — a service test starting the daemon on the fake model and reading the tables with SQLite.

#### AC-001.2 — A newer job schema stops startup

- **Given:** a database whose job schema version is newer than the running version's
- **When:** the daemon starts
- **Then:** it exits non-zero at step 4 naming both versions, and the database is unchanged

**Verification:** test — a service test with a database prepared at a higher job schema version.

### REQ-002 — Job IDs and short numbers

Every job SHALL have a job ID that is unique in the instance and a short number made of its origin letter and the next
value of that letter's counter, starting at 1, allocated in the same write that creates the job. Numbers MUST NOT be
reused or skipped. The origin letter follows the job's origin (REQ-003):

| Origin | Letter |
|---|---|
| request through the local socket (way in `command line`) | `C` |
| request through the network listener (way in `web interface`) | `W` |
| request by email (way in `email`) | `E` |
| schedule fire | `S` |
| trigger | `T` |
| follow-up job | `A` |

A request whose way in is `in-process`, the way in S-002 records when a caller names none (S-002 AC-012.5), has no
letter: `jobs.create` SHALL refuse it with `invalid_input`. Tests and the live checks name a real way in.

Every operation that names a job SHALL accept its job ID or its short number in any letter case.

#### AC-002.1 — One counter per letter

- **Given:** a new instance
- **When:** two jobs are created over the local socket, then one by email, then one more over the local socket
- **Then:** their numbers are `C-1`, `C-2`, `E-1` and `C-3`, and a `jobs.create` call in-process naming no way in
  is refused `invalid_input` and uses no number

**Verification:** test — a service test creating jobs with each way in.

#### AC-002.2 — Lookup in any case

- **Given:** job `E-14`
- **When:** `jobs.get` names `e-14`, `E-14` and the job's ID
- **Then:** each returns the same job; `jobs.get` naming `E-15`, which doesn't exist, is refused `not_found`

**Verification:** test — a service test.

#### AC-002.3 — Numbers are never reused

- **Given:** jobs `C-1` and `C-2`, with `C-2` cancelled, and a creation refused for an unknown role
- **When:** another job is created over the local socket
- **Then:** it is `C-3`

**Verification:** test — a service test.

### REQ-003 — The Request and its origin

Creating a job SHALL record its Request: the text exactly as received and an origin that holds the job source and
everything known about it. The origin MUST be built from the caller (S-002 AC-012.5):

- a team member's request records its way in and the details that way in observes: none beyond the way in on the
  local socket, the remote address and port on the network listener, and the message ID and sender for Email, which
  Email observes and passes with the caller
- an in-process job source states its own details: a schedule its entry and fire time, a trigger its trigger and
  event
- a follow-up job records the job and the conversation it was created from

A caller MAY add `statedBy`, a name of its own choosing; the job SHALL record it apart from the origin, labelled as
stated and not checked. Nothing in a call's input SHALL replace an observed origin detail.

#### AC-003.1 — Observed details from each listener

- **Given:** the daemon with both listeners
- **When:** a job is created over the local socket and another over the network listener
- **Then:** the first records way in `command line` and no other observed detail; the second records way in
  `web interface` and the remote address and port

**Verification:** test — a service test through both listeners on a temporary socket and a loopback port.

#### AC-003.2 — A claim doesn't replace the origin

- **Given:** a `jobs.create` call over the network listener whose input carries `statedBy: "Ana"` and an origin
  naming a schedule
- **When:** the job is created
- **Then:** the call is refused `invalid_input` naming `origin`, and no job or number is used; the same call without
  the origin creates `W-n` with the network listener's request, the observed remote address and port, and `statedBy`
  recorded as "Ana", stated, not checked

**Verification:** test — a service test.

#### AC-003.3 — A follow-up job names where it came from

- **Given:** the lead agent of `S-12`
- **When:** it creates a job through the job tools
- **Then:** the new job is `A-n`, its origin names `S-12` and the lead conversation, and the two jobs are Related

**Verification:** test — a service test on the fake model.

### REQ-004 — Editable fields

Any team member, through `jobs.update`, and any agent of the job, through the job tools, SHALL be able to change the
title, the description and the definition of done of a job that isn't Done. Every other field MUST NOT change through
an edit: an edit naming one is refused `invalid_input` and changes nothing. When two edits change the same field, the
later one wins and both are in the history.

#### AC-004.1 — An edit is recorded

- **Given:** job `C-7` In progress
- **When:** a team member sets its definition of done over the network listener
- **Then:** the job shows the new value, `updatedAt` changes, and the history holds one entry with the old and new
  value, the team member as author with way in `web interface`, and the time

**Verification:** test — a service test.

#### AC-004.2 — Automatic fields can't be edited

- **Given:** job `C-7`
- **When:** `jobs.update` names `number`, `status`, `resolution`, `blockedReason`, `request` or `createdAt`
- **Then:** each call is refused `invalid_input` naming the field, and the job and its history are unchanged

**Verification:** test — a service test.

### REQ-005 — Statuses and actions

A job's status SHALL be one of To do, In progress, Blocked and Done, and SHALL change only through these actions:

| Action | From → to | Who | Guard | Side effect |
|---|---|---|---|---|
| start | To do → In progress | the daemon | — | written when the lead conversation's first run takes a worker thread, before its first model request; a run that resumes after a crash with the job still To do writes it then |
| block | In progress → Blocked | the lead agent | Blocked reason not empty; no invoked conversation of the job still running or awaited | parks the lead conversation (REQ-006) |
| resume | Blocked → In progress | the daemon, on any input to the lead conversation; a team member, through `jobs.resume` | — | clears the Blocked reason; the lead continues (REQ-006) |
| complete | In progress → Done | the lead agent, or a team member through `jobs.complete` | definition of done not empty; justification not empty | resolution `completed`; aborts the job's remaining conversations, and, when the lead completes through its tool, its own run at that call (REQ-007) |
| cancel | To do, In progress or Blocked → Done | anyone through `jobs.cancel` | justification not empty | resolution `cancelled`; aborts every conversation of the job (REQ-007) |

A job SHALL never return to To do, and Done is final: no edit, worklog entry or action changes a Done job; relate and
unrelate still do (REQ-009). An action from a status it doesn't start from is refused `conflict`; a failed guard is
refused `invalid_input`. Every action is written to the history.

#### AC-005.1 — The normal path

- **Given:** a new job whose lead first waits for a worker thread
- **When:** it gets one, the lead writes a definition of done and completes the job with a justification
- **Then:** the job is To do while it waits, then In progress, then Done with resolution `completed` and the
  justification, and the history holds both status changes

**Verification:** test — a service test on the fake model with one worker thread.

#### AC-005.2 — Guards

- **Given:** a job In progress with an empty definition of done
- **When:** the lead completes it; the lead blocks it with an empty reason; a team member cancels it with an empty
  justification
- **Then:** each is refused `invalid_input` naming the missing field, and the status is unchanged

**Verification:** test — a service test.

#### AC-005.3 — Done is final

- **Given:** a Done job
- **When:** a team member updates its title, adds a worklog entry, resumes, completes or cancels it, and relates it to
  another job
- **Then:** the first five are refused `conflict` and change nothing; the relate succeeds

**Verification:** test — a service test.

#### AC-005.4 — Only the lead blocks and completes among agents

- **Given:** a specialist agent invoked for a job
- **When:** it calls the block and complete tools
- **Then:** both return an error result, the job's status is unchanged, and the specialist's run goes on

**Verification:** test — a service test on the fake model.

### REQ-006 — Blocking and resuming

When the lead agent blocks its job, the daemon SHALL set the job Blocked with its Blocked reason and park the lead
conversation, which then holds no worker thread (S-001 REQ-014). The block records the ID of the lead conversation's
newest transcript entry at the time of the block. Any input that reaches the lead conversation while its job is Blocked,
whether or not it has parked yet (a team member's input, an answer by email, or the text of `jobs.resume`), SHALL resume
the job: In progress, the Blocked reason cleared, and the lead continuing on a free worker thread. `jobs.resume` with no
text SHALL deliver a note that a team member resumed the job. The old reason stays in the history.

#### AC-006.1 — Blocked holds no worker thread

- **Given:** one worker thread and job `E-3` whose lead blocks it with "which system and what failure?"
- **When:** another job has work
- **Then:** `E-3` is Blocked with that reason, its lead conversation is parked, and the other job's lead runs

**Verification:** test — a service test on the fake model with one worker thread.

#### AC-006.2 — An answer resumes the job

- **Given:** job `E-3` Blocked
- **When:** a team member submits "the nightly build on ci-2" to its lead conversation over the network listener
- **Then:** `E-3` is In progress with no Blocked reason, the lead continues with the answer as input, and the history
  holds the cleared reason

**Verification:** test — a service test.

#### AC-006.3 — No block while invoked agents work

- **Given:** a lead that invoked a specialist which still runs
- **When:** the lead blocks the job
- **Then:** the block tool returns an error result naming the running invocation, and the job stays In progress

**Verification:** test — a service test on the fake model.

### REQ-007 — Creating, completing and cancelling

`jobs.create` SHALL first check the role and overrides as S-001 REQ-012 does, and refuse a bad one (an unknown role,
an unresolvable override) with `invalid_input`, leaving no job and using no number. It then writes the job and starts
the lead conversation through S-001 REQ-012, with the role and overrides the request names and a first input that
carries the job's short number and Request. If S-001 REQ-012 still refuses after the job is written, the daemon sets
the job Done, resolution `cancelled`, with a justification naming the refusal and the daemon as author.

`jobs.create` SHALL accept an optional `idempotencyKey` (S-002 REQ-013): a repeated call with the same key returns the
original job and uses no number. The create job tool keys each call by its tool call id.

Completing or cancelling SHALL abort every conversation of the job that still runs, is parked or awaits a report
(S-001 REQ-008), leaving nothing parked or awaited. When the lead completes the job through its tool, its own run is
aborted at that call along with the job's other conversations.

#### AC-007.1 — Creation starts the lead

- **Given:** the daemon
- **When:** a team member creates a job with text "rotate the staging TLS certificate" and no role
- **Then:** the job is `C-n`, To do or In progress, its lead conversation is seated as `bob`, and the lead's first
  input carries `C-n` and the text

**Verification:** test — a service test on the fake model.

#### AC-007.2 — A refused creation leaves nothing

- **Given:** the daemon
- **When:** a team member creates a job naming an unknown role
- **Then:** the call is refused `invalid_input`, no job and no conversation exist, and the next job takes the number
  the refused one would have had

**Verification:** test — a service test.

#### AC-007.3 — Cancel stops every conversation

- **Given:** job `W-9` with its lead parked for two running invoked agents
- **When:** a team member cancels it with "duplicate of C-7"
- **Then:** `W-9` is Done with resolution `cancelled` and that justification, all three conversations are aborted, and
  none is left parked or awaiting

**Verification:** test — a service test on the fake model.

#### AC-007.4 — A repeated creation makes one job

- **Given:** a `jobs.create` call with an `idempotencyKey`
- **When:** it is repeated, and once more after a crash between the job write and the start of the lead conversation
- **Then:** one job, one number and one lead conversation exist, and each repeat returns that job

**Verification:** test — a service test on the fake model, injecting the crash between the two writes.

#### AC-007.5 — A start refused after the write cancels the job

- **Given:** a `jobs.create` call that passes the check, and a lead conversation start that S-001 REQ-012 refuses
  after the job is written
- **When:** the job is created
- **Then:** the job is Done with resolution `cancelled`, its justification names the refusal, and the history names
  the daemon as author

**Verification:** test — a service test with the refusal injected after the job write.

### REQ-008 — The lead's first duty and the reminder rule

The lead's first input and the role prompt of every lead SHALL state that the lead first makes sure the job has a
definition of done and, if it can't write one, blocks the job with a reason, and that before it completes the job it
checks the result against the definition of done and states the evidence in the justification. When a lead's turn
ends with its job In progress and nothing left to wait for (no input queued, no invoked conversation running or
awaited), the daemon SHALL:

- block the job with the reason "no definition of done" if the definition of done is empty
- otherwise, the first time, send the lead one reminder to continue, block or complete
- otherwise, when the turn after a reminder ends the same way, block the job with the reason "the lead stopped without
  completing or blocking"

A reminder is spent once the job blocks or resumes, so the next stop gets one again. Whether a lead's reminder is
spent SHALL survive a restart. At startup, after the repair rules of REQ-018, the daemon SHALL check this rule for
each In progress job whose lead is idle and waits for nothing. This is the same rule applied to saved state, not a
repair rule.

#### AC-008.1 — No definition of done blocks

- **Given:** a lead whose fake model ends its turn without writing a definition of done
- **When:** the turn ends
- **Then:** the job is Blocked with "no definition of done" and the daemon as the author in the history

**Verification:** test — a service test on the fake model.

#### AC-008.2 — One reminder, then Blocked

- **Given:** a job with a definition of done whose lead's fake model ends two turns without completing or blocking
- **When:** each turn ends
- **Then:** after the first the lead gets one reminder; after the second the job is Blocked with "the lead stopped
  without completing or blocking"

**Verification:** test — a service test on the fake model.

#### AC-008.3 — Waiting for reports isn't stopping

- **Given:** a lead parked for a running invoked agent
- **When:** the lead's turn ends
- **Then:** no reminder is sent and the job stays In progress

**Verification:** test — a service test on the fake model.

#### AC-008.4 — The rule is checked at startup

- **Given:** a daemon killed after a lead's turn ended with its job In progress and nothing to wait for
- **When:** it starts again
- **Then:** the rule is applied to that job (a reminder, or a block if the reminder was already spent or the
  definition of done is empty) before listeners answer calls other than `daemon.status`

**Verification:** test — a service test on the fake model, killing the daemon at the end of the lead's turn.

### REQ-009 — Related jobs

`jobs.relate` and `jobs.unrelate` and the relate tool SHALL add and remove an undirected link between two different
jobs in any status. A job SHALL NOT be related to itself, and relating two jobs already related changes nothing.
Creating a follow-up job SHALL relate it to the job it was created from. Both jobs' history records each change.

#### AC-009.1 — Related both ways

- **Given:** jobs `C-7` and `W-9`
- **When:** a team member relates them
- **Then:** each lists the other in `related`; relating them again changes nothing; relating `C-7` to itself is
  refused `invalid_input`

**Verification:** test — a service test.

### REQ-010 — The worklog

Any agent of a job, through the job tools, and any team member, through `jobs.worklog.add`, SHALL be able to add an
entry with non-empty text to a job that isn't Done. The worklog is append-only: no entry is changed or removed, and a
correction is a new entry. Each entry records its time and author (Interfaces).

#### AC-010.1 — Entries from agents and team members

- **Given:** job `C-7` In progress
- **When:** its lead adds "tried certbot renew: rate limited" and a team member adds "use the staging ACME endpoint"
- **Then:** `jobs.worklog.list` returns both in order, the first with the lead's conversation and role as author, the
  second with the team member and the way in

**Verification:** test — a service test on the fake model.

### REQ-011 — The history

The daemon SHALL write one history entry for every change to a job's editable fields, status, Blocked reason,
resolution and Related links, in the same write as the change, with the old value, the new value, the author and the
time. Each repair of REQ-018 writes one `repair` entry (Interfaces); the changes it makes to the status, the Blocked
reason or the resolution are recorded as any change is. The history is append-only and separate from the worklog.
Creating a job writes no history entry; its creation time and Request are on the job.

#### AC-011.1 — Every change, nothing else

- **Given:** a job that is created, edited twice, blocked, resumed and completed
- **When:** its history is listed
- **Then:** it holds exactly two field entries, the status changes To do → In progress → Blocked → In progress →
  Done with the Blocked reason set and cleared, and the resolution, each with its author and time; its worklog holds
  only entries someone added

**Verification:** test — a service test on the fake model.

### REQ-012 — Job operations in the catalogue

The daemon SHALL offer the job operations of Interfaces in S-002's catalogue with the kinds shown there, so S-003's
listeners carry them with no listener change. `jobs.startLead` SHALL NOT be a catalogue operation; `jobs.create`
calls it in-process.

#### AC-012.1 — Reachable through both listeners

- **Given:** the daemon with both listeners
- **When:** the catalogue is listed and each job operation is called over each listener
- **Then:** every job operation is listed with its kind and answers as it answers in-process, and `jobs.startLead` is
  not listed and is refused `not_found` over a listener

**Verification:** test — a service test through both listeners.

### REQ-013 — Job tools in every role

Every role SHALL carry the job tools of Interfaces, and a role's tool set SHALL NOT be able to leave them out. A job
tool SHALL act only on the job of the conversation it runs in, except that create job makes a new job and relate jobs
names a second one. The block and complete tools SHALL be refused for any agent but the lead agent.

#### AC-013.1 — A tool set can't remove them

- **Given:** a team role whose tool set names only `read`
- **When:** an agent of that role is seated in a job's conversation
- **Then:** it is offered `read`, the coordination tools (S-001 REQ-003) and the job tools

**Verification:** test — a service test.

### REQ-014 — Reading and listing jobs

`jobs.get` SHALL return one job with its worklog and history. `jobs.list` SHALL return jobs newest first, filtered by
status, origin letter and Related job when given, in pages of at most `limit` (default 50, at most 500) with a cursor
for the next page. An unknown status or letter is refused `invalid_input`.

#### AC-014.1 — Filtering and paging

- **Given:** 120 jobs, 30 of them Blocked, 12 of those with letter `E`
- **When:** `jobs.list` asks for status Blocked and letter `E` with limit 5, and follows the cursor
- **Then:** it returns the 12 jobs newest first in three pages, and the last page has no cursor

**Verification:** test — a service test.

### REQ-015 — Job events on the feed

The instance scope of the observation feed SHALL carry the jobs that aren't Done in its snapshot and the job deltas of
Interfaces, each published after the change is written. A job ending SHALL publish one "job done" delta with its
resolution, which triggers can listen for (Schedules and triggers spec).

#### AC-015.1 — A subscriber sees the lifecycle

- **Given:** a subscriber to the instance scope
- **When:** a job is created, its lead's first run starts, and the job is edited, blocked, resumed and completed
- **Then:** it receives "job created"; "status changed" from To do to In progress; "job changed"; "status changed" to
  Blocked with the Blocked reason; "status changed" back to In progress; and one "job done" with resolution `completed`,
  in that order

**Verification:** test — a service test on the fake model.

### REQ-016 — Export

`jobs.export` SHALL write a consistent copy of the instance's whole database (the job store and pi-durable's data) to
the given absolute path while the daemon keeps working, and refuse a relative path or an existing file with
`invalid_input`. Work in progress SHALL go on during the export. The copy SHALL be created owner-only (S-002 REQ-006;
ADR-002 decision 6). It holds the database only; the configuration file (roles, registered workspaces, `[network]`)
isn't in it.

#### AC-016.1 — A copy while working

- **Given:** a daemon with jobs running on the fake model
- **When:** a team member exports to a new file
- **Then:** the call returns the path and size, the jobs go on, the file is owner-only, and it opens as a database
  holding every job, worklog entry, history entry and conversation committed before the export began

**Verification:** test — a service test.

### REQ-017 — Import

The package SHALL offer an import step, run by the command line while the instance's daemon is stopped, that places an
exported file as the instance's database. The import step SHALL hold the instance's single-owner lock while it runs
(S-002 REQ-001), so it never replaces the database of a running daemon and no daemon starts while it runs. It SHALL
refuse when the instance's daemon is running, when the state directory holds the database file or its `-wal` or
`-shm` file, when the file's job schema version is newer than the running version's, and when the file's pi-durable
schema is newer than the running version's. It SHALL create the database owner-only. An older job schema is migrated
at the next start (REQ-001). The first start on an imported copy applies REQ-018 and resumes unfinished work (S-002
REQ-008), so importing a copy of an instance that is still running does that work twice.

#### AC-017.1 — Moving to another computer

- **Given:** an exported file and a new instance on another computer running the same version
- **When:** the file is imported and the daemon starts
- **Then:** every job, worklog entry, history entry, Related link, counter and conversation of the export is there,
  and the next job created over the local socket continues its letter's counter

**Verification:** test — a service test with two temporary instances.

#### AC-017.2 — Refusals

- **Given:** an instance with a database; an instance with only a `-wal` file left; a running daemon; a file with a
  newer job schema; a file with a newer pi-durable schema
- **When:** each is imported
- **Then:** each is refused with a message naming the reason, nothing changes, and a daemon started while the import
  runs is refused

**Verification:** test — a service test.

## Quality Requirements

### REQ-018 — Ordered writes and startup repair

Each job write that goes with a pi-durable change the daemon makes SHALL be committed before that change: a job before
its lead conversation starts, a block before the lead conversation parks, a complete or cancel before the
conversations are aborted. Input to a Blocked job's lead reaches the lead conversation first, and the resume follows
it (REQ-006). At startup, after the database opens and before work resumes (S-002 REQ-002 step 7, amended), the daemon
SHALL apply exactly these repair rules, write each repair to the history as one `repair` entry with the daemon as
author (Interfaces), and apply no other recovery to jobs:

1. a job that isn't Done and has no lead conversation (no conversation records the job as its lead) gets it started
   (S-001 REQ-012 is safe to repeat for the same job); if S-001 REQ-012 refuses the start, the job is cancelled as
   REQ-007 states
2. a Blocked job whose lead conversation isn't parked gets it parked
3. a job whose lead conversation holds input it hasn't taken since the job blocked (queued input, or held messages),
   or has taken input since the job blocked (an input entry in its transcript after the entry the block recorded), is
   set In progress if it is still Blocked, with the Blocked reason cleared, and the lead continues with that input
4. a Done job with conversations still running, parked or awaited gets them aborted

An input entry is an entry of kind `pi.user`, or one of the input entry kinds the daemon submits (the steer record and
the ADR-004 kinds). Rule 3 is applied before rule 2. After the repair rules, the daemon checks REQ-008's rule for each
In progress job whose lead is idle and waits for nothing; this is REQ-008 applied to saved state, not a repair rule.

#### AC-018.1 — One crash per rule

- **Given:** for each rule, a daemon killed between the job write and its pi-durable change, including a lead that
  took an answer after the park was cleared, before the resume was written
- **When:** the daemon starts again
- **Then:** before any listener answers a call other than `daemon.status`, the job and its conversations are in the
  state the rule names, and the history records the repair

**Verification:** test — one deterministic service test per rule, injecting the crash between the two writes.

### REQ-019 — Reference timings

A timing test SHALL measure and report `jobs.list` with a status or letter filter over 10,000 jobs, and `jobs.get` for
a job with 1,000 worklog entries, on the reference machine of the live checks, beside the reference targets of 200 ms
and 100 ms. The targets are references, not acceptance thresholds (product owner, 2026-11-02): a miss is reported,
not failed.

#### AC-019.1 — Measured and reported

- **Given:** a store seeded with 10,000 jobs, one with 1,000 worklog entries
- **When:** the timing test runs
- **Then:** it reports both timings beside the reference targets and passes whatever they are

**Verification:** test — a service test that prints the timings.

### REQ-020 — Storage failures

A failed job store write SHALL fail the operation or tool call with `internal` and change nothing, and SHALL be
handled as S-002 REQ-007 handles a pi-durable storage failure.

#### AC-020.1 — A failed write changes nothing

- **Given:** a job store whose next write fails
- **When:** a team member updates a job
- **Then:** the call fails `internal`, the job and its history are unchanged, and the daemon follows S-002 REQ-007

**Verification:** test — a service test with a failing write injected.

Security and privacy: none beyond ADR-002 and S-003 REQ-014. No way in authenticates callers, and the job record holds
what team members and agents write into it.

## Configuration Requirements

None. The job store lives in the instance's database file (S-002 REQ-006), and export takes its path per call. No
setting changes the statuses, the actions or the letters.

## Assumptions and Dependencies

- **ADR-001, amended with this spec.** Decision 1 gains the job store as the-intern's own `intern_` tables in the same
  SQLite file; decision 4 gains a second bounded exception: ordered job writes and the four repair rules of REQ-018.
  The amendment is raised by this spec's architecture consistency review and must be accepted before the task
  breakdown passes Gate 2. The product owner approved this spec at Gate 1 on 2026-11-02, before that review.
- **pi-durable shares its SQLite file.** Confirmed in the pinned pi-durable 1.4.0: its SQLite storage opens on a
  database the host can open itself and names its own tables, so other tables can live in the same file; its commits
  run in their own transactions, which is why job writes are ordered and repaired instead of joined.
- **ADR-004, amended with this spec.** Decision 5 gains entry kinds for the text of `jobs.resume`, the default resume
  note and the reminder (REQ-006, REQ-008), each carrying its actor. The Architect amends ADR-004 before the task
  breakdown passes Gate 2.
- **S-000 amendment.** The job record keeps its own format in tables of its own, which each version migrates forward;
  export and import copy the whole saved state for backups, moving to another computer and upgrades, and don't
  convert it (Solution overview, Jobs, Project exclusions; REQ-001, REQ-016, REQ-017).
- **S-001 amendments.** The job tools are part of every role like the coordination capabilities (REQ-003, REQ-005);
  block and complete are lead-only; the lead's role prompt states the first duty (REQ-008); a lead's turn end is
  observable for the reminder rule; the daemon is an actor for input it sends under a job's rules (REQ-007); a message
  sent to a lead conversation parked because its job is Blocked continues it (REQ-014, REQ-020); the Job definition
  names this spec's fields; `jobs.startLead` is in-process only, called by `jobs.create`; a job with letter `A` is
  S-001's follow-up job source.
- **S-002 amendments.** The job operations replace `jobs.startLead` in the catalogue, and creating a job records the
  origin (REQ-012); startup step 4 reads the job schema version and opens the job store and step 7 runs the repair
  before resuming work (REQ-002); the instance scope of the feed carries the job deltas in its sequence (REQ-014); the
  `in-process` way in, recorded when a caller names none (AC-012.5), is refused by `jobs.create` (REQ-002); a team
  member's request records the details its way in observes (REQ-012, REQ-013); a job store write failure is handled
  as a storage error (REQ-007); a held message waits only for a conversation parked for reports (REQ-012); the
  Durability principle names job writes and repair as its second exception, and the One-owner principle names the
  import step.
- **S-003 amendment.** Each listener passes its observed caller details with the way in (REQ-007): none beyond the way
  in on the local socket, and on the network listener the TCP peer's remote address and port, never a header such as
  `X-Forwarded-For`. The `jobs.startLead` mentions in S-003 AC-007.2 move to `jobs.create`.
- **Later specs.** Email passes the message ID and sender it observes; schedules and triggers state their entry, fire
  time, trigger and event; the Command line spec names the import command; the Web interface spec presents the board.
  Until they exist, tests and the live checks call the operations.
- **Node's SQLite.** The daemon's Node 24 SQLite support provides the online backup that REQ-016 uses.

## Success Criteria

1. A team member creates a job over the local socket and one over the network listener, and they get `C-1` and `W-1`
   with their observed origin details (REQ-002, REQ-003, REQ-007).
2. In the live check, a clear request ends Done `completed` with a definition of done and a justification, and an
   unclear one ends Blocked with a reason, then resumes after an answer (REQ-005, REQ-006, REQ-008).
3. No job is ever In progress with no agent working on it once its lead's turn has ended twice (REQ-008).
4. Each of the four crash tests ends with job and conversations in step before the first listener call (REQ-018).
5. An export taken while jobs run imports on a second instance with every job, worklog entry, history entry and
   conversation present (REQ-016, REQ-017).
6. Every job operation answers through both listeners as it does in-process (REQ-012).

## Implementation Order

| Phase | Outcome | Depends on |
|---|---|---|
| 1 | The job store: tables, migrations, counters and short numbers; `jobs.create` (calling `jobs.startLead` in-process), `jobs.get`, `jobs.list`, `jobs.update`, the worklog, the history and Related | S-001, S-002, S-003 delivered |
| 2 | The lifecycle: the action table, blocking and resuming, completing and cancelling, the reminder rule, the job tools in every role and the lead's first duty | Phase 1 |
| 3 | Ordered writes and the four repair rules, the ADR-001 amendment in code, and the job feed events | Phase 2 |
| 4 | Observed origin details through both listeners and `statedBy` | Phase 1, S-003 amendment |
| 5 | Export and import, the reference timings, the live check, and the docs (developer architecture, user manual, spec map) | Phases 1–4 |

## Open Questions

None.

## Amendment Log

| Date | What changed | Why | Affected tasks |
|------|-------------|-----|----------------|
| 2026-11-02 | REQ-007 and AC-007.2: `jobs.create` checks the role and overrides first and refuses a bad one with no job and no number, then writes the job and starts the lead; a start still refused after the write cancels the job (new AC-007.5); an optional `idempotencyKey` returns the original job, and the create job tool keys each call by its tool call id (new AC-007.4); a lead completing through its tool has its own run aborted at that call. REQ-018: the ordering names each write and its pi-durable change; rule 1 covers a job that isn't Done with no conversation recording it as its lead, and cancels the job when the start is refused; rule 3 covers input the lead hasn't taken since the job blocked and is applied before rule 2. REQ-008: the first duty includes checking the result against the definition of done and stating the evidence; whether a reminder is spent survives a restart, and the rule is checked at startup for each idle In progress job after the repair rules (new AC-008.4). REQ-005: the start is written when the lead's first run takes a worker thread; complete aborts the lead's own run. REQ-006: any input while the job is Blocked resumes it, parked or not; an invoked agent's report is no longer listed. REQ-003, AC-003.1, AC-003.2 and the `jobs.create` input: no OS account on the local socket; Email is a way in that passes the message ID and sender it observes; `origin` is refused from any caller but a job source. REQ-001: the job schema version is read before pi-durable opens the database. REQ-016 and AC-016.1: the export is owner-only and holds the database only. REQ-017 and AC-017.2: the import holds the single-owner lock, refuses leftover `-wal` and `-shm` files and a newer pi-durable schema, and creates the database owner-only. AC-013.1: the coordination tools are offered too. The term "Agent-created job" became "Follow-up job" (Definitions, REQ-002, REQ-003, REQ-009, job tools). Interfaces: `leadConversation` is read from the conversation that records the job as its lead. Users and Journeys, Workflow, Assumptions and Dependencies (S-000, S-001, S-002, S-003 amendments, ADR-004) follow. Version 0.2. | S-004 architecture consistency review (findings F1 to F18); product owner decisions 2026-11-02: F13 option A, the S-000 amendment, the OS account dropped. Driving ADRs: ADR-001, amended 2026-11-02 for the job store; ADR-004, to be amended for the new entry kinds. | None; S-004 isn't broken down yet |
| 2026-11-02 | v0.3. AC-015.1 and the feed events table: the start publishes "status changed" like any status change, so the lifecycle has three; a change to Done publishes "job done" instead. Definitions (History), Interfaces (history entry, author), REQ-011 and REQ-018: each repair writes one `repair` history entry naming the rule and what it did; the daemon authors a resume on input and the cancel after a refused start. | Gate 2 review of the S-004 task plan (questions on T-128 and T-129). | T-128, T-129 |
| 2026-11-02 | v0.4. REQ-006: the block records the ID of the lead conversation's newest transcript entry at the time of the block. REQ-018: rule 3 also covers a lead that has taken input since the job blocked, shown by an input entry in its transcript after the entry the block recorded; an input entry is a `pi.user` entry or an input entry kind the daemon submits (the steer record and the ADR-004 kinds). AC-018.1: the crash cases include a lead that took an answer after the park was cleared, before the resume was written. Interfaces: the job's internal `blockedAfterEntry`, set by the block and cleared by the resume in the same write, not returned by `jobs.get` and not recorded in the history. | T-129 F1 escalation; Architect escalation review; product owner decision 2026-11-02 (option A); ADR-001 decision 4 amended. | T-143, T-129, T-136 |
