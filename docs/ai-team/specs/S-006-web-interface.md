---
id: S-006
title: Web interface
version: '0.4'
status: approved  # draft | review | approved | superseded
created: '2026-11-06'
author: planner
---

# Web interface

## Purpose

This spec covers the first part of S-000's **Web interface** component. Today the network listener serves a placeholder
at `/ui/`, so a team member who isn't on a shell of the machine can't see or steer The Intern at all, although the
Intern service (S-002, S-003), the job record (S-004) and the front desk (S-001) already offer almost every operation
a browser needs. With the daemon, jobs and command line built, this is the next way in S-000 asks for, and its journey
"Watch and steer" has no other home. When it is done, any team member who reaches the service on the network can see
every job on a board, answer blocked jobs, follow an agent live, stop or redirect it, talk to the front desk, shape
roles and workspaces, and download a backup, from a desktop browser and in the Aurora Firmware style.

S-000 lists more for this component than this spec delivers. Pages for schedules, triggers and knowledge sources come
with those components' own specs, and skills and instruction files with the Skills and instructions spec.

## Definitions

This spec uses the Definitions of S-001 to S-005 (team member, job, short number, Blocked reason, front desk,
conversation, lead conversation, seat, role, workspace, way in, service operation, observation feed, client library)
and the shared vocabulary of `docs/system_overview.html`. It adds these terms:

| Term | Meaning in this spec |
|---|---|
| Page | One screen of the web interface, reached from the sidebar or from a link: Board, Job page, Front desk, Roles, Workspaces, Status. |
| Sidebar | The dark panel on every page holding the logo and the links to the pages. |
| Board | The home page: every job in one column per status. |
| Job page | The page of one job, with an address of its own, such as `/ui/#/jobs/W-3`. |
| Live activity | What a conversation does as it happens: messages, tool calls and results, and the agents it invokes. |
| Stop | The action that aborts a conversation, with S-001's cascade. |
| Redirect | The action that sends a team member's words to a running agent, to take into account after its current tool round. |
| Answer | Text a team member gives a Blocked job through `jobs.resume`, delivered to its lead agent (S-004 REQ-006). |
| Connection banner | The notice a page shows while it can't reach the service. |
| Export download | The file of the whole saved state that a browser receives from the Status page. |

## Users and Journeys

| Actor | Goal |
|---|---|
| Team member at a desktop browser | Watches and steers work from any computer that reaches the service, with no terminal and no account. |
| Second team member | Opens a link to a job from a colleague and sees the same job, or acts on it at the same time. |
| Developer | Tests the main journeys in a real browser against a real daemon on the fake model. |
| Later specs (downstream) | Schedules and triggers, Skills and instructions, and Team knowledge add their pages to the sidebar. |

Journeys, in priority order:

1. **See what's running and what's stuck.** The team member opens `/ui/` and sees every job by status, with jobs
   waiting on an answer standing out. Delivered by REQ-001, REQ-002, REQ-018.
2. **Answer a blocked job.** They open the job, read the Blocked reason and answer, and the job goes on. Delivered by
   REQ-003, REQ-004.
3. **Follow and steer an agent.** They watch the live activity of a job and stop or redirect an agent. Delivered by
   REQ-005, REQ-006, REQ-007.
4. **Hand work over.** They talk to the front desk or create a job directly. Delivered by REQ-008, REQ-015.
5. **Point a colleague at a job.** They send a job's address, and it opens the same job in another browser. Delivered
   by REQ-001.
6. **Shape roles and workspaces.** Delivered by REQ-009, REQ-010.
7. **Check health and take a backup.** They read status and usage, and download the whole saved state. Delivered by
   REQ-011, REQ-012.
8. **Carry on through a restart.** The service restarts while a page is open, and the page recovers with nothing typed
   lost. Delivered by REQ-014.

## Exclusions

What this specification explicitly does NOT cover:

- **Phones and tablets.** The pages are designed for desktop screens only. Product owner decision on 2026-11-06.
- **Browser notifications.** No pop-ups or sounds when a job blocks. A team member sees it on the board.
- **Login, accounts and encryption.** Reaching the page follows from the network setup (S-000; S-003 Exclusions).
- **Names on actions.** Nobody enters a name. The record shows the way in, and the network address or the front desk
  where the origin has them (REQ-015).
- **Workspace file browsing and editing.** No operation offers it, and S-000 says this interface adds no capabilities.
  An agent's file changes appear only through its tool activity. The product owner expects browser editing of agents'
  system prompts held in files to come in a later revision.
- **Instruction files and skills editing.** The Skills and instructions spec owns these. A role's own instructions are
  in scope (REQ-009).
- **Import.** It stays on the command line, because it refuses to run while a daemon owns the instance (S-005 REQ-013).
- **Exporting to a path on the service's machine from the browser.** The browser offers only the export download;
  `bob export` stays as it is.
- **Pages for schedules, triggers and knowledge sources.** Each of those specs adds its own.
- **Any setting of its own.** The web interface adds no configuration.

## Alternatives Considered

- **Board with a side panel.** The board stays on screen, a job opens in a panel beside it, and the front desk is
  docked as a chat. Rejected: long tool output and nested agents get cramped, with the sidebar taking width as well.
- **Control room.** The board plus pinned tiles, each following one agent live. Rejected: the most to build and the
  busiest screen, against the brand's "simple and clear", for something rarely needed in a first version.
- **Page addresses in path form, such as `/ui/jobs/W-3`.** Rejected: a missing file gets `404` today, so it needs a
  further S-003 REQ-008 amendment for nothing a team member sees. The hash form needs none.
- **One stream per invoked conversation.** Rejected: plain HTTP allows a browser 6 connections per host across its tabs,
  so a few busy jobs would use them up and actions would hang.
- **A reminder after Stop.** Rejected: it starts again what a team member just stopped (S-000 use case 7).
- **Linked pages** were chosen because, with no login, a link is the easy way to point another team member at a job,
  and the live activity gets the whole content width.
- **An optional name remembered in the browser.** Rejected: it's a label, not proof, and the record should claim
  nothing it can't show.
- **A required name.** Rejected: it feels like a login without being one, and S-000 says no way in needs one.
- **A banner asking for a manual reload when the connection is lost.** Rejected: a tab left open quietly stops being
  useful, and typed text can be lost.
- **Silent retry when the connection is lost.** Rejected: a stale page could be read as current.
- **Showing messages only in the live view.** Rejected: following an agent means seeing its tool calls and results too.
- **Backups on the command line only.** Rejected: the browser download is the most convenient for backups. The
  product owner accepted the risk this brings (Assumptions and Dependencies).
- **Export to a path on the service's machine from the browser.** Rejected in favour of the download: the file ends up
  where the team member is.
- **A confirmation on the front desk's Stop.** Rejected: it ends only a chat turn, so a confirmation would just slow it
  down.
- **Stop and redirect as the only conversation controls.** Rejected: compact, reset and changing the seat are already
  service operations, so the job page offers them too.
- **Roles editable except their instructions, or read-only roles.** Rejected: `roles.change` already accepts
  instructions, so full editing costs almost nothing more.
- **Lighter tests with a by-hand pass, or by hand only.** Rejected: regressions in real pages would be found late, and
  by hand only conflicts with the project's test rule.

## Interfaces

### Addresses

| Address | Page |
|---|---|
| `/` | Redirects to `/ui/` (S-003 REQ-008) |
| `/ui/` | Board |
| `/ui/#/jobs/<short number>`, such as `/ui/#/jobs/W-3` | Job page |
| `/ui/#/desk`, `/ui/#/roles`, `/ui/#/workspaces`, `/ui/#/status` | Front desk, Roles, Workspaces, Status |

Every page is served from `/ui/`, and the part after `#` names it, so S-003 REQ-008 isn't amended. REQ-001 fixes what
these addresses must do.

### Service calls consumed

Every page calls the service through the client library for browsers (S-003 REQ-009). This table names the existing
operations and feed each page relies on. No page calls anything else, apart from the export route below.

| Page | Reads | Actions |
|---|---|---|
| Every page | `daemon.status`, to check the connection and the version (ADR-007 decisions 6 and 9) | — |
| Board | `jobs.list`, instance feed (`GET /feed?scope=instance`) | — |
| Job page | `jobs.get`, `jobs.history.list`, `jobs.worklog.list`, `conversations.get`, `conversations.entries`, `conversations.invocations`, `models.list`, `roles.list`, `workspaces.list`, instance feed, the job's conversations on the shared stream (`GET /feed?scope=conversations`, S-003 REQ-006; ADR-007) | `jobs.update`, `jobs.complete`, `jobs.cancel`, `jobs.resume`, `jobs.relate`, `jobs.unrelate`, `conversations.submit`, `conversations.abort`, `conversations.compact`, `conversations.reset`, `conversations.seat` |
| Front desk | `desk.get`, `conversations.entries`, `submissions.get`, conversation feed, which reaches the page on the shared stream (`GET /feed?scope=conversations`, S-003 REQ-006; ADR-007) | `conversations.submit`, `conversations.abort`, `jobs.create` |
| Roles | `roles.list`, `models.list`, `workspaces.list`, instance feed | `roles.create`, `roles.change`, `roles.remove`, `roles.restore` |
| Workspaces | `workspaces.list`, instance feed | `workspaces.register`, `workspaces.unregister` |
| Status | `daemon.status`, `usage.get`, `models.list`, `conversations.list`, instance feed | Export download |

On the Job page, the instance feed is the only source of job deltas (S-004 REQ-015), and its `conversation_created`
delta names a newly invoked conversation. `workspaces.list` gives the workspaces for a change of seat.

**Contract** (`conversations.entries`): the operation takes an optional input `order`, `"ascending"` or `"descending"`,
and is `"ascending"` by default, as S-002 AC-012.4 states. With `"descending"`, a page holds the newest entries first,
and its `next` leads to older entries. Pages use `"descending"`.

**Contract** (answers and Redirect on the Job page): an answer is `jobs.resume` with `text`, and a second answer, once
the job is no longer Blocked, is refused `conflict`. `conversations.submit` is for Redirect only, with busy mode
`steer`, and answers `{ held: true }` for a conversation parked for reports (S-002 REQ-012).

### The export route

The export download uses a new route on the network listener, `GET /export`. S-003 REQ-016 owns its contract. This spec
owns the page that calls it (REQ-012).

### Attribution

The network listener records each action with the way in `web interface` and the remote address and port of the
browser's connection (S-003 REQ-007). A job created directly in the browser gets a `W-n` number (S-004), and its origin
records them. A job the front desk creates for a team member in the browser also gets a `W-n` number. Its origin records
the way in and the front desk, with no address, because the front desk's tool creates it, not the browser's connection
(S-004 REQ-003, REQ-021). The pages send nothing that claims a name.

### What doesn't change

The `bob` commands, `config.toml` (its `[network]` section still sets the address and port) and the existing routes
stay as they are.

## Workflow

```text
Open /ui/
  → board from jobs.list, kept current by the instance feed                         REQ-002, REQ-018
  → no jobs → four empty columns and a link to the Front desk                       REQ-002

Blocked job
  feed reports the block → the job stands out on the board                          REQ-002
  open the job → Blocked reason shown → answer sent → In progress, no reload        REQ-003, REQ-004
  unknown job address → the page says so and links to the board                     REQ-001

Live following
  job page → current entries → live activity from the conversation feed             REQ-005
  long output → collapsed, expandable                                               REQ-005, REQ-019
  Redirect → words delivered after the current tool round                           REQ-006
  Redirect while parked for reports → page says "held until it continues"           REQ-006
  Stop → one confirmation → conversation aborted; already finished → page says so   REQ-006
  Stop on the lead → no reminder → Blocked "stopped by a team member" → an answer resumes   REQ-006
  Stop on a lead parked for reports → one confirmation → it and its invoked agents end → Blocked   REQ-006
  To do job's lead → no Stop; Cancel ends the job, and input to its lead starts it  REQ-006
  Reset → one confirmation → conversation starts over                               REQ-007

Any action
  service refuses → its message shown, nothing changed, typed text kept             REQ-013
  two team members act → the service decides, both see the result through the feed  REQ-013

Lost connection
  feed or call fails → connection banner, actions disabled, typed text kept         REQ-014
  → reconnects on its own → fresh data → banner gone, text can be sent              REQ-014
  feed ends lagging → subscribes again, missed entries shown once, no banner        REQ-014
  feed ends stopped, or the service answers unavailable → as for a failed feed      REQ-014

Backup
  Status → Export → one confirmation stating what the copy holds                    REQ-012
  → file saved by the browser, work goes on                                         REQ-012
  → failure → error shown, nothing presented as a good backup                       REQ-012
```

## Behavioral Requirements

### REQ-001 — Pages and addresses

The network listener's `/ui/` SHALL offer the Board, Job page, Front desk, Roles, Workspaces and Status pages. Every
page SHALL show the sidebar with links to all of them but the Job page, which the Board and other pages link to. Each
page and each job SHALL have an address that opens it directly in any browser that reaches the service, and the
browser's back, forward and reload SHALL work across pages.

#### AC-001.1 — Moving around

- **Given:** a daemon with a job
- **When:** a team member goes through each sidebar link, opens the job from the Board, goes back and reloads
- **Then:** each page opens at its own address, back returns to the Board, and reload shows the same page

**Verification:** test — a browser test against a daemon on the fake model.

#### AC-001.2 — A shared job address

- **Given:** a job open in one browser
- **When:** its address is opened in a second browser with no stored data
- **Then:** the second browser shows the same job

**Verification:** test — a browser test with two separate browser contexts.

#### AC-001.3 — An unknown job

- **Given:** a daemon with no job `W-999`
- **When:** a team member opens `/ui/#/jobs/W-999`
- **Then:** the page says the job doesn't exist and links back to the Board

**Verification:** test — a browser test.

### REQ-002 — The board

The Board SHALL be the home page and SHALL show every job in the columns To do, In progress, Blocked and Done, in that
order, each job with its short number and title. A Blocked job SHALL stand out from the others by more than its column,
and SHALL show its Blocked reason or the start of it. The Done column SHALL show jobs newest first, as `jobs.list`
returns them, and load more on request. A job SHALL move between columns without a reload when the service reports the
change.

#### AC-002.1 — A job blocks

- **Given:** the Board open and a job In progress on the fake model
- **When:** its lead agent blocks the job with a reason
- **Then:** the job moves to Blocked, stands out, and shows the reason, with no reload

**Verification:** test — a browser test.

#### AC-002.2 — No jobs

- **Given:** a daemon with no jobs
- **When:** a team member opens the Board
- **Then:** it shows the four empty columns and a link to the Front desk

**Verification:** test — a browser test.

#### AC-002.3 — More done jobs

- **Given:** more Done jobs than the column first shows
- **When:** a team member asks for more
- **Then:** older Done jobs are added, newest first, and the other columns stay as they were

**Verification:** test — a browser test.

### REQ-003 — The job page

The Job page SHALL show a job's short number, title, description, definition of done, status, Blocked reason while
Blocked, origin (way in and network address where the origin has them, and the front desk for a job it created),
resolution and justification once Done, worklog and history, and SHALL keep them current without a reload.

#### AC-003.1 — A finished job

- **Given:** a job completed on the fake model, with worklog entries
- **When:** a team member opens its page
- **Then:** every field named above is shown, with the resolution and justification

**Verification:** test — a browser test.

### REQ-004 — Answering and changing a job

The Job page SHALL let a team member answer a Blocked job (S-004 REQ-006), edit its title, description and definition
of done (S-004 REQ-004), complete it or cancel it with a justification (S-004 REQ-005), and relate it to another job or
remove a relation (S-004 REQ-009). The Job page SHALL show the job's related jobs, with links. An answer SHALL go
through `jobs.resume` with its text, so a second answer, once the job is no longer Blocked, is refused `conflict`.

#### AC-004.1 — Answer a blocked job

- **Given:** a Blocked job with its page open
- **When:** a team member types an answer and sends it
- **Then:** the lead agent receives the text, the job moves to In progress and the Blocked reason clears, with no reload

**Verification:** test — a browser test.

#### AC-004.2 — Edit and cancel

- **Given:** a job In progress
- **When:** a team member changes its title, then cancels it with a justification
- **Then:** the page and the Board show the new title, then Done with the resolution `cancelled`; a cancel with an empty
  justification shows the service's refusal and changes nothing

**Verification:** test — a browser test.

#### AC-004.3 — Complete and relate

- **Given:** two jobs In progress, the first with a definition of done and the second without one
- **When:** a team member relates them, removes the relation, completes the first with a justification, and tries to
  complete the second
- **Then:** the related job and its link appear and then go; the first shows Done with the resolution `completed`; and
  the second shows the service's refusal and stays In progress

**Verification:** test — a browser test.

#### AC-004.4 — A second answer

- **Given:** a Blocked job with its page open in two browsers, each with an answer typed
- **When:** one sends its answer, and the other then sends its own
- **Then:** the lead agent receives the first; the second browser shows the `conflict` refusal, its typed text stays in
  the box, and the lead agent doesn't receive that text

**Verification:** test — a browser test with two browser contexts.

### REQ-005 — Following live

The Job page SHALL show the live activity of the job's lead conversation and of every conversation it invokes,
recursively: messages, tool calls and tool results, as they happen, after the entries already stored. Long output SHALL
be collapsed and expandable. A team member SHALL be able to tell which agent each activity belongs to. Following a job
SHALL leave the browser's connections free for its actions (Assumptions and Dependencies).

#### AC-005.1 — Activity appears

- **Given:** a Job page open and a lead agent on the fake model that calls a tool and invokes another agent
- **When:** the run goes on
- **Then:** the message, the tool call, its result and the invoked agent's activity appear with no reload, each under
  its agent

**Verification:** test — a browser test.

#### AC-005.2 — Opened part way

- **Given:** a job that has already run for some turns
- **When:** a team member opens its page
- **Then:** the earlier activity is there, and new activity follows it with none lost or repeated

**Verification:** test — a browser test.

#### AC-005.3 — Very long output

- **Given:** a tool result of 1 MiB
- **When:** it appears in the live activity
- **Then:** it is collapsed, shows that there is more, and expands on request

**Verification:** test — a browser test.

#### AC-005.4 — Many agents in several tabs

- **Given:** a job with 8 running invoked agents on the fake model, over plain HTTP
- **When:** its Job page is open in 3 tabs of one browser, and a team member presses Stop in one and confirms
- **Then:** every tab keeps showing the activity of all 8 agents with no reload, and the Stop gets its answer

**Verification:** test — a browser test with 3 pages in one browser context.

### REQ-006 — Stop and redirect

The Job page SHALL offer Stop and Redirect for a conversation of the job that is running, waiting for a worker thread or
parked for reports. It SHALL offer no Stop on the lead of a To do job, because that abort would leave the job To do with
nothing to resume it from the page (S-004 REQ-008). Stop SHALL ask for one confirmation, then abort the conversation
(S-001's cascade). Stopping the lead of an In progress job SHALL leave the job as S-004 REQ-008 states: no reminder,
Blocked with the reason "stopped by a team member", and an answer resumes it. Redirect SHALL deliver the team member's
words to the running agent after its current tool round (S-002's busy mode `steer`; S-001 REQ-020). For a conversation
parked for reports, the service holds the words, and the page SHALL say "held until it continues" (ADR-004 decision 4).

#### AC-006.1 — Redirect

- **Given:** a running lead agent on the fake model
- **When:** a team member sends words through Redirect
- **Then:** the agent takes them after its current tool round, its conversation records them from a team member with
  the way in `web interface`, and the live activity shows them

**Verification:** test — a browser test reading the conversation's entries.

#### AC-006.2 — Stop asks once

- **Given:** a running lead agent on the fake model
- **When:** a team member presses Stop, declines the confirmation, presses it again and confirms, then answers the job
- **Then:** the agent keeps running after the decline and stops after the confirmation, with no reminder; the job goes
  Blocked with the reason "stopped by a team member", the daemon as author in its history; and the answer sets it In
  progress with the lead continuing

**Verification:** test — a browser test.

#### AC-006.3 — Already finished

- **Given:** a Stop confirmation open
- **When:** the agent finishes before the team member confirms
- **Then:** the page reads from the feed's state that the run ended, says the agent has already finished, and sends no
  abort

**Verification:** test — a browser test.

#### AC-006.4 — Redirect while parked

- **Given:** a lead agent parked for a running invoked agent on the fake model
- **When:** a team member sends words through Redirect, and the invoked agent reports
- **Then:** the page says "held until it continues" and no run starts; when the lead continues, the live activity shows
  the words once, from a team member with the way in `web interface`

**Verification:** test — a browser test.

#### AC-006.5 — Stop while parked

- **Given:** a lead agent parked for a running invoked agent on the fake model
- **When:** a team member presses Stop and confirms
- **Then:** the lead and the invoked agent both end, and the job goes Blocked with the reason "stopped by a team member"

**Verification:** test — a browser test.

#### AC-006.6 — No Stop on a To do job's lead

- **Given:** a To do job whose lead waits for a worker thread on the fake model, with its page open
- **When:** a worker thread comes free and the job goes In progress
- **Then:** while the job is To do the page offers no Stop on its lead and offers Cancel; once it is In progress, with
  no reload, the page offers Stop

**Verification:** test — a browser test with every worker thread held.

### REQ-007 — Conversation controls

The Job page SHALL offer compact, reset and change seat for a conversation of the job, in a less prominent place than
Stop and Redirect. Reset SHALL ask for one confirmation.

#### AC-007.1 — Seat, compact, reset

- **Given:** a job's lead conversation at rest on the fake model
- **When:** a team member changes its seat to another role, compacts it, and resets it, declining the first reset
  confirmation and accepting the second
- **Then:** the new seat shows, the compaction appears in its activity, and only the accepted reset takes effect

**Verification:** test — a browser test.

### REQ-008 — The front desk and creating jobs

The Front desk page SHALL show the front desk's recent conversation and let a team member send it messages, with its
answers appearing as they are written. A message sent while the front desk is busy SHALL queue (S-002's busy mode
`followUp`). The page SHALL offer Stop while the front desk answers, with no confirmation, because it ends only a chat
turn. Messages still queued at that point SHALL be dropped, and the page SHALL name the dropped messages that it sent
and still holds. The page SHALL also let a team member create a job directly, with its text and an optional title
(S-004 REQ-003).

#### AC-008.1 — Chat creates a job

- **Given:** a front desk on the fake model that creates a job when asked
- **When:** a team member asks it for one in the browser
- **Then:** its answer appears as it is written, and the job appears on the Board as `W-n`

**Verification:** test — a browser test.

#### AC-008.2 — Create directly

- **Given:** the Front desk page
- **When:** a team member creates a job directly, then tries again with empty text
- **Then:** the first opens as `W-n` on the Board; the second shows the service's refusal and creates nothing

**Verification:** test — a browser test.

#### AC-008.3 — Stop an answer

- **Given:** the front desk answering on the fake model, with one more message queued from this page
- **When:** a team member presses Stop
- **Then:** with no confirmation the answer stops, the queued message is dropped and named on the page, and a new
  message gets an answer

**Verification:** test — a browser test.

### REQ-009 — Roles

The Roles page SHALL list every role with its settings, and SHALL let a team member create a role, change any role's
instructions, tools, skills, default model, thinking level and workspace, restore a changed shipped role and remove a
role they created, under S-001 REQ-003's rules. The page SHALL state that a change affects only agents seated
afterwards.

#### AC-009.1 — Change and restore

- **Given:** a shipped role
- **When:** a team member changes its instructions, a new conversation seats it, and the role is then restored
- **Then:** the new agent has the new instructions, and the list shows the shipped values after the restore

**Verification:** test — a browser test.

#### AC-009.2 — Remove a shipped role

- **Given:** the Roles page
- **When:** a team member tries to remove `desk`
- **Then:** the page shows the service's refusal, and the role stays

**Verification:** test — a browser test.

### REQ-010 — Workspaces

The Workspaces page SHALL list the registered workspaces, and SHALL let a team member register and unregister one
(S-001 REQ-018).

#### AC-010.1 — Register and unregister

- **Given:** an owner-only directory on the service's machine
- **When:** a team member registers it, then unregisters it, then registers a path that doesn't exist
- **Then:** the list shows it, then doesn't; the last attempt shows the service's refusal

**Verification:** test — a browser test.

### REQ-011 — Status and usage

The Status page SHALL show the daemon's state as `daemon.status` reports it, usage per conversation and in total, and
the available models and thinking levels, kept current without a manual reload.

#### AC-011.1 — Status shown

- **Given:** a daemon with some usage on the fake model
- **When:** a team member opens the Status page
- **Then:** the state, the usage totals and the models match what `daemon.status`, `usage.get` and `models.list` return

**Verification:** test — a browser test comparing the page with the operations' answers.

### REQ-012 — The export download

The Status page SHALL offer the export download. It SHALL ask for one confirmation that states the file holds every
conversation and the whole job record, that settings (the configuration file) aren't in it, and that anyone who can
reach the page can take it. After the confirmation the
browser SHALL save the file from `GET /export` (S-003 REQ-016). A failure SHALL show an error, and the page SHALL never
present a partial file as a good backup.

#### AC-012.1 — Download a usable backup

- **Given:** a daemon running jobs on the fake model
- **When:** a team member confirms the download
- **Then:** the browser saves a file, the jobs go on, and `bob import` accepts the file for a new instance that starts
  with every job committed before the export began

**Verification:** test — a browser test, then `bob import` as a child process with a temporary instance. The test
downloads again on `409 busy` (S-003 REQ-016).

#### AC-012.2 — Declined and failed

- **Given:** the Status page
- **When:** a team member declines the confirmation, then confirms while the service answers `GET /export` with an error
- **Then:** the confirmation states what REQ-012 names; nothing is requested after the decline, and the error shows
  after the failure with no success message

**Verification:** test — a browser test.

### REQ-013 — Refusals and simultaneous actions

When the service refuses an action, the page SHALL show the service's message, keep what the team member typed and show
no change. The pages SHALL NOT decide on their own whether an action is allowed. A page MAY read state from the feed to
word a message, such as "already finished" (AC-006.3). When that state arrives late, the action reaches the service, and
this harmless race is accepted. When two team members act on the same job, the service decides, and both pages SHALL
show the result through the feed.

#### AC-013.1 — Answering a cancelled job

- **Given:** a Blocked job open in two browsers
- **When:** one cancels it while the other has typed an answer, and the second then sends it
- **Then:** both show Done without a reload; the second shows the service's refusal, and its typed text stays in the box

**Verification:** test — a browser test with two browser contexts.

### REQ-014 — Lost connection

While a page can't reach the service, it SHALL show the connection banner and disable its actions, and SHALL keep text
being typed. It SHALL try to reconnect without being asked. On reconnecting it SHALL load fresh data, remove the banner
and enable the actions, and the kept text can then be sent.

Following S-005 REQ-015, a feed that ends with `stopped`, and an `unavailable` answer to a call or feed request, SHALL
count as a page that can't reach the service. `unavailable` and unreachable are connection state, not a refusal under
REQ-013. A feed that ends with `lagging` SHALL be subscribed again with no banner. Each new subscription starts from a
fresh snapshot. For each conversation it shows, the page SHALL then read `conversations.entries` from the last entry it
showed and show what it missed, once, before the new deltas.

#### AC-014.1 — A daemon restart

- **Given:** a Job page open with a typed answer not yet sent
- **When:** the daemon is stopped, then started again on the same instance
- **Then:** the banner appears and sending is disabled; after the restart the banner goes, the page shows the job's
  current state, and the kept answer can be sent and reaches the lead agent

**Verification:** test — a browser test restarting a test daemon.

#### AC-014.2 — A feed that lags

- **Given:** a Job page following a run, whose feed ends with `lagging` after entries the page hasn't shown
- **When:** the feed ends
- **Then:** no banner shows, the page subscribes again, and it shows the missed entries once and in order, then the new
  activity

**Verification:** test — a browser test with the feed's end forced.

#### AC-014.3 — A service that is stopping

- **Given:** a Job page with a typed answer not yet sent
- **When:** the feed ends with `stopped`, and in a second case the page's call to send the answer gets `unavailable`
- **Then:** each time the banner shows, sending is disabled, the typed answer stays, no refusal message shows, and the
  page recovers as AC-014.1 states

**Verification:** test — a browser test stopping a test daemon, and one with the `unavailable` answer forced.

### REQ-015 — Who did it

The pages SHALL ask for no login and no name, and SHALL send nothing claiming who the team member is. Actions SHALL be
recorded as S-003 REQ-007 states, and the Job page SHALL show that record for a job's origin. A job a team member
creates directly in the browser SHALL record the way in and the network address. A job the front desk creates SHALL
record the way in and the front desk, with no address (S-004 REQ-003, REQ-021).

#### AC-015.1 — Recorded by address

- **Given:** a browser on a loopback address
- **When:** it creates a job directly
- **Then:** the job is `W-n`, its origin records the way in `web interface` with that address and port, and the Job page
  shows them

**Verification:** test — a browser test.

#### AC-015.2 — From another computer

- **Given:** a daemon with `[network]` on the team's network
- **When:** a second computer opens `/ui/` and creates a job directly
- **Then:** the pages load, and the job's origin records that computer's address

**Verification:** demonstration — by hand, extending the LAN check in `docs/development/local_runs.md`.

#### AC-015.3 — A front desk job

- **Given:** a front desk on the fake model that creates a job when asked
- **When:** a team member asks it for one in the browser
- **Then:** the job is `W-n`, its origin records the way in `web interface` and the front desk, with no address, and the
  Job page shows the way in and the front desk

**Verification:** test — a browser test.

## Quality Requirements

### REQ-016 — Aurora Firmware style

The pages SHALL follow the Aurora Firmware brand.

**Contract, colours:**

| Name | Value | Use |
|---|---|---|
| Dark Blue | `#080A24` | Sidebar, primary text, text on orange |
| Dark Blue Light | `#0F1340` | Sidebar hover, raised dark surfaces |
| Dark Blue Muted | `#1A1E4A` | Cards on dark surfaces |
| Orange | `#F7941D` | Primary buttons, active items, highlights, accent borders |
| Orange Light | `#FABA6A` | Hover on orange |
| Orange Subtle | `#FEF3E2` | Light tint for highlights on light surfaces |
| Red | `#E63B26` | Alerts, destructive actions, errors |
| Red Light | `#F4695A` | Hover on red |
| White | `#FFFFFF` | Cards |
| Light Gray | `#F5F5F8` | Content area background |
| Medium Gray | `#E2E4EA` | Borders, dividers |
| Text Gray | `#6B7080` | Secondary text, captions |
| Success Green | `#22C55E` | Done |
| Info Blue | `#3B82F6` | In progress |
| Status Gray | `#9CA3AF` | To do, neutral status |

**Contract, type:** Bruno Ace for the app title, page headings and agent names. Josefin Sans for everything else:
section headings at weight 600, body at 400, labels and captions at 300, buttons at 600.

**Contract, layout:** a Dark Blue sidebar with the white logo, a Light Gray content area with white cards, clean lines,
generous whitespace and subtle shadows. The red-to-orange 45-degree gradient is used sparingly. The favicon is the
Secundario logo variant.

Text on orange SHALL be Dark Blue, not white as in The Round Table, for contrast (REQ-020).

#### AC-016.1 — Style review

- **Given:** every page in a browser
- **When:** it is compared with the brand manual and the tables above
- **Then:** colours, fonts, logo and layout match, and the fonts and logos in use are served by the service

**Verification:** inspection — a by-hand review against the brand manual and assets.

### REQ-017 — Everything comes from the service

The pages SHALL load all they need from the service, fonts included, and SHALL work on a network with no internet
access. They SHALL hold no work and no state of their own, beyond browser settings such as a collapsed section and text
not yet sent, whose loss costs nothing else. Every read and action SHALL go through the service (S-000).

#### AC-017.1 — No outside requests

- **Given:** a browser test recording every request
- **When:** it goes through each page
- **Then:** every request goes to the service's address

**Verification:** test — a browser test.

#### AC-017.2 — Stored data lost

- **Given:** a page in use with a section collapsed
- **When:** the browser's stored data is cleared and the page reloaded
- **Then:** the page shows the same jobs and works, with the section back to its default

**Verification:** test — a browser test.

### REQ-018 — Timeliness

A change SHALL appear on the Board and the Job page within 2 seconds of the service reporting it, on the team's network
with the daemon under normal work.

#### AC-018.1 — Within 2 seconds

- **Given:** the Board and a Job page open, with a test daemon on loopback
- **When:** a job's status changes
- **Then:** both pages show it within 2 seconds of the feed event

**Verification:** test — a browser test measuring the time from the event to the page.

### REQ-019 — Scale

The Board SHALL stay usable with 500 jobs, and a Job page SHALL stay responsive with long activity. Usable and
responsive here mean that the page opens within 3 seconds on loopback, and that an interaction, such as opening a job
or expanding an output, answers within 500 milliseconds. What the service sends a page for a new activity entry SHALL be
bounded by what the entry adds, not by the length of the conversation.

#### AC-019.1 — A full board

- **Given:** a daemon with 500 jobs
- **When:** a team member opens the Board and opens a job from it
- **Then:** both meet the times above

**Verification:** test — a browser test.

#### AC-019.2 — Long activity

- **Given:** a job with 2,000 activity entries, some with long output
- **When:** a team member opens its page and expands one output
- **Then:** both meet the times above

**Verification:** test — a browser test.

#### AC-019.3 — Long activity with a run writing

- **Given:** a Job page following a run on the fake model, once with 20 activity entries and once with 2,000, some with
  long output
- **When:** the run adds one short entry
- **Then:** the data the page receives for that entry is no larger with 2,000 entries than with 20, and its size follows
  from what the entry adds

**Verification:** test — a browser test measuring the data received on the feed connection.

### REQ-020 — Readable and keyboard-usable

Text and controls SHALL meet a contrast of at least 4.5:1 against their background, and every action SHALL work from the
keyboard, with the focused control visible.

#### AC-020.1 — Contrast

- **Given:** every page
- **When:** contrast is measured
- **Then:** text and controls reach 4.5:1

**Verification:** test — an automated contrast check in the browser tests.

#### AC-020.2 — Keyboard only

- **Given:** a Blocked job on the Board
- **When:** a team member opens the job, answers it and goes back, with the keyboard alone
- **Then:** all of it works, and the focus can be seen at each step

**Verification:** test — a browser test using keyboard input only.

### REQ-021 — Browsers

The pages SHALL work on current Chrome and Firefox on desktop. These two are the required browsers. Edge on desktop is
good to have: the browser tests SHALL run on Edge where it is installed and skip where it isn't, and an Edge failure on
a machine that has Edge SHALL still fail. Safari isn't a target and isn't blocked.

#### AC-021.1 — The main journey in each engine

- **Given:** a daemon on the fake model
- **When:** the journey of answering a Blocked job runs in Chrome, in Firefox, and in Edge where it is installed
- **Then:** it passes in Chrome and Firefox, and a missing Chrome or Firefox fails the run. Where Edge is installed, the
  journey passes in it, and an Edge failure fails the run. Where Edge isn't installed, its tests skip with a diagnostic

**Verification:** test — the browser tests run on Chrome, on Firefox, and on Edge where it is installed, in CI.

### REQ-022 — Documentation and words

The user manual SHALL have a Web interface chapter, which states that anyone who can reach the page can act and download
everything. The pages SHALL use the project's vocabulary (`docs/system_overview.html`), for example job and team member.

#### AC-022.1 — The manual and the words

- **Given:** the built manual and every page
- **When:** they are read
- **Then:** the chapter exists with that warning, and no page uses a word the vocabulary rules out

**Verification:** inspection — reading the manual, and a test searching the page text for the ruled-out words.

## Configuration Requirements

None. The web interface adds no setting. The existing `[network]` section of `config.toml` sets its address and port
(S-003).

## Assumptions and Dependencies

- **A small team on a trusted network, confirmed by the product owner on 2026-11-01 (S-003).** The network setup limits
  who reaches the listener.
- **A few team members at once, confirmed on 2026-11-06.** The service decides between simultaneous actions (REQ-013).
- **A daemon restart is routine (S-002),** and the pages recover through REQ-014.
- **Accepted risk, confirmed by the product owner on 2026-11-06.** Anyone who can reach the page can download every
  conversation and the whole job record, with no login. The confirmation on the Status page and the manual state this.
- **S-001 to S-005** provide the operations and the feed named in Interfaces. Amendments on this spec's planning branch
  provide the rest, apart from the `order` input of `conversations.entries`, which this spec's Interfaces add. S-003
  v0.5 adds the export route (REQ-016) and one stream for several conversations (REQ-006). S-004 v0.13 adds the block
  after a team member's stop (REQ-008) and the "related changed" delta (REQ-015), and S-004 v0.14 states the abort of a
  To do job's lead (REQ-008).
- **Browser connections.** Plain HTTP allows a browser 6 connections per host across its tabs. A Job page reads the
  instance feed and the stream for its conversations, so 3 Job pages that each hold both would use all 6 and leave none
  for actions. ADR-007 decides how the pages stay within the limit, so that AC-005.4 holds.
- **Delta size.** Before this spec, each delta of a conversation re-sent its whole active view, measured at 1.06 MB for
  a 32-byte change. ADR-008 decides how AC-019.3 is met.
- **Brand assets.** The brand manual, logos and font choices come from The Round Table project
  (`~/projects/the_round_table/project/docs/corporate_image/` and `the_round_table/src/app/globals.css`). They are
  copied into this repository, so the two projects stay independent. The fonts are free and open source.
- **The fake model** (S-002) drives the automated browser tests. A real browser must be available in CI.

## Success Criteria

1. All browser tests of this spec pass in CI against a real daemon on the fake model, covering the journeys of Users and
   Journeys, the restart (REQ-014) and a refused action (REQ-013). They run on Chrome and Firefox, and on Edge where it
   is installed. Edge's tests may skip only for a missing Edge (REQ-021). Measured by the CI run.
2. The service tests of S-003 REQ-016 pass: the copy, the log line, the owner-only temporary copy and its removal, one
   download at a time and the free-space refusal. So do those of S-003 AC-006.4 and S-004 AC-008.5. Measured by
   `npm test`.
3. From a second computer on the network, the pages load and an action is recorded with that computer's address
   (REQ-015). Measured by the by-hand LAN check, with its output recorded.
4. With a real model, one full journey works: from the Front desk through a blocked job and its answer to completion
   (REQ-002, REQ-004, REQ-005, REQ-008). Measured by a by-hand run, with its result recorded.
5. Every page passes the style review, and contrast and keyboard checks pass (REQ-016, REQ-020).
6. A file from the export download starts a new instance through `bob import` with its jobs (REQ-012). Measured by
   AC-012.1.

## Implementation Order

1. **The shell.** The served files, style, sidebar, addresses and the browser test setup. Delivers REQ-001, REQ-016,
   REQ-017. Depends on nothing else here.
2. **See the work.** Board and Job page, read-only, with live activity, the shared stream for the conversations pages
   follow, the `order` input of `conversations.entries`, staying within the browser's connections, delta size bounded by
   what an entry adds (AC-019.3), and the connection banner and recovery on the tab's feed connection. Delivers REQ-002,
   REQ-003, REQ-005, REQ-014, REQ-018, REQ-019, S-003 REQ-006's stream and S-004 REQ-015's "related changed" delta.
   Depends on phase 1.
3. **Steer the work.** Answering, editing, cancelling, Stop, Redirect, conversation controls, the Front desk and
   refusals. Delivers REQ-004, REQ-006, REQ-007, REQ-008, REQ-013, REQ-015 and S-004 REQ-008's block after a stop.
   Depends on phase 2.
4. **Shape and back up.** Roles, Workspaces, Status and the export route and download. Delivers REQ-009, REQ-010,
   REQ-011, REQ-012, S-003 REQ-016. Depends on phase 1.
5. **Finish.** Browser coverage, the manual chapter, the by-hand checks and `docs/system_overview.html`. Delivers
   REQ-020, REQ-021, REQ-022. Depends on phases 3 and 4.

## Open Questions

Both were for the Architect, and Feature Architecture resolved them. Neither changes the behaviour above.

- **Resolved by ADR-006. Technology preference from the product owner:** the look of The Round Table, built with
  Next.js, Tailwind, shadcn with Radix and lucide icons, and writing the pages in TypeScript. It's a preference to weigh
  against `bob`'s setup, which has no compile step, and S-003 REQ-008's serving of files from the package.
- **Resolved in `docs/development/tech_stack.md`. Browser test tooling.** It was left to this spec's architecture.
  REQ-021 needs one that covers the target browsers.

## Amendment Log

| Date | What changed | Why | Affected tasks |
|------|-------------|-----|----------------|
| 2026-11-06 | v0.2. Interfaces: the service calls table adds `daemon.status` for every page; the Front desk row names the shared `scope=conversations` stream; a Contract adds `conversations.entries`' optional `order` input, ascending by default, and pages use `"descending"`; the Job page row also names the shared stream. Assumptions and Dependencies names that Contract as the source of `order`. Implementation Order phase 2 delivers it and names the shared stream. Open Questions: both marked resolved. Assumptions and Dependencies: "Browser connections" points to ADR-007 and "Delta size" to ADR-008. No REQ or AC changed. S-002 isn't amended. | Spec findings from Feature Architecture. Driving ADRs: ADR-006 (technology preference), ADR-007 (decisions 4, 6 and 9, and the shared stream), ADR-008 (delta size). | None; S-006 isn't broken down yet |
| 2026-11-07 | v0.3. REQ-006 names a conversation waiting for a worker thread, as built, and REQ-015 says "directly in the browser". REQ-003, REQ-015, Exclusions ("Names on actions") and Attribution: a job a team member creates directly records the way in and the network address; a job the front desk creates records the way in and the front desk, with no address, as S-004 REQ-003 and REQ-021 state; the origin shows what it has. AC-015.1 and AC-015.2 say "creates a job directly". New AC-015.3. REQ-006: no Stop on the lead of a To do job, and the block after Stop concerns an In progress job's lead. New AC-006.6. Workflow follows. Implementation Order: REQ-014 and the connection banner move from phase 1 to phase 2, where they were built. Assumptions: "Delta size" is past tense, and the S-004 v0.14 dependency is named. No identifier retired. REQ-016 stays authoritative for the banner colour. | Spec-truth reconciliation, findings F3, F4, F5 (wording), F7 and F12. Product owner accepted the rulings on 2026-11-07. Driving ADR: ADR-008 for the delta text. | T-271, T-272, T-274 |
| 2026-11-07 | spec-truth reconciliation — FAIL | Work in e0e19728..788e9c45 against v0.2: REQ-021 and Success Criterion 1 unproven (no CI, no Edge), AC-016.1 review incomplete, front desk and follow-up origins, a To do lead's Stop, stale text; follow-ups routed | none |
| 2026-11-07 | spec-truth reconciliation — FAIL | v0.3 confirmed for REQ-003, REQ-006, REQ-015, AC-006.6, AC-015.3 and AC-016.1 in Chrome; REQ-021, AC-021.1 and Success Criterion 1 unproven, T-273 blocked on the product owner's push decision; manual sentence on a job's origin untrue, follow-up routed; read limited to 75c7c946..0604b54f | none |
| 2026-11-07 | v0.4. REQ-021: the required browsers are current Chrome and Firefox on desktop. Edge is good to have: its tests run where it is installed and skip where it isn't, and an Edge failure on a machine that has Edge still fails. Safari stays as it was. AC-021.1 and Success Criterion 1 follow. No identifier retired. S-000 names no browser and doesn't change. | Product owner decision: "About T-273, since we are not releasing for windows, I suggest the tests in Edge are just good to have and will skip if there is no Edge browser available." | T-273, T-278 |
