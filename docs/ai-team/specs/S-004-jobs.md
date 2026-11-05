---
id: S-004
title: Jobs
version: '0.10'
status: approved  # draft | review | approved | superseded
created: '2026-11-02'
author: planner
---

# Jobs

## Purpose

This spec covers S-000's **Jobs** component: the job record and the life of a job. S-001 starts and coordinates the
conversations that work on a job, but nothing yet records what a job is, what it must deliver, whether it is blocked
and why, or how it ended, so no job source can create a job and no way in can show one. This spec fixes the job
record in the-intern's own tables in the instance's database, the four statuses and the five actions that move
them, the worklog agents keep for each other, the history of every change, the job operations and the job tools every
role carries, and the export and import of the whole database. When it is done, a team member creates a job from any
way in, its lead agent writes the definition of done or blocks the job with a reason, an answer resumes it, and it
ends Done with a resolution and justification that triggers and team members can see (Success Criteria).

## Definitions

This spec uses the Definitions of S-001, S-002 and S-003 (job, lead conversation, lead agent, specialist agent, job
source, origin, front desk, way in, caller, service operation, observation feed) and the shared vocabulary of
`docs/system_overview.html`. It adds these terms:

| Term | Meaning in this spec |
|---|---|
| Job record | Every job with its fields, worklog, history and Related links, kept in the job store. |
| Job store | The-intern's own tables in the instance's database that hold the job record (REQ-001). |
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
| Team member | Hands The Intern a job from the command line, the web interface or email, directly or through the front desk, follows it, answers it when it is blocked, edits it or cancels it. |
| Front desk agent | Creates jobs for team members, lists and reads jobs, edits them, adds to their worklog and relates them, naming each job (REQ-021). |
| Lead agent | Writes the definition of done, keeps the description and the worklog, blocks the job when it lacks something and completes it. |
| Specialist agent | Reads the job it works on, adds to its worklog and creates new jobs it finds. |
| Job sources and Email (downstream systems) | Schedules and triggers create jobs in-process with their own origin details; Email, a way in, passes a team member's request with the message ID and sender it observes. |
| Later specs (downstream systems) | The Command line and Web interface specs present jobs; the Schedules and triggers spec listens for jobs ending; all call this spec's operations and follow its feed events. |
| Developer | Tests the job lifecycle on the fake model, including crashes in the middle of a job change. |

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
5. **Work found along the way.** An agent creates a new job, and relates it to the job it came from when it
   chooses. Delivered by REQ-003, REQ-009, REQ-013.
6. **Keep and move the record.** A team member exports the whole database while The Intern works, and imports it on
   another computer or keeps it as a backup. Delivered by REQ-016, REQ-017.
7. **Nothing is lost in a crash.** A crash in the middle of a job change is repaired at the next start. Delivered by
   REQ-018.
8. **Ask the front desk.** A team member asks the front desk for work from the command line or the web interface; it
   creates a `C` or `W` job that names the front desk in its origin details, whose lead takes it as usual, and it
   lists and reads jobs to answer what is going on. Delivered by REQ-021, REQ-022.

## Exclusions

What this specification explicitly does NOT cover:

- **Priorities, due dates, estimates and time tracking.** Admission is first in, first out (S-002 REQ-010), and no
  field orders or schedules jobs.
- **Assigning jobs to people, watchers, votes, labels and attachments.** All team members are equal (ADR-002), and the
  lead conversation is the only owner a job has.
- **Reopening a Done job.** Done is final, and the job's conversations are closed for good (S-001 REQ-026); more
  work becomes a new job, which may be Related to the old one.
- **Sub-jobs and dependencies between jobs.** Related is the only link. Invoked agents take the place of sub-jobs
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
- **The front desk itself.** S-001 owns the front desk. It has no job record, so it is never on the board, has no
  definition of done, and the reminder rule, the actions and the repair rules don't apply to it (REQ-022).

## Alternatives Considered

- **Status as an ordinary field, checked on every write.** One generic update, with a validation table and observers
  firing the side effects. Rejected: side effects hide behind field writes, a refused write is the only feedback, and
  a field becomes the workaround for a rule.
- **The lead keeping the job as a file in its workspace, synced into the database.** Rejected: two sources of truth,
  conflicts when a team member edits the job meanwhile, and no guard at the moment of change.
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

There is no block operation for team members. Starting a job's lead conversation (S-001 REQ-012, S-002 REQ-012) isn't a
catalogue operation: `jobs.create` does it in-process, so no lead conversation exists without a job.

**Contract** (refusals): an unknown job is `not_found`; a missing required input, a failed guard or an edit of a
field that isn't editable is `invalid_input` with a message naming the field; an action not allowed from the job's
status, or any change to a Done job other than relate and unrelate, is `conflict`. The front desk's conversation id
named as a job is `invalid_input`, saying the front desk is not a job conversation (REQ-022).

### Exposed: job tools

Every seat in a job's conversation carries the job tools, and a tool set can't leave them out, as with S-001's
coordination capabilities (S-001 REQ-003). A tool acts on the job of the conversation it runs in.

| Tool | Who | Does |
|---|---|---|
| read job | every agent of the job | returns the job, its worklog and its history |
| update job | every agent of the job | changes the editable fields (REQ-004) |
| add to worklog | every agent of the job | adds an entry (REQ-010) |
| create job | every agent of the job | creates a follow-up job, keyed by its tool call id; an optional `related` flag, when true, relates it to this job (REQ-003, REQ-007, REQ-009) |
| relate jobs | every agent of the job | relates or unrelates this job and another (REQ-009) |
| block job | the lead agent | blocks with a Blocked reason (REQ-005, REQ-006) |
| complete job | the lead agent | completes with a justification and ends the lead's run; must be the only tool call of its model turn (REQ-005, REQ-007) |

In the front desk, which belongs to no job, the seat carries other job tools instead, each naming the job it acts
on (REQ-021; S-001 REQ-022):

| Tool | Does |
|---|---|
| read job, update job, add to worklog, relate jobs | as in a job's conversation, on the job the call names |
| create job | creates a job whose origin is the way in of the team member's input being answered, `C` or `W`, with the front desk in its origin details, keyed by its tool call id |
| list jobs | lists jobs as `jobs.list` does, filtered by status and origin letter |

Block job and complete job are never offered there.

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
  conversation and the arrival of reports as input (REQ-019); the capability that aborts and closes every
  conversation of a job (REQ-008, REQ-026); the job links each conversation records (REQ-012); the coordination
  capabilities' place in every role (REQ-003); the front desk, its tools and the input whose way in a front-desk job
  takes (REQ-021 to REQ-025).
- S-002: the catalogue with its read and control kinds, errors and callers (REQ-012, REQ-013, REQ-017); origins built
  from the caller (AC-012.5); the observation feed (REQ-014); startup order, readiness and the database file (REQ-002,
  REQ-003, REQ-006); storage failure handling (REQ-007).
- S-003: the way in each listener stamps, and the observed caller details it passes (REQ-007, amended, see
  Assumptions and Dependencies).

## Workflow

The life of a job from its source to Done, with its refusals, the reminder rule, crash repair, and export and import:

```
Job source: team member (any way in), schedule fire, trigger, agent                       REQ-003
  (through the front desk → the way in's letter, C or W, and the front desk in the origin)  REQ-021
  ↓
jobs.create → role and overrides checked                                                    REQ-007
  (unknown role or bad override → refused, no job and no number)                           REQ-007
  (same idempotency key → the original job, no new number)                                 REQ-007
  → job written (To do, number allocated) → lead conversation started                      REQ-001, REQ-002, REQ-007
  (start still refused after the write → Done, cancelled, the daemon as author)            REQ-007
  (crash after the lead is created, before its first input → repair rule 1)                REQ-018
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
cancel at any time but Done (justification) → Done, cancelled                               REQ-005, REQ-007
  ↓
Done → every conversation of the job closed, read only for good, and aborted,  REQ-007; S-001 REQ-026
       except a lead that completes through its tool, whose run ends at that call
  ↓
Every change → history; every change → feed delta                                         REQ-011, REQ-015
Done → no field, worklog or action change; relate and unrelate still allowed               REQ-005

Crash in the middle of a job change → startup repair, before resume                        REQ-018
Startup, after repair: the reminder rule for each idle In progress job                     REQ-008, REQ-018
Export while running → consistent copy; import into a stopped instance only                REQ-016, REQ-017
```

## Behavioral Requirements

### REQ-001 — The job store

The daemon SHALL keep the job record (jobs, per-letter counters, worklog entries, history entries and Related links)
in the-intern's own tables in the instance's database, with a job schema version of its own. At startup step 4 (S-002
REQ-002) the daemon SHALL create the tables in a new database, migrate them
forward in an older one, and stop startup with an error naming the job schema version when the database holds a newer
one. The daemon SHALL read the job schema version before pi-durable opens the database, so a refused start leaves the
file unchanged. The job store MUST NOT read or write pi-durable's tables.

#### AC-001.1 — Created in a new database

- **Given:** an instance with no database
- **When:** the daemon starts
- **Then:** the database file holds the job tables at the current job schema version beside pi-durable's tables, and
  `jobs.list` returns no jobs

**Verification:** test — a service test starting the daemon on the fake model and reading the tables directly.

#### AC-001.2 — A newer job schema stops startup

- **Given:** a database whose job schema version is newer than the running version's
- **When:** the daemon starts
- **Then:** it exits non-zero at step 4 naming both versions, and the database is unchanged

**Verification:** test — a service test with a database prepared at a higher job schema version.

### REQ-002 — Job IDs and short numbers

Every job SHALL have a job ID that is unique in the instance and a short number made of its origin letter and the next
value of that letter's counter, starting at 1, allocated as one change with the job's creation. Numbers MUST NOT be
reused or skipped. The origin letter follows the job's origin (REQ-003):

| Origin | Letter |
|---|---|
| request through the local socket (way in `command line`) | `C` |
| request through the network listener (way in `web interface`) | `W` |
| request by email (way in `email`) | `E` |
| schedule fire | `S` |
| trigger | `T` |
| follow-up job | `A` |

A job the front desk creates takes the letter of the way in of the team member's input it answers, `C` or `W`
(REQ-021). A request whose way in is `in-process`, the way in S-002 records when a caller names none (S-002
AC-012.5), has no letter: `jobs.create` SHALL refuse it with `invalid_input`. Tests and the live checks name a real
way in.

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
- a job the front desk creates records a request with the way in of the team member's input the front desk answers,
  and origin details that name the front desk (REQ-021)

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
- **Then:** the new job is `A-n`, its origin names `S-12` and the lead conversation; the two jobs are Related when
  the call sets `related`, and not Related when it doesn't

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
| complete | In progress → Done | the lead agent, or a team member through `jobs.complete` | definition of done not empty; justification not empty; when the lead uses the tool, the only tool call of its model turn | resolution `completed`; aborts the job's remaining conversations, and, when the lead completes through its tool, ends its own run at that call, and closes every conversation of the job (REQ-007) |
| cancel | To do, In progress or Blocked → Done | anyone through `jobs.cancel` | justification not empty | resolution `cancelled`; aborts and closes every conversation of the job (REQ-007) |

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

#### AC-005.5 — The complete tool succeeds and ends the run

- **Given:** a lead with a running invoked agent and a follow-up queued for the lead
- **When:** the lead calls the complete tool as the only call of its model turn
- **Then:** the tool result is not an error and names the job as Done, the run's input settles `done`, the follow-up
  settles `unanswered` with reason `closed` and starts no run, the model gets no further request, and the invoked agent
  is aborted and both conversations are closed

**Verification:** test — a service test on the fake model.

#### AC-005.6 — The complete tool with other calls

- **Given:** a lead with a definition of done met
- **When:** it calls the complete tool and another tool in one model turn
- **Then:** the complete tool returns an error result naming the rule, the job stays In progress, the other tool
  finishes, and a later call made alone completes the job. Two complete calls in one model turn both return that error
  result, and the job stays In progress.

**Verification:** test — a service test on the fake model.

#### AC-005.7 — A refused complete tool doesn't end the run

- **Given:** a lead with an empty definition of done
- **When:** it calls the complete tool as the only call of its model turn
- **Then:** it gets an error result, the job stays In progress, and the model gets a further request

**Verification:** test — a service test on the fake model.

#### AC-005.8 — A close that fails after the complete write

- **Given:** a lead with a running invoked agent and a follow-up queued for the lead
- **When:** it calls the complete tool as the only call of its model turn, and marking the conversations closed fails
  after the job is recorded Done, without a storage error
- **Then:** the job is Done, the failure is logged, the model gets no further request, the run's input and the follow-up
  settle `unanswered` with reason `aborted`, the tool's result records the abort, and the invoked agent is aborted.
  Until the next start, both conversations list with a status other than `closed` and refuse input `conflict`. At the
  next start, rule 4 closes both conversations.

**Verification:** test — a service test on the fake model, with the failure injected and a restart.

### REQ-006 — Blocking and resuming

When the lead agent blocks its job, the daemon SHALL set the job Blocked with its Blocked reason and park the lead
conversation, which then holds no worker thread (S-001 REQ-014). Any input that reaches the lead conversation while its
job is Blocked,
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

Completing or cancelling SHALL abort every conversation of the job that still runs, is parked or awaits a report (S-001
REQ-008), leaving nothing parked or awaited, and SHALL close every conversation of the job, idle ones included (S-001
REQ-026). Input, abort, reset, reseat and compaction of a closed conversation are refused `conflict`, so no answer
reaches a Done job's lead. The front desk is no conversation of any job, so they never abort or close it (REQ-022). When
the lead completes the job through its tool, the tool records its result and its own run ends at that call with no
further model turn; the job's other conversations are aborted. Once the job is recorded Done, the run ends with no
further model turn whatever a later step of the close does; a step that fails is logged, and repair rule 4 finishes it
at the next start. The tool's result is not an error, unless the lead couldn't be marked closed: the daemon then aborts
the lead's run, which withdraws its queued input and records the call as aborted. The job's
other conversations are aborted in either case. A team member's `jobs.complete` or `jobs.cancel` that fails while
marking a conversation closed, or at an abort after it, without a storage error, fails with `internal` and aborts no
further
conversation (S-001 REQ-026). A refused complete tool ends nothing: it returns an error result and the run goes on. The
complete tool SHALL be the only tool call of its model turn: called with others, a second complete call included, each
complete call returns an error result and changes nothing, and the other calls go on. From the complete or cancel, input
to the job's conversations is refused as S-001 REQ-026 states. A lead start refused because the job is already Done
doesn't cancel it again: `jobs.create` returns the job as Done. A job completed or cancelled before its lead
conversation is created gets none, and `jobs.get` returns no `leadConversation` for it. One completed or cancelled after
the creation and before the first input keeps a closed lead conversation that holds no first input.

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
- **Then:** `W-9` is Done with resolution `cancelled` and that justification, all three conversations are aborted and
  closed, and none is left parked or awaiting

**Verification:** test — a service test on the fake model.

#### AC-007.4 — A repeated creation makes one job

- **Given:** a `jobs.create` call with an `idempotencyKey`
- **When:** it is repeated, and once more after a crash after the job is created and before its lead conversation starts
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

The lead's first input and the system prompt of every lead SHALL state that the lead first makes sure the job has a
definition of done and, if it can't write one, blocks the job with a reason, and that before it completes the job it
checks the result against the definition of done and states the evidence in the justification. When a lead's turn
ends with its job In progress and nothing left to wait for (no input queued, no invoked conversation running or
awaited), the daemon SHALL:

- block the job with the reason "no definition of done" if the definition of done is empty
- otherwise, the first time, send the lead one reminder to continue, block or complete
- otherwise, when the turn after a reminder ends the same way, block the job with the reason "the lead stopped without
  completing or blocking"

The rule applies to a job's lead only, never to the front desk (REQ-022). A reminder is spent once the job blocks
or resumes, so the next stop gets one again. Whether a lead's reminder is
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
Creating a follow-up job SHALL relate it to the job it was created from only when the create job call asks for it
with its `related` flag; the agent decides each time, and a call without the flag relates nothing. The follow-up's
origin names the conversation it came from either way (REQ-003). Both jobs' history records each change.

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
resolution and Related links, as one change with it, with the old value, the new value, the author and the
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
listeners carry them with no listener change. Starting a lead conversation SHALL NOT be a catalogue operation;
`jobs.create` does it in-process.

#### AC-012.1 — Reachable through both listeners

- **Given:** the daemon with both listeners
- **When:** the catalogue is listed and each job operation is called over each listener
- **Then:** every job operation is listed with its kind and answers as it answers in-process, and no operation that
  starts a lead conversation is listed; a call naming one is refused `not_found` over a listener

**Verification:** test — a service test through both listeners.

### REQ-013 — Job tools in every role

Every seat in a job's conversation SHALL carry the job tools of Interfaces, and a role's tool set SHALL NOT be able
to leave them out. The front desk carries the job tools of REQ-021 instead. A job
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

`jobs.export` SHALL write a consistent copy of the instance's whole database (the job record and the conversations) to
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
refuse when the instance's daemon is running, when the state directory holds the database file or anything left of
one, when the file's job schema version is newer than the running version's, and when its conversation data is newer
than the running version can read. It SHALL create the database owner-only. An older job schema is migrated
at the next start (REQ-001). The first start on an imported copy applies REQ-018 and resumes unfinished work (S-002
REQ-008), so importing a copy of an instance that is still running does that work twice.

#### AC-017.1 — Moving to another computer

- **Given:** an exported file and a new instance on another computer running the same version
- **When:** the file is imported and the daemon starts
- **Then:** every job, worklog entry, history entry, Related link, counter and conversation of the export is there,
  and the next job created over the local socket continues its letter's counter

**Verification:** test — a service test with two temporary instances.

#### AC-017.2 — Refusals

- **Given:** an instance with a database; an instance with only a leftover of a database file; a running daemon; a file
  with a newer job schema; a file with conversation data newer than the running version can read
- **When:** each is imported
- **Then:** each is refused with a message naming the reason, nothing changes, and a daemon started while the import
  runs is refused

**Verification:** test — a service test.

### REQ-021 — Job tools in the front desk

In the front desk (S-001 REQ-021), the daemon SHALL offer these job tools, each naming the job it acts on by its job ID
or short number: `read_job`, `list_jobs`, `create_job`, `update_job`, `add_worklog` and `relate_jobs`, which names
both jobs. The block and complete tools stay with the lead agent and aren't offered there (REQ-013; S-001 REQ-022).

- `list_jobs` returns jobs as `jobs.list` does (REQ-014), filtered by status and origin letter when given.
- `create_job` creates a job as `jobs.create` does (REQ-007), keyed by its tool call id. The job's origin is a
  request whose way in is the way in of the team member's input the front desk is answering, the latest team member
  input it took before the call, so its letter is `C` or `W` (REQ-002). Its origin details name the front desk. It is
  not a follow-up job and is Related to no job.
- `read_job`, `update_job`, `add_worklog` and `relate_jobs` act as `jobs.get`, `jobs.update`, `jobs.worklog.add` and
  `jobs.relate` do (REQ-004, REQ-009, REQ-010), with the front desk's agent, its conversation and seated role, as
  author.

No agent can steer the front desk: only a team member's input, submitted with the way in `command line` or
`web interface`, reaches it, and a submit with any other way in is refused (S-001 REQ-020). So every job the front
desk creates has the letter `C` or `W`. A refused call returns an error result to the agent, and its run goes on.

#### AC-021.1 — A job created through the front desk

- **Given:** the front desk
- **When:** a team member writes "please check why the nightly build is slow" to it over the local socket, its fake
  model calls `create_job`, and the same tool call is repeated
- **Then:** one job `C-n` exists, its request records way in `command line` with the front desk in its origin
  details, it is Related to no job, its lead conversation starts seated as `bob`, and the repeat returns `C-n`; the
  same through the network listener creates `W-n`

**Verification:** test — a service test through both listeners on the fake model.

#### AC-021.2 — Listing jobs from the front desk

- **Given:** jobs in each status with several origin letters
- **When:** the front desk's fake model calls `list_jobs` for status Blocked and letter `E`, and for no filter
- **Then:** each result holds the jobs `jobs.list` returns for the same filter, in the same order

**Verification:** test — a service test on the fake model.

#### AC-021.3 — Edits name the job and the front desk

- **Given:** job `C-7` In progress and job `W-9`
- **When:** the front desk's fake model updates `C-7`'s description, adds a worklog entry to it and relates it to
  `W-9`
- **Then:** `C-7` shows the change, the entry and the Related link, and its history and worklog name the front desk's
  conversation and the role `desk` as author

**Verification:** test — a service test on the fake model.

#### AC-021.4 — Only team members' input reaches the front desk

- **Given:** the front desk, and an agent running in a job's conversation
- **When:** an input is submitted to the front desk in-process with no way in named, and the agent calls `steer`
  naming the front desk
- **Then:** the submit is refused `invalid_input`, the `steer` call returns an error result, the front desk takes
  no run, and no job or number is used

**Verification:** test — a service test on the fake model.

### REQ-022 — The front desk has no job

The front desk SHALL have no job record: it is no conversation of any job, `jobs.list` and the feed's jobs never show
it, and it has no definition of done. The reminder rule (REQ-008) SHALL never apply to it. Completing or cancelling a
job (REQ-007) and the repair rules (REQ-018) SHALL never abort, park, close or change it. A job operation given the
front desk's conversation id where it names a job SHALL be refused `invalid_input` with a message saying the front desk
is not a job conversation (S-001 REQ-025).

#### AC-022.1 — No reminder and no block

- **Given:** the front desk
- **When:** its turn ends with nothing queued and nothing awaited
- **Then:** no reminder is sent to it, no job changes, and no history entry is written

**Verification:** test — a service test on the fake model.

#### AC-022.2 — Repair leaves the front desk alone

- **Given:** a daemon killed while the front desk runs and a Done job still has a running conversation
- **When:** the daemon starts again
- **Then:** repair rule 4 aborts and closes the job's conversation, and the front desk's run resumes and answers its
  input once

**Verification:** test — a service test on the fake model, killing the daemon during both runs.

#### AC-022.3 — Job operations refuse the front desk's id

- **Given:** the front desk
- **When:** `jobs.get`, `jobs.update`, `jobs.worklog.add`, `jobs.resume`, `jobs.complete` and `jobs.cancel` name the
  front desk's conversation id as the job
- **Then:** each is refused `invalid_input` saying the front desk is not a job conversation, and nothing changes

**Verification:** test — a service test.

## Quality Requirements

### REQ-018 — Ordered changes and startup repair

A job change that goes with a change to its conversations SHALL take effect on the job first: a job exists before its
lead conversation starts, is Blocked before the lead conversation parks, and is Done before the conversations are
aborted and closed. Input to a Blocked job's lead reaches the lead conversation first, and the
resume follows it (REQ-006). At startup, after the database opens and before work resumes (S-002 REQ-002 step 7,
amended), the daemon SHALL apply exactly these repair rules, write each repair to the history as one `repair` entry
with the daemon as author (Interfaces), and apply no other recovery to jobs:

1. a job whose start is missing or was cut short gets its start completed: a job that isn't Done and has no lead
   conversation (no conversation records the job as its lead), or a To do job whose lead conversation never got
   its first input, gets its lead conversation started and its first input submitted (S-001 REQ-012 is safe to repeat
   for the same job: it returns the same conversation and submits the first input once); if S-001 REQ-012 refuses the
   start, the job is cancelled as REQ-007 states
2. a Blocked job whose lead conversation isn't parked gets it parked
3. a job that isn't Done whose lead conversation holds input it hasn't taken since the job blocked (queued input, or
   held messages), or has taken input since the job blocked, is set In progress if it is still Blocked, with the Blocked
   reason cleared, and the lead continues with that input
4. a Done job with a conversation that isn't closed, or that is closed but still has an unfinished run, a running
   compaction or queued input, gets it closed and aborted: as one step it is marked closed, stops being parked or
   awaiting reports, and loses its held messages and queued input; it and any compaction still running in it are then
   aborted (S-001 REQ-026)

Rule 3 is applied before rule 2. After the repair rules, the daemon checks REQ-008's rule for each
In progress job whose lead is idle and waits for nothing; this is REQ-008 applied to saved state, not a repair rule.

#### AC-018.1 — One crash per rule

- **Given:** for each rule, a daemon killed in the middle of the job change that rule repairs, including a lead that
  took an answer after it stopped being parked, before the job resumed, and a daemon killed after a conversation is
  marked closed and before its abort, and a daemon killed in a lead's complete tool, after it is marked closed and
  before its tool round ends
- **When:** the daemon starts again
- **Then:** before any listener answers a call other than `daemon.status`, the job and its conversations are in the
  state the rule names, and the history records the repair; for the killed complete tool, that run's input settles
  `unanswered` with reason `aborted`, and the model gets no further request

**Verification:** test — one deterministic service test per rule, injecting the crash between the two writes.

#### AC-018.2 — A start cut short before its first input

- **Given:** a daemon killed after a job's lead conversation is created and before its first input is submitted, so the
  job is To do with a lead conversation and no agent working on it
- **When:** the daemon starts again
- **Then:** before any listener answers a call other than `daemon.status`, rule 1 has submitted the first input to
  that same lead conversation and the history records the repair; the job has one lead conversation, its transcript
  holds the first input once, and a further start repairs nothing

**Verification:** test — a deterministic service test, injecting the crash between the creation of the lead
conversation and the submission of its first input.

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
handled as S-002 REQ-007 handles a storage failure.

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
- **A run ends at a model turn only if every call asks.** Confirmed in the pinned pi-durable 1.4.0: `control.terminate`
  ends a run only when every call of the model turn asks for it, including calls answered without a task, which is why
  the complete tool must be alone. An upgrade that changes this needs a review of REQ-007.
- **ADR-004, amended with this spec.** Decision 5 gains entry kinds for the text of `jobs.resume`, the default resume
  note and the reminder (REQ-006, REQ-008), each carrying its actor. The Architect amends ADR-004 before the task
  breakdown passes Gate 2.
- **S-000 amendment.** The job record keeps its own format in tables of its own, which each version migrates forward;
  export and import copy the whole saved state for backups, moving to another computer and upgrades, and don't
  convert it (Solution overview, Jobs, Project exclusions; REQ-001, REQ-016, REQ-017).
- **S-001 amendments.** The job tools are part of every role like the coordination capabilities (REQ-003, REQ-005);
  block and complete are lead-only; the lead's system prompt states the first duty (REQ-008); a lead's turn end is
  observable for the reminder rule; the daemon is an actor for input it sends under a job's rules (REQ-007); a message
  sent to a lead conversation parked because its job is Blocked continues it (REQ-014, REQ-020); the Job definition
  names this spec's fields; `jobs.startLead` is in-process only, called by `jobs.create`; a job with letter `A` is
  S-001's follow-up job source.
- **S-002 amendments.** The job operations replace `jobs.startLead` in the catalogue, and creating a job records the
  origin (REQ-012); startup step 4 reads the job schema version and opens the job store and step 7 runs the repair
  before resuming work (REQ-002); the instance scope of the feed carries the job deltas in its sequence (REQ-014); the
  `in-process` way in, recorded when a caller names none (AC-012.5), is refused by `jobs.create` (REQ-002); a team
  member's request records the details its way in observes (REQ-012, REQ-013); a job store write failure is handled
  as a storage error (REQ-007); a held message waits only for a conversation parked for reports (REQ-012). ADR-001
  decision 4 names job writes and repair as its second bounded exception, and decision 1 names the import step.
- **S-003 amendment.** Each listener passes its observed caller details with the way in (REQ-007): none beyond the way
  in on the local socket, and on the network listener the TCP peer's remote address and port, never a header such as
  `X-Forwarded-For`. The `jobs.startLead` mentions in S-003 AC-007.2 move to `jobs.create`.
- **S-001 v0.8, the front desk.** S-001 REQ-021 to REQ-025 define the front desk, the one standing conversation of
  an instance that belongs to no job, its `desk` role and its tools; this spec's REQ-021 and REQ-022 define the job
  tools it carries and keep it out of the job rules. The command-line spec (`bob chat`) and the Web interface spec
  present it.
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
4. Each crash test of REQ-018 ends with job and conversations in step before the first listener call (REQ-018).
5. An export taken while jobs run imports on a second instance with every job, worklog entry, history entry and
   conversation present (REQ-016, REQ-017).
6. Every job operation answers through both listeners as it does in-process (REQ-012).
7. A job created through the front desk from the command line is `C-n` and one from the web interface is `W-n`, each
   with the front desk in its origin details, and no reminder, action or repair ever changes the front desk (REQ-021,
   REQ-022). Measured by `npm test`.

## Implementation Order

| Phase | Outcome | Depends on |
|---|---|---|
| 1 | The job store: tables, migrations, counters and short numbers; `jobs.create` (starting the lead conversation in-process), `jobs.get`, `jobs.list`, `jobs.update`, the worklog, the history and Related | S-001, S-002, S-003 delivered |
| 2 | The lifecycle: the action table, blocking and resuming, completing and cancelling, the reminder rule, the job tools in every role and the lead's first duty | Phase 1 |
| 3 | Ordered writes and the four repair rules, the ADR-001 amendment in code, and the job feed events | Phase 2 |
| 4 | Observed origin details through both listeners and `statedBy` | Phase 1, S-003 amendment |
| 5 | Export and import, the reference timings, the live check, and the docs (developer architecture, user manual, spec map) | Phases 1–4 |
| 6 | The job tools in the front desk, `list_jobs`, and keeping the front desk out of the job rules | Phase 5, S-001 phase 6 |

## Open Questions

None.

## Amendment Log

| Date | What changed | Why | Affected tasks |
|------|-------------|-----|----------------|
| 2026-11-02 | REQ-007 and AC-007.2: `jobs.create` checks the role and overrides first and refuses a bad one with no job and no number, then writes the job and starts the lead; a start still refused after the write cancels the job (new AC-007.5); an optional `idempotencyKey` returns the original job, and the create job tool keys each call by its tool call id (new AC-007.4); a lead completing through its tool has its own run aborted at that call. REQ-018: the ordering names each write and its pi-durable change; rule 1 covers a job that isn't Done with no conversation recording it as its lead, and cancels the job when the start is refused; rule 3 covers input the lead hasn't taken since the job blocked and is applied before rule 2. REQ-008: the first duty includes checking the result against the definition of done and stating the evidence; whether a reminder is spent survives a restart, and the rule is checked at startup for each idle In progress job after the repair rules (new AC-008.4). REQ-005: the start is written when the lead's first run takes a worker thread; complete aborts the lead's own run. REQ-006: any input while the job is Blocked resumes it, parked or not; an invoked agent's report is no longer listed. REQ-003, AC-003.1, AC-003.2 and the `jobs.create` input: no OS account on the local socket; Email is a way in that passes the message ID and sender it observes; `origin` is refused from any caller but a job source. REQ-001: the job schema version is read before pi-durable opens the database. REQ-016 and AC-016.1: the export is owner-only and holds the database only. REQ-017 and AC-017.2: the import holds the single-owner lock, refuses leftover `-wal` and `-shm` files and a newer pi-durable schema, and creates the database owner-only. AC-013.1: the coordination tools are offered too. The term "Agent-created job" became "Follow-up job" (Definitions, REQ-002, REQ-003, REQ-009, job tools). Interfaces: `leadConversation` is read from the conversation that records the job as its lead. Users and Journeys, Workflow, Assumptions and Dependencies (S-000, S-001, S-002, S-003 amendments, ADR-004) follow. Version 0.2. | S-004 architecture consistency review (findings F1 to F18); product owner decisions 2026-11-02: F13 option A, the S-000 amendment, the OS account dropped. Driving ADRs: ADR-001, amended 2026-11-02 for the job store; ADR-004, to be amended for the new entry kinds. | None; S-004 isn't broken down yet |
| 2026-11-02 | v0.3. AC-015.1 and the feed events table: the start publishes "status changed" like any status change, so the lifecycle has three; a change to Done publishes "job done" instead. Definitions (History), Interfaces (history entry, author), REQ-011 and REQ-018: each repair writes one `repair` history entry naming the rule and what it did; the daemon authors a resume on input and the cancel after a refused start. | Gate 2 review of the S-004 task plan (questions on T-128 and T-129). | T-128, T-129 |
| 2026-11-02 | v0.4. REQ-006: the block records the ID of the lead conversation's newest transcript entry at the time of the block. REQ-018: rule 3 also covers a lead that has taken input since the job blocked, shown by an input entry in its transcript after the entry the block recorded; an input entry is a `pi.user` entry or an input entry kind the daemon submits (the steer record and the ADR-004 kinds). AC-018.1: the crash cases include a lead that took an answer after the park was cleared, before the resume was written. Interfaces: the job's internal `blockedAfterEntry`, set by the block and cleared by the resume in the same write, not returned by `jobs.get` and not recorded in the history. | T-129 F1 escalation; Architect escalation review; product owner decision 2026-11-02 (option A); ADR-001 decision 4 amended. | T-143, T-129, T-136 |
| 2026-11-02 | v0.5. REQ-018 rule 1: it also fires for a To do job whose lead conversation holds no submission with request id `lead:<jobId>`, and completes the start, reusing request-id deduplication so the first input goes in once; creating the lead conversation and submitting its first input are two pi-durable commits. New AC-018.2 for a crash between them. Workflow and Success Criteria 4 follow. Exclusions: "sub-tasks" became "sub-jobs". | PR 147 review, finding 4: a crash after the lead conversation is created and before its first input leaves the job To do with no agent working on it, which rule 1 didn't catch. pi-durable can't submit input in the creation commit. Product owner decision 2026-11-02 (option A); ADR-001 decision 4 amended. | T-144 |
| 2026-11-03 | v0.6. The front desk (S-001 v0.8). New REQ-021: in the front desk the job tools name their job, block and complete aren't offered, a new `list_jobs` lists jobs as `jobs.list` does, and `create_job` makes a job whose origin is the way in of the team member's input being answered (`C` or `W`) with the front desk in its origin details (AC-021.1 to AC-021.4). New REQ-022: the front desk has no job record; the reminder rule, complete, cancel and the repair rules never touch it; a job operation given its conversation id is refused as not a job conversation (AC-022.1 to AC-022.3). Architecture consistency review (finding F7, product owner decision), same version: REQ-021 and AC-021.4, no agent steers the front desk and only a team member's input with way in `command line` or `web interface` reaches it, so its jobs are always `C` or `W`. REQ-002 and REQ-003: the letter and origin of a job created through the front desk. REQ-008, REQ-007 and REQ-013 point to REQ-022 and REQ-021. Definitions, Users and Journeys (journey 8), Exclusions, Interfaces (the job tools in the front desk, the refusal of its conversation id, Consumed), Workflow, Assumptions, Success Criteria 7 and Implementation Order phase 6 follow. | Product owner decisions of the front desk brainstorm, 2026-11-03. | None yet; the front desk comes in the breakdown of this amendment |
| 2026-11-03 | v0.7. Closed conversations (S-001 v0.9 REQ-026). REQ-005 and REQ-007: complete and cancel also close every conversation of the job, idle ones included, so input to a Done job's lead is refused `conflict`; AC-007.3 checks the conversations are closed. REQ-018: a complete or cancel is written before the conversations are aborted and closed, and repair rule 4 closes each conversation of a Done job that isn't closed, aborting it first if it still runs, is parked or is awaited. REQ-022 and AC-022.2: the front desk is never closed. Exclusions, Workflow and Consumed follow. Architecture consistency review (findings F1, F12, F13 and F15), same version: REQ-018 rule 4 also covers a closed conversation that still has an unfinished run or queued input, in one commit that sets its closed mark, clears `parked` and empties `awaiting` and `held`, then pi-durable's abort; AC-018.1 adds a crash between that commit and the abort; rule 3 applies only to a job that isn't Done; REQ-007, from the complete or cancel input to the job's conversations is refused as S-001 REQ-026 states, a lead start refused because the job is already Done doesn't cancel it again, a job completed or cancelled before its lead conversation is created gets none, and one completed or cancelled before the first input keeps a closed lead conversation with no first input (S-001 AC-026.7, AC-026.8). Long lines rewrapped. | Product owner decision of 2026-11-03, during the S-005 dev-loop (T-166): a Done job's conversations close and are kept only as the history of the work. Architecture consistency review of the amendment, 2026-11-03; ADR-001 decision 4 amended with it. | T-166 (blocked on it); T-186 to T-196 (Gate 2 passed 2026-11-03; the amendment merged into `dev-pi-durable-s005` before the preflight, by the product owner's approval of the in-flight amendment) |
| 2026-11-03 | v0.7, same version. REQ-009, AC-003.3, the create job tool, journey 5 and the Exclusion on reopening: a follow-up job is Related to the job it came from only when the agent's create job call sets the optional `related` flag; the agent decides each time. Its origin names the conversation it came from either way. | Product owner decision of 2026-11-03 (finding F9 of the S-001 v0.9 consistency review): relating a follow-up job is the agent's choice in the moment, not a hard requirement. | The job tools (`src/jobs/job_tools_extension.ts`), a new task |
| 2026-11-04 | v0.8. REQ-007 and the REQ-005 table: the lead's complete tool records its result and ends its own run at that call with no further model turn, instead of being aborted, and it must be the only tool call of its model turn; once the complete is written, a later failed step of the abort doesn't stop the run ending, and rule 4 finishes it; a refused complete tool ends nothing. REQ-018 rule 4: the closing commit also empties the pi-durable inbox, a running compaction also fires the rule and is aborted. AC-018.1. New AC-005.5 to AC-005.7. Workflow, the job tools table and Assumptions follow. | Product owner decision of 2026-11-04 (B-006 and the misleading `tool complete_job failed` line). Architecture consistency review, findings F1 to F7. | T-197, T-198, T-199, T-200, T-201 |
| 2026-11-04 | v0.9. REQ-007: when the lead's closed mark doesn't land after the complete write, the daemon aborts the lead's run with pi-durable's abort, so a queued input can't run a model turn on the Done job, and the tool's result records the abort; in every other case the result is not an error. The job's other conversations are aborted even when the close failed. The same failure on a team member's `jobs.complete` or `jobs.cancel` fails with `internal` and is a known exception (S-001 REQ-026, B-010). New AC-005.8. | Product owner decision of 2026-11-04: T-198 finding F1, a queued follow-up ran a third model request on a Done job when the close failed without a storage error. | T-198 |
| 2026-11-05 | Same version, format only; no requirement changed. Restructured to the ai-team 0.19.0 spec layout: `## Architecture` is gone and `## Alternatives Considered` is a top-level section holding solution alternatives only. The design principles are dropped: each is a requirement, its rationale or an implementation constraint already recorded elsewhere. The two storage alternatives moved to `docs/development/architecture.md`; ADR-001 Alternative G also records the first. Assumptions, the S-002 amendments item: it cites ADR-001 decisions 1 and 4 in place of the removed S-002 principles. | ai-team 0.20.0 upgrade; specs say what, the architecture documents and ADRs say how | T-185 |
| 2026-11-05 | v0.10. No behaviour changes (CR-001): technology and implementation words leave the requirement text, and each REQ keeps its guarantee. Changed: REQ-001, AC-001.1 (`SQLite`, `intern_`; the Verification line reads the tables directly), REQ-002, AC-005.8, REQ-006, REQ-007, AC-007.4, REQ-008, REQ-011, REQ-012, AC-012.1, REQ-016, REQ-017, AC-017.2, REQ-018, AC-018.1, AC-018.2, REQ-020, with the copies in Purpose, Definitions, Users, Interfaces (`blockedAfterEntry`, `jobs.startLead`), Workflow, Assumptions and Implementation Order. REQ-018 rule numbers stay. Moved statements live in ADR-001 decisions 1 and 4. No identifier added or retired. | CR-001, approved by the product owner. | None; spec text only |
