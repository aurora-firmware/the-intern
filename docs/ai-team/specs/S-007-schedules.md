---
id: S-007
title: Schedules
version: '0.2'
status: approved  # draft | review | approved | superseded
created: '2026-11-07'
author: planner
---

# Schedules

## Purpose

This spec covers S-000's **Schedules** component, named "Schedules and triggers" until this spec's amendment of S-000.
Today a job starts only when a team member or an agent creates one, so recurring work such as a nightly check depends on
someone remembering it. The job record (S-004), the lead conversation a job source starts (S-001 REQ-012, REQ-013) and
the reserved `bob schedules` group (S-005) already wait for a spec that says when jobs start on their own. When it is
done, a team member keeps schedule entries in one file and manages them from the command line, the web interface or the
front desk; each due time starts a fresh job with nobody present; and every scheduled run and skipped fire can be read
afterwards. The product owner also ruled that no job starts on an event: agents create jobs while they run, Email is an
input that an agent triages, and a Done job starts nothing. This spec therefore removes triggers from the product.

## Definitions

This spec uses the Definitions of S-001 to S-006 (team member, job, short number, origin, request, status, resolution,
role, seat, workspace, front desk, service operation, observation feed, page, way in) and the shared vocabulary of
`docs/system_overview.html`. It adds these terms:

| Term | Meaning in this spec |
|---|---|
| Schedule entry | One recurring piece of work: a name, a cron expression, a request and optional seat values (REQ-001). |
| Due time | A minute that an entry's cron expression matches, in the machine's local time (REQ-005). |
| Fire | The moment the daemon acts on a due time. A fire creates a job or records a skip (REQ-004, REQ-006). |
| Fire time | The time a scheduled run records in its origin: its due time, or for a run on demand the moment it started (REQ-004, REQ-008). |
| Scheduled run | A job a schedule entry started, by a fire or by run now. Its short number has the origin letter `S`. This is not an agent run. |
| Run now | A team member's request to start a scheduled run of an entry at once (REQ-008). A job started this way is a run on demand. |
| Skipped fire | A fire that created no job, recorded with its due time and reason (REQ-006). |
| Open scheduled run | A scheduled run whose status is To do or In progress. A Blocked or Done one is not open. |
| Run history | An entry's scheduled runs and skipped fires, newest first (REQ-009). |

## Users and Journeys

| Actor | Goal |
|---|---|
| Team member | Sets up recurring work, runs it on demand, and checks what ran and what was skipped. |
| Agent in a scheduled job | Knows it is working on a scheduled run and looks at earlier scheduled runs when that helps. |
| Front desk | Sets up and runs schedule entries when a team member asks in chat. |
| Email spec (downstream, optional) | A schedule entry can ask an agent to check mail. Neither depends on the other, and Email reports no events to this spec. |
| Developer | Tests every fire and skip against a controllable clock and the fake model. |

Journeys, in priority order:

1. **Set it up.** A team member adds an entry with `bob schedules create`, on the Schedules page, by editing
   `config.toml` or by telling the front desk "every night, check that the backups ran". Delivered by REQ-001, REQ-002,
   REQ-003, REQ-011, REQ-012, REQ-013.
2. **It runs unattended.** At each due time the daemon starts a fresh job, which runs and ends like any other job. An
   agent that finds separate work creates a follow-up job. Delivered by REQ-004, REQ-005, REQ-016.
3. **It looks back when it needs to.** The lead is told this is a scheduled run of a named entry and that earlier
   scheduled runs can be read. It sees how each ended and opens any of them for detail. Delivered by REQ-009, REQ-010.
4. **It doesn't pile up.** A fire is skipped while the entry has an open scheduled run or the workspace folder is gone.
   Missed due times are not caught up. Delivered by REQ-006, REQ-007.
5. **Run it now.** A team member starts a scheduled run on demand. Delivered by REQ-008.
6. **Check on it.** A team member sees each entry's next due time, recent scheduled runs and skipped fires with the
   reason. Delivered by REQ-009, REQ-011, REQ-012.

## Exclusions

- **Triggers and any event-started job.** A job ending or mail arriving starts nothing by itself. Product owner ruling,
  2026-11-07: agents create the jobs they find need for, and REQ-014 removes triggers from the product.
- **Catching up on missed scheduled runs.** S-000 excludes it.
- **Records of fires missed while the daemon was down.** A missed due time shows no scheduled run and no skipped fire,
  to keep startup free of that calculation (REQ-007).
- **Automatic retries.** A scheduled run that ends cancelled isn't run again until the next due time. An agent or a team
  member can create a job if more is needed.
- **Notices about skipped fires or failed scheduled runs.** They show in the run history and on the page, and nobody is
  told. Sending notices belongs to Email.
- **One-off runs at a future time.** Entries recur, and run now covers doing it at once.
- **Chaining entries.** An agent in one scheduled run can create a job for the next piece of work.
- **Pausing an entry.** A team member removes it and adds it again later, and its history continues (REQ-003).
- **Renaming an entry.** The name ties the entry to its history (REQ-001).
- **A time zone per entry.** Every entry uses the machine's local time (REQ-005).
- **Tools that change schedules for agents other than the front desk.** Every agent of a job can read schedule runs
  (REQ-010). A lead can still run `bob schedules` from its shell, because the service account is the boundary (ADR-002).
- **Deleting old run history.** Retention of old jobs is an open item across specs, and run history follows it.
- **What Email does with mail.** The Email spec owns it.

## Alternatives Considered

- **Keep triggers with two kinds, job done and mail arriving.** Rejected by the product owner: agents create jobs during
  their runs, Email is an input an agent triages, and a Done job is finished.
- **Named events reported by a command, an agent tool or a script.** Rejected: an agent that finds a failed check
  creates a follow-up job, and outside tools can call `bob jobs create`.
- **Schedules now, triggers in a later spec.** Rejected: no later need for triggers remains.
- **Definitions in the database, through commands only.** Rejected by the product owner: a file can be read, versioned
  and copied, and it matches how roles are kept.
- **A reload command for hand edits.** Rejected: S-002 already rules that a hand edit takes effect at the next restart,
  and entries follow the same rule as the rest of the file.
- **A bad entry skipped at startup and flagged on the page.** Rejected: it would be an exception to S-002's rule for the
  file. One rule for the whole file is simpler.
- **A choice per entry between fresh scheduled runs and the history of the last N runs.** Rejected by the product owner:
  every scheduled run starts fresh, and the agent reads earlier scheduled runs when it needs them.
- **Pasting a summary or the worklogs of earlier scheduled runs into the new job's request.** Rejected by the product
  owner: it fills the context on every scheduled run, and the agent can look up what it needs.
- **A Blocked scheduled run holding back the next fire.** Rejected by the product owner: the check keeps running even
  when nobody answers.
- **Role only, or role and workspace only, per entry.** Rejected by the product owner: an entry can name the same seat
  values a team member can give `jobs.create`, which S-001 left open for this spec.
- **Commands and page without front desk tools, or commands only.** Rejected by the product owner: handing work over
  easily is a problem S-000 removes, and the front desk has no shell to fall back on.
- **Recording fires missed while the daemon was down.** Rejected: S-000 only asks that they are skipped.

## Interfaces

### Exposed: the configuration file

**Contract** (the section an entry takes in `config.toml`, S-002 REQ-021; a section per entry, in any order):

```toml
[[schedule]]
name = "nightly-backups"            # required
cron = "0 2 * * *"                  # required
request = "Check that last night's backups ran and the services on the network answer."  # required
role = "ops"                        # optional
model = "provider/model"            # optional
thinking_level = "low"              # optional
workspace = "/srv/infra"            # optional, an absolute path
```

Unknown keys are refused, as for the rest of the file. REQ-001 gives each key's rules.

### Exposed: service operations

All are reachable through both listeners at `POST /operations/<name>` (S-003 REQ-003), and the client library gains them
with no listener change. Each returns S-002's errors. An entry is named by its `name`.

| Operation | Kind | Input | Result | Requirement |
|---|---|---|---|---|
| `schedules.list` | read | none | every entry with its values, next due time and latest scheduled run | REQ-009 |
| `schedules.get` | read | `name` | the entry with its values and next due time; `not_found` | REQ-009 |
| `schedules.runs` | read | `name`, `limit`, `cursor` | the run history, newest first; works for a removed entry that has history; `not_found` when it has none and no entry | REQ-009 |
| `schedules.create` | control | `name`, `cron`, `request`, optional `role`, `model`, `thinkingLevel`, `workspace`, `idempotencyKey` | the new entry; `invalid_input`, `conflict` | REQ-001, REQ-003 |
| `schedules.change` | control | `name` and the values to change; an optional value can be cleared | the entry; `not_found`, `invalid_input`, `conflict` | REQ-001, REQ-003 |
| `schedules.remove` | control | `name` | nothing; `not_found`, `conflict` | REQ-003 |
| `schedules.run` | control | `name`, `idempotencyKey` | the new job; `not_found`, `busy`, `invalid_input` | REQ-008 |

A scheduled run in `schedules.runs` carries its short number, fire time, whether it was run on demand, status, and
resolution with justification once Done. A skipped fire carries its due time, its reason and, for an open scheduled run,
that job's short number. A team member's or an agent's `jobs.create` still can't name a schedule origin (S-002
AC-012.5).

`jobs.list` gains a filter by schedule entry (REQ-009).

### Exposed: feed events

The instance scope of the observation feed (S-002 REQ-014) carries:

| Delta | Carries |
|---|---|
| `settings_changed` (existing, S-002 REQ-022) | that schedule entries changed |
| job created (existing, S-004 REQ-015) | a scheduled run, with its origin |
| schedule fire skipped | the entry name, the due time, the reason and any open scheduled run's short number |

### Exposed: the `bob schedules` commands

These follow S-005's conventions: `--json`, exit codes, and short numbers in any letter case.

| Command | Operations called | Requirement |
|---|---|---|
| `bob schedules list` | `schedules.list` | REQ-011 |
| `bob schedules show <name>` | `schedules.get`, `schedules.runs` | REQ-011 |
| `bob schedules create <name>` | `schedules.create`, with `--cron`, `--request` and the optional seat values | REQ-011 |
| `bob schedules change <name>` | `schedules.change` | REQ-011 |
| `bob schedules remove <name>` | `schedules.remove` | REQ-011 |
| `bob schedules run <name>` | `schedules.run` | REQ-011 |
| `bob jobs list --schedule <name>` | `jobs.list` with the schedule entry filter | REQ-011 |

### Exposed: the Schedules page

A new page in S-006's sidebar at `/ui/#/schedules` (REQ-012). S-006's Users row lets later specs add pages, so S-006
itself doesn't change. The page calls only these:

| Page | Reads and feed | Actions |
|---|---|---|
| Schedules | `schedules.list`, `schedules.get`, `schedules.runs`, the instance feed | `schedules.create`, `schedules.change`, `schedules.remove`, `schedules.run` |

The Job page of a scheduled run shows the entry, the fire time and whether it was run on demand.

### Exposed: tools

| Tool | Offered to | Does |
|---|---|---|
| read schedule runs | every agent of a job, and the front desk | returns an entry's run history as `schedules.runs` does (REQ-010) |
| list, create, change, remove and run schedules | the front desk only | act as the matching operations; a call with the same tool call id acts once (REQ-013) |

Tool names and parameter layouts are not contract; the tasks fix them, as in S-004.

### Consumed

- S-001: starting a lead conversation with a role, overrides and origin (REQ-012, REQ-013); the refusals for a role or
  workspace an entry names (REQ-003, REQ-018); the front-desk tools (REQ-022).
- S-002: the configuration file and its settings operations (REQ-021, REQ-022); startup step 8, which starts the
  scheduler (REQ-002); idempotency keys and the error outcomes (REQ-013).
- S-003: the routes for every operation and the way in each listener stamps (REQ-003, REQ-007).
- S-004: `jobs.create` with a schedule origin, the origin letter `S`, `jobs.list`, the job tools and job deltas.
- S-005: the `schedules` group name it held for this spec, and the conventions of every group.
- S-006: the sidebar, the style, and the rules for refusals, lost connections and browsers.

## Workflow

```text
Team member adds an entry: command, page, front desk or hand edit                            REQ-001, REQ-002, REQ-003
  (invalid → refused, nothing changes; hand edit → the next start refuses)                   REQ-001, REQ-002
  (file changed on disk since last read → refused as a conflict)                             REQ-003
Daemon ready → fires begin                                                                   REQ-007
Due time arrives, in local time                                                              REQ-005
  (clocks repeat the time → once; time doesn't exist that day → no fire)                     REQ-005
  (daemon stopped, machine off or a long sleep → no fire, no record)                          REQ-007
  (entry has an open scheduled run → skipped fire naming the scheduled run)                  REQ-006
  (workspace folder missing, or job refused → skipped fire with the reason)                  REQ-006
Job S-n created with a fresh lead conversation and the entry's seat values                   REQ-004
  (crash and restart → no second job for that due time)                                      REQ-016
Lead is told it is a scheduled run of the entry and that earlier scheduled runs can be read  REQ-010
Job runs and ends as any job; its end starts nothing                                         REQ-014
Team member reads the run history; run now at any time                                       REQ-008, REQ-009
  (run now with an open scheduled run → refused busy, nothing recorded)                      REQ-008
```

## Behavioral Requirements

### REQ-001 — A schedule entry

A schedule entry SHALL have these values, and the daemon SHALL refuse an entry that breaks any rule, with a message
naming the entry, the key and the reason:

- `name`: required and unique in the instance, 1 to 64 characters of letters, digits and hyphens, starting with a letter
  or digit. A name is compared case-sensitively and can't be changed.
- `cron`: required, a valid cron expression of five fields that can come due (REQ-005). One that can never be due, such
  as `0 0 31 2 *`, is not valid.
- `request`: required, non-empty text.
- `role`: optional, an existing role. Missing means `bob` (S-001 REQ-012).
- `model`, `thinking_level`: optional, as `jobs.create` accepts them (S-004). Missing means the role's default.
- `workspace`: optional, the absolute path of a registered workspace. Missing means the role's default.

A taken name SHALL be refused `conflict`, and every other broken rule `invalid_input`. `schedules.create` and
`schedules.change` SHALL also refuse a `model` that isn't available at that moment, or a `thinking_level` it doesn't
support. The check at startup leaves out model availability, because the list of models changes outside the file, and
checks only that the thinking level is a known one (REQ-006 covers a model that is gone at a fire).

#### AC-001.1 — Refused values

- **Given:** a running daemon with no entries
- **When:** a team member calls `schedules.create` with, in turn, a name with a space, `cron = "not cron"`, `cron = "0 0
  31 2 *"`, an empty
  request, an unknown role, an unregistered workspace, an unknown model and an invalid thinking level
- **Then:** each call is refused `invalid_input` naming the key, the file is unchanged, and no entry exists

**Verification:** test — `test/service/schedule_operations.test.ts`.

#### AC-001.2 — Optional values fall back

- **Given:** an entry with only `name`, `cron` and `request`
- **When:** it fires
- **Then:** the lead is seated as `bob` with that role's default model, thinking level and workspace

**Verification:** test — `test/service/schedule_fires.test.ts`.

#### AC-001.3 — A taken name

- **Given:** an entry named `nightly-backups`
- **When:** a team member calls `schedules.create` with that name
- **Then:** the call is refused `conflict` naming the entry, and the file is unchanged

**Verification:** test — `test/service/schedule_operations.test.ts`.

### REQ-002 — Entries live in the configuration file

The configuration file SHALL hold schedule entries as `[[schedule]]` sections (Interfaces). It stays the single source
of truth (S-002 REQ-022). A hand edit SHALL take effect at the next restart. An invalid entry SHALL stop startup with an
error naming the file, the entry and the reason, as any invalid value does (S-002 REQ-021). An entry that names an
unavailable model is not invalid at startup, and its thinking level only has to be a known one.

#### AC-002.1 — A hand edit at the next restart

- **Given:** a stopped daemon and a hand-written valid `[[schedule]]` section
- **When:** the daemon starts
- **Then:** `schedules.list` shows the entry with its next due time

**Verification:** test — `test/service/schedule_operations.test.ts`.

#### AC-002.2 — A bad hand edit stops startup

- **Given:** a `[[schedule]]` section with each of a bad cron, an unknown role, an unregistered workspace and an unknown
  key
- **When:** the daemon starts
- **Then:** it exits with an error naming the entry and the reason, and creates no job

**Verification:** test — `test/service/schedule_operations.test.ts`.

#### AC-002.3 — An unavailable model doesn't stop startup

- **Given:** a `[[schedule]]` section naming a model that isn't available
- **When:** the daemon starts
- **Then:** it reports ready, and the entry is listed

**Verification:** test — `test/service/schedule_operations.test.ts`.

### REQ-003 — Adding, changing and removing entries

A valid `schedules.create`, `schedules.change` or `schedules.remove` SHALL be written to the configuration file first,
atomically and owner-only, and apply at once, as S-002 REQ-022 states for settings. If the file changed on disk since
the daemon last read it, the call SHALL be refused `conflict`, naming the file, and nothing changes.

A change SHALL affect only later fires and scheduled runs, and a running job keeps its seat. Removing an entry SHALL
leave its jobs and history in place, stop its fires and leave any running job to carry on. Adding an entry with a name
that has history SHALL continue that history, and the open scheduled run rule of REQ-006 counts those earlier scheduled
runs.

Removing a role that an entry names, or whose default workspace an entry names, SHALL be refused (S-001 REQ-003), and
unregistering a workspace that an entry names
SHALL be refused, each naming the entry.

#### AC-003.1 — A change applies at once and survives a restart

- **Given:** an entry due daily at 02:00
- **When:** a team member changes it to 03:00 and the daemon then restarts
- **Then:** the next due time is 03:00 at once and after the restart, and the file holds the new value

**Verification:** test — `test/service/schedule_operations.test.ts`.

#### AC-003.2 — A conflict with a hand edit

- **Given:** a running daemon and a hand edit of the file since it last read it
- **When:** a team member calls `schedules.create`
- **Then:** the call is refused `conflict` naming the file, and the file stays as the hand edit left it

**Verification:** test — `test/service/schedule_operations.test.ts`.

#### AC-003.3 — Removal keeps history and running work

- **Given:** an entry with a Done scheduled run and an In progress scheduled run
- **When:** a team member removes it, the running job ends, and later someone adds the same name again
- **Then:** no fire happens while it is removed, the job ends normally, `schedules.runs` shows both scheduled runs
  throughout, and the entry's new fires add to that history

**Verification:** test — `test/service/schedule_fires.test.ts`.

#### AC-003.4 — An entry holds what it names

- **Given:** an entry naming the team role `ops` and the workspace `/srv/infra`, and an entry naming the default
  workspace of the team role `docs`
- **When:** a team member removes `ops`, unregisters `/srv/infra` and removes `docs`
- **Then:** all three are refused, each naming the entry, and nothing changes

**Verification:** test — `test/service/schedule_operations.test.ts`.

### REQ-004 — A fire starts a fresh job

When an entry comes due and no skip rule applies, the daemon SHALL create one new job with a new lead conversation
(S-001 REQ-013), which:

- has the entry's request exactly as its Request text
- has a short number with the origin letter `S`
- records in its origin the entry name and the fire time, here the due time (S-004 REQ-003)
- seats the lead with the entry's role, model, thinking level and workspace, falling back as REQ-001 states
- carries nothing from earlier scheduled runs in its request or conversation

#### AC-004.1 — A due entry starts a job

- **Given:** an entry due at 02:00 with no earlier scheduled run, and a controllable clock
- **When:** the clock reaches 02:00
- **Then:** exactly one job `S-n` exists, its Request text is the entry's request, its origin names the entry and 02:00,
  and its lead conversation holds no earlier scheduled run's content

**Verification:** test — `test/service/schedule_fires.test.ts`.

#### AC-004.2 — The entry's seat values

- **Given:** an entry naming a role, a model, a thinking level and a workspace
- **When:** it fires
- **Then:** the lead's seat has those four values, and the job source is the seat actor (S-001 AC-012.2)

**Verification:** test — `test/service/schedule_fires.test.ts`.

### REQ-005 — Time

The `cron` value SHALL be five space-separated fields: minute, hour, day of month, month and day of week. Each field
SHALL accept `*`, numbers, lists (`,`), ranges (`-`) and steps (`/`). Day of week accepts 0 to 7, where 0 and 7 are
Sunday. When both day fields are restricted, a time matching either is due. Every entry SHALL use the machine's local
time zone.

When a clock change repeats a local time, that time SHALL be due once. When a clock change means a local time doesn't
exist that day, that time SHALL NOT fire.

#### AC-005.1 — Next due times

- **Given:** the entries `0 2 * * *`, `*/15 9-17 * * 1-5` and `0 0 1 * 0`
- **When:** `schedules.list` is read at a known time
- **Then:** each next due time follows the rules above, in local time

**Verification:** test — `test/unit/schedule_time.test.ts`.

#### AC-005.2 — Clock changes

- **Given:** a time zone with a clock change, an entry due in the repeated hour, and an entry due in the hour that
  doesn't exist
- **When:** a controllable clock passes each change
- **Then:** the first entry fires once and the second doesn't fire that day

**Verification:** test — `test/unit/schedule_time.test.ts`.

### REQ-006 — Skipped fires

A fire SHALL create no job and record a skipped fire when any of these holds:

- the entry has an open scheduled run. The reason names the scheduled run's short number. A job waiting for a worker
  thread counts as open. A Blocked or Done scheduled run doesn't stop a fire.
- the folder of the seat's workspace no longer exists. The reason names the folder.
- the job is refused, for example because the entry's model is no longer available. The reason names the refusal.

A refusal after the job is written follows S-004 REQ-007: the job is cancelled and appears as a cancelled scheduled run,
not a skipped fire. A skipped fire SHALL publish the schedule fire skipped delta. The check for an open scheduled run
and the creation of the job SHALL happen as one step, so two starts of one entry can't both pass the check.

#### AC-006.1 — An open scheduled run skips the fire

- **Given:** an entry whose scheduled run `S-11` is In progress, and in a second case To do while it waits for a worker
  thread
- **When:** the entry's next due time arrives
- **Then:** no job is created, and the run history shows a skipped fire with that due time and `S-11`

**Verification:** test — `test/service/schedule_fires.test.ts`.

#### AC-006.2 — A Blocked scheduled run doesn't stop a fire

- **Given:** an entry whose scheduled run `S-11` is Blocked, and no other open scheduled run
- **When:** the entry's next due time arrives
- **Then:** `S-12` is created, and `S-11` stays Blocked

**Verification:** test — `test/service/schedule_fires.test.ts`.

#### AC-006.3 — A missing workspace folder

- **Given:** an entry whose workspace folder was deleted
- **When:** its due time arrives
- **Then:** no job is created, no job number is used, and the run history shows a skipped fire naming the folder

**Verification:** test — `test/service/schedule_fires.test.ts`.

#### AC-006.4 — A model that has gone

- **Given:** an entry whose model is no longer available
- **When:** its due time arrives
- **Then:** no job is created, no job number is used, and the run history shows a skipped fire naming the model

**Verification:** test — `test/service/schedule_fires.test.ts`.

### REQ-007 — Missed due times

Fires SHALL begin once the daemon is ready (S-002 REQ-003). A due time that passes while the daemon is stopped or
starting or the machine is off SHALL create no job and no record, however short the gap. The entry's next fire SHALL be
its next due time. A due time that passed more than one minute ago SHALL NOT fire, which also covers a machine asleep
for more than a minute; a due time passed in a shorter sleep fires when the machine wakes.

#### AC-007.1 — No catching up

- **Given:** an entry due at 02:00, and a daemon stopped from 01:59 to 02:05
- **When:** the daemon starts
- **Then:** no job or skipped fire exists for 02:00, and the next due time is 02:00 the following day

**Verification:** test — `test/service/schedule_fires.test.ts`.

#### AC-007.2 — A machine that wakes up late

- **Given:** a running daemon with an entry due at 02:00, and a controllable clock that jumps from 01:59 to 02:30
- **When:** the daemon carries on
- **Then:** no job or skipped fire exists for 02:00

**Verification:** test — `test/service/schedule_fires.test.ts`.

### REQ-008 — Run now

`schedules.run` SHALL start a scheduled run of the entry at once, with the job REQ-004 describes. Its fire time SHALL be
the moment it started, and its origin SHALL also record that it was run on demand, the way in used and what that way in
observes: the remote address and port on the network listener (S-003 REQ-007; S-004 REQ-003). It SHALL NOT change the
entry's next due time.

It SHALL be refused, creating nothing and recording no skipped fire, because the team member sees the answer at once:

- `busy`, naming the open scheduled run, when the entry has one
- `invalid_input`, naming the folder, when the seat's workspace folder doesn't exist
- `invalid_input`, naming the model, when the entry's model isn't available
- `not_found` when no entry has that name

A repeated call with the same idempotency key SHALL return the original job (S-002 REQ-013).

#### AC-008.1 — Run now starts a scheduled run

- **Given:** an entry with no open scheduled run
- **When:** a team member runs `bob schedules run <name>` and calls it again with the same key through the operation
- **Then:** one job `S-n` exists, its origin records the entry, on demand and way in `command line`, and the next due
  time is unchanged; the same call through the network listener records way in `web interface` with the remote address
  and port

**Verification:** test — `test/service/schedule_fires.test.ts`.

#### AC-008.2 — Run now while a scheduled run is open

- **Given:** an entry whose scheduled run `S-11` is In progress, and in a second case Blocked
- **When:** a team member calls `schedules.run`
- **Then:** the first is refused `busy` naming `S-11`, creating nothing and adding nothing to the history; the second
  creates `S-12`

**Verification:** test — `test/service/schedule_fires.test.ts`.

#### AC-008.3 — Run now with a model that has gone

- **Given:** an entry whose model is no longer available
- **When:** a team member calls `schedules.run`
- **Then:** it is refused `invalid_input` naming the model, no job number is used, and the history is unchanged

**Verification:** test — `test/service/schedule_fires.test.ts`.

### REQ-009 — Reading schedules and their history

`schedules.list` and `schedules.get` SHALL return each entry's values and next due time, and `schedules.list` its latest
scheduled run. `schedules.runs` SHALL return the run history, newest first by fire time or due time, with a limit and a
cursor, and SHALL work for a removed entry that has history. `jobs.list` SHALL accept a filter by schedule entry, which
returns the entry's jobs. Skipped fires SHALL survive a restart and travel with the database in `bob export` and `bob
import`. Schedule entries live in the configuration file and don't travel with an export (S-004 REQ-016): on an instance
whose configuration file lacks them, the history is there after an import and nothing fires until the entries are
restored.

#### AC-009.1 — The history shows scheduled runs and skips

- **Given:** an entry with a completed scheduled run, a cancelled scheduled run and a skipped fire
- **When:** a team member reads `schedules.runs`, restarts the daemon, reads it again, and exports and imports
- **Then:** each read shows the three in order, the scheduled runs with short number, fire time, status, resolution and
  justification, and the skip with its due time and reason

**Verification:** test — `test/service/schedule_operations.test.ts`.

#### AC-009.2 — Jobs by entry

- **Given:** two entries with scheduled runs, and a job from another source
- **When:** a team member calls `jobs.list` filtered by one entry
- **Then:** only that entry's scheduled runs return

**Verification:** test — `test/service/schedule_operations.test.ts`.

### REQ-010 — What the agent knows

The lead of a scheduled run SHALL be told, apart from the Request text, that this is a scheduled run of the named entry
and that it can read that entry's earlier scheduled runs. Every agent of a job SHALL be offered the read schedule runs
tool, and an unknown entry name returns an error result while the agent's run goes on. Read job SHALL open a scheduled
run's record and worklog by naming it (S-004 REQ-013).

#### AC-010.1 — The lead is told and can look back

- **Given:** an entry with a cancelled scheduled run `S-11`, and a fake model that calls the read schedule runs tool and
  then reads `S-11`
- **When:** the entry fires
- **Then:** the model's first input names the entry and earlier scheduled runs; the job's Request is exactly the entry's
  text; and the tool results show `S-11`'s resolution, justification and worklog

**Verification:** test — `test/service/schedule_fires.test.ts`.

#### AC-010.2 — A job that isn't scheduled

- **Given:** a job with origin letter `C`
- **When:** its lead starts
- **Then:** its first input says nothing about a schedule

**Verification:** test — `test/service/schedule_fires.test.ts`.

### REQ-011 — The `bob schedules` commands

`bob` SHALL offer the commands of Interfaces, following S-005's conventions, and `schedules` SHALL no longer be a
reserved group. `bob schedules list` SHALL print each entry's name, cron expression, next due time and latest scheduled
run. `bob schedules show` SHALL print the entry and its recent run history. `bob jobs list --schedule` SHALL filter by
entry.

#### AC-011.1 — The commands work end to end

- **Given:** a test daemon on the fake model
- **When:** a team member runs `create`, `list`, `show`, `change`, `run`, `remove`, each with and without `--json`
- **Then:** each exits 0 with its text, `--json` prints the service's answer unchanged, and a refused call prints the
  reason on standard error with S-005's exit code

**Verification:** test — `test/service/bob_cli.test.ts`.

### REQ-012 — The Schedules page

The web interface SHALL have a Schedules page, linked from the sidebar, that lists the entries with their next due time,
recent scheduled runs linked to their Job pages, and skipped fires with the reason. A team member SHALL create, change,
remove and run an entry there. The page SHALL have the address `/ui/#/schedules`, update from the feed and follow
S-006's rules: addresses, back, forward and reload (REQ-001), refusals and simultaneous actions (REQ-013), lost
connections (REQ-014), everything from the service (REQ-017), timeliness (REQ-018), style (REQ-016), reading and
keyboard use (REQ-020), browsers (REQ-021) and words (REQ-022). A scheduled run's Job page SHALL show the entry, the
fire time and whether it was run on demand.

#### AC-012.1 — Manage entries on the page

- **Given:** a daemon on the fake model and a browser open at the Schedules page
- **When:** a team member adds an entry, runs it, changes it and removes it, while a second browser watches
- **Then:** both pages show each change, the scheduled run links to its Job page, and a refused value shows the
  service's reason

**Verification:** test — `test/web/schedules.test.ts`.

#### AC-012.2 — A skipped fire appears live

- **Given:** a browser open at the Schedules page and an entry with an open scheduled run
- **When:** the entry's next due time arrives
- **Then:** the page shows the skipped fire with its reason and the scheduled run's link, without a reload

**Verification:** test — `test/web/schedules.test.ts`.

#### AC-012.3 — A scheduled run's origin on its Job page

- **Given:** a scheduled run from a fire, and one run on demand from a browser
- **When:** a team member opens each Job page, and opens `/ui/#/schedules` directly and reloads
- **Then:** each Job page shows the entry and fire time, the second also on demand with its way in, and the Schedules
  page opens and survives the reload

**Verification:** test — `test/web/schedules.test.ts`.

### REQ-013 — The front desk tools for schedules

The front desk SHALL be offered tools to list, create, change, remove and run schedule entries and to read their run
history. Each SHALL act as the matching service operation, a refusal SHALL return an error result and the agent's run
goes on, and a call with the same tool call id SHALL act once. An interrupted call settles as an error result, and a
new call from the model is a new call under the operation's rules. These tools SHALL be offered in no other
conversation, apart
from read schedule runs (REQ-010). A scheduled run the front desk starts SHALL have the letter `S` and record in its
origin the way in of the team member's input and the front desk, with no address.

#### AC-013.1 — Setting up a schedule in chat

- **Given:** the front desk and a fake model that calls the create tool and then replies
- **When:** a team member writes "every night at two, check that the backups ran"
- **Then:** the entry exists in the file and in `bob schedules list`, and the front desk's reply names it

**Verification:** test — a service test on the fake model.

#### AC-013.2 — Only the front desk manages schedules

- **Given:** a lead conversation and the front desk
- **When:** each takes a turn
- **Then:** the lead is offered read schedule runs and no other schedule tool; the front desk is offered all of them

**Verification:** test — a service test on the fake model.

#### AC-013.3 — A scheduled run the front desk starts

- **Given:** an entry with no open scheduled run, and the front desk
- **When:** a team member writes over the local socket "run the backups check now", and the fake model calls the run
  tool
- **Then:** a job `S-n` exists, its origin records the entry, on demand, way in `command line` and the front desk

**Verification:** test — a service test on the fake model.

### REQ-014 — No triggers

No event SHALL start a job. A job ending, mail arriving or any other happening SHALL create no job unless an agent or a
team member creates one. The origin letter `T`, the trigger origin and the reserved group `triggers` SHALL NOT exist:
`jobs.create` refuses a trigger origin from any caller, `bob triggers` is an unknown command, and the manual and the web
interface don't mention triggers. The "job done" delta stays for clients that follow the feed.

#### AC-014.1 — A job ending starts nothing

- **Given:** a daemon with a schedule entry
- **When:** a scheduled run completes, and another is cancelled
- **Then:** the job count grows only by what agents and team members created

**Verification:** test — `test/service/schedule_fires.test.ts`.

#### AC-014.2 — The trigger origin is gone

- **Given:** an in-process job source
- **When:** it calls `jobs.create` with a trigger origin, and a team member runs `bob triggers list`
- **Then:** the call is refused `invalid_input` and uses no number, and the command fails as an unknown group, exiting 2

**Verification:** test — `test/service/job_operations.test.ts`, `test/service/bob_cli.test.ts`.

#### AC-014.3 — No word of triggers remains

- **Given:** the merged work
- **When:** a reviewer searches the specs, the manual, `src/` and `web/ui/` for triggers as a job source, and reads the
  system overview's vocabulary and spec map
- **Then:** none remains, apart from Amendment Logs, rejected alternatives and statements that triggers don't exist

**Verification:** inspection — `git grep -i trigger`, read by the reviewer.

## Quality Requirements

### REQ-015 — Timeliness

While the daemon is ready, a fire SHALL create its job or record its skip within one minute of the due time. The job may
then wait for a worker thread (S-002 REQ-010).

#### AC-015.1 — Within one minute

- **Given:** a daemon with several entries due in one minute, under the test clock
- **When:** that minute arrives
- **Then:** each fires within one minute of its due time

**Verification:** test — `test/service/schedule_fires.test.ts`.

### REQ-016 — One job per due time

A due time SHALL create at most one job, whatever crashes or restarts happen. The entry name and the due time SHALL
identify the fire (S-002 REQ-013). A crash before the job is written leaves that due time missed (REQ-007).

#### AC-016.1 — A crash doesn't repeat a fire

- **Given:** a daemon killed just after creating the 02:00 job, and restarted within the same minute
- **When:** it is ready again
- **Then:** exactly one job exists for 02:00

**Verification:** test — a service test that kills the daemon.

### REQ-017 — Documentation

The manual SHALL have a page on schedules, covering the file, the commands, the page, the skip rules and how to read the
run history, in place of `docs/manual/index.md`'s "This page comes with its feature". The command reference and the
origin letter table SHALL match. It SHALL also say that schedule entries aren't in an export, and that a To do scheduled
run holds back fires until someone starts or cancels it (S-004 AC-008.8).

#### AC-017.1 — The manual matches

- **Given:** the merged work
- **When:** a reviewer builds the manual and compares it with `bob schedules --help` and the page
- **Then:** every command, key and skip reason appears, the manual says that entries aren't in an export and that a To
  do scheduled run holds back fires, and the site builds with no error

**Verification:** inspection — `npm run docs:build`, read by the reviewer.

## Configuration Requirements

- **Schedule entries.**
  - **What:** the team's recurring work, as `[[schedule]]` sections (REQ-001).
  - **Where:** the configuration file `config.toml` in the config directory (S-002 REQ-021). Written by hand, by the
    operations, by the page or by the front desk. It changes at runtime through operations and at the next restart by
    hand.
  - **Constraints:** REQ-001 and REQ-005. A trusted, owner-only input.
  - **Missing:** no entries, and no fires. An invalid entry stops startup (REQ-002).

This spec adds no other setting. One minute (REQ-015, REQ-007) is built in.

## Assumptions and Dependencies

- **Anyone who can reach the listeners can add a schedule**, and it runs with the service account's access (ADR-002).
  Confirmed by the product owner: no extra checks.
- **No job with a `T` number exists,** because no job source has ever created one, so removing the letter needs no
  migration. Confirmed in the Architect's consistency review: nothing in `src/` builds a job source caller, listeners
  always build team member callers, and no tagged version holds the job operations.
- **Skipped fires travel with the database,** because `bob export` copies the whole database (S-005).
- **S-001 v0.16, S-002 v0.15, S-003 v0.7, S-004 v0.15, S-005 v0.6 and S-006 v0.6**, as amended on this planning branch,
  and S-000 v0.7. If any amendment is refused at Gate 1, this spec changes with it.
- **The Email spec (not yet written)** treats mail as an input an agent triages, as S-000 v0.7 states. No event passes
  from Email to this spec.

## Success Criteria

1. A team member adds `0 2 * * *` by each of the command, the page, the front desk and a hand edit plus restart, and
   each entry then starts one `S-n` job at its due time, seated with its values (REQ-001 to REQ-005, REQ-011 to
   REQ-013).
2. With an open scheduled run, a missing folder or a gone model, a fire creates no job and the reason appears in `bob
   schedules show`; a Blocked scheduled run stops nothing (REQ-006).
3. A daemon killed around a due time creates at most one job for it, and a stopped daemon creates none later (REQ-007,
   REQ-016).
4. A lead told by a fire reads an earlier scheduled run's resolution and worklog with its tools (REQ-009, REQ-010).
5. **Live test 1, moved from S-001.** With a real low-cost model over the pi agent login, a scheduled job for the `bob`
   role asks for a simple file task in `gp`'s workspace. The lead hands off to `gp` or invokes a `gp` agent, the file
   appears in `gp`'s workspace, and the transcript shows the seat change or the invocation (`npm run
   test:live:schedules`).
6. `git grep -i trigger` finds triggers as a job source nowhere but in Amendment Logs, rejected alternatives and
   statements that triggers don't exist (REQ-014).

## Implementation Order

| Phase | Delivers | Depends on |
|---|---|---|
| 1 | Triggers leave the product: origin kind and letter, reserved group, prompt, page text, manual, system overview, `docs/development/coding_guidelines.md`, `test/live/live_agents.ts` | Nothing |
| 2 | Entries in the file with validation; the create, change, remove and read operations; the holds on roles and workspaces | Phase 1 |
| 3 | Firing, time, skip rules, run now, one job per due time, run history, what the agent knows, the feed delta, live test 1 | Phase 2 |
| 4 | `bob schedules`, `bob jobs list --schedule` and the front desk tools | Phase 3 |
| 5 | The Schedules page and the manual page | Phase 4 |

## Open Questions

None. Feature Architecture settled the scheduling library question (`docs/development/tech_stack.md`, Schedules).

## Amendment Log

| Date | What changed | Why | Affected tasks |
|------|-------------|-----|----------------|
| 2026-11-07 | v0.2. REQ-007: a sleep shorter than a minute isn't detected, so a due time passed in one fires on waking. REQ-013 and Interfaces: an interrupted tool call settles as an error and isn't repeated, and a same-id call acts once. REQ-001, AC-001.1: a cron that can never be due is refused. REQ-003, AC-003.4: removing a role is refused when an entry names its default workspace, because the next start would otherwise stop. Open Questions closed. | Feature Architecture spec findings, 2026-11-07. No approved journey changes. | S-007's tasks |
