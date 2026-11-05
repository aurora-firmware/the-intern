---
id: S-005
title: Command line
version: '0.3'
status: approved  # draft | review | approved | superseded
created: '2026-11-03'
author: planner
---

# Command line

## Purpose

This spec covers S-000's **Command line** component. Today `bob` only runs the daemon (`bob serve`): a team member on
the machine has no command to talk to The Intern, create or answer a job, watch work, steer an agent, shape roles or
move the database, although the Intern service (S-002, S-003), the job record (S-004) and the front desk (S-001
REQ-021 to REQ-025) already offer every operation those need. S-004 left the presentation of jobs on the terminal and
the name of the import command to this spec. When it is done, `bob` has one command group per component, each command
calls Intern service operations through S-003's client library and prints readable text or, with `--json`, the
service's answer unchanged, and scripts can rely on its command names, `--json` output and exit codes (Success
Criteria).

## Definitions

This spec uses the Definitions of S-001 to S-004 (team member, job, short number, front desk, conversation, seat,
role, workspace, way in, service operation, observation feed, client library, local socket) and the shared vocabulary
of `docs/system_overview.html`. It adds these terms:

| Term | Meaning in this spec |
|---|---|
| Command | One thing `bob` does: a group and a verb (`bob jobs list`), or a top-level command (`bob chat`). |
| Group | The first word of a grouped command, one noun per S-000 component or service area: `jobs`, `conversations`, `roles`, `workspaces`, `models`. |
| Top-level command | A command with no group: `chat`, `follow`, `status`, `usage`, `serve`, `export`, `import`. |
| Reserved group | A group name kept for a later spec (`schedules`, `triggers`, `skills`, `instructions`, `knowledge`, `mail`). It has no command yet (REQ-001). |
| Data command | A command that prints data from the service: every command except `serve` and `import` (REQ-003). |
| Following command | A command that keeps printing changes until it ends or the team member stops it: `bob chat`, `bob follow`, `bob jobs follow` (REQ-015). |
| Text output | The readable lines a data command prints by default. Its wording is not a contract. |
| JSON output | What a data command prints with `--json`: the service's answer unchanged, one JSON value per line when following (REQ-003). |
| Terminal | Standard input and output connected to a terminal (a TTY). |

## Users and Journeys

| Actor | Goal |
|---|---|
| Team member on the machine | Talks to The Intern, gives and manages jobs, watches work, steers agents, shapes roles and workspaces, and runs, backs up and moves the instance, all from a shell on the machine. |
| A script, run by hand or by cron | Calls `bob` with `--json` and acts on its JSON output and exit code. |
| Later specs (downstream) | Schedules and triggers, Skills and instructions, Team knowledge and Email add their command groups under the names and conventions this spec reserves. |
| Developer | Tests every command against a test daemon on the fake model, and checks the manual's command reference against `bob --help`. |

Journeys, in priority order:

1. **Talk to The Intern.** `bob chat` opens the front desk, shows its recent history and reads lines; a line typed
   while it is busy queues, Ctrl-C stops the current turn and drops the queued lines, naming them, Ctrl-D leaves,
   and the chat reconnects when the daemon restarts. Without a terminal it answers the lines piped to it and exits.
   Delivered by REQ-009, REQ-010, REQ-015.
2. **Give and manage jobs directly.** `bob jobs create`, `list`, `show`, `update`, `answer`, `complete`, `cancel` and
   `relate`; jobs created here have the origin letter `C`. Delivered by REQ-004, REQ-005.
3. **Watch work.** `bob jobs follow C-7` until the job is Done, `bob follow` for the whole instance, `bob status` and
   `bob usage`. Delivered by REQ-006, REQ-007, REQ-008, REQ-015.
4. **Steer agents.** `bob conversations list`, `show`, `send`, `stop`, `reset`, `seat` and `compact`. Delivered by
   REQ-011.
5. **Shape the team.** `bob roles`, `bob workspaces` and `bob models list`. Delivered by REQ-012.
6. **Run and move the instance.** `bob serve`, `bob export` while the daemon runs and `bob import` while it is
   stopped. Delivered by REQ-013, REQ-014.
7. **Script against `bob`.** Every data command takes `--json`, prints errors on standard error and exits with a
   documented code. Delivered by REQ-001, REQ-002, REQ-003.

## Exclusions

What this specification explicitly does NOT cover:

- **A full-screen terminal interface.** `bob` prints plain lines, `bob chat` included. A pi-style full-screen view is
  left to a later change, if ever.
- **Remote daemons.** `bob` reaches only the daemon on the machine, through the local socket. Reaching The Intern
  from elsewhere is the web interface's, through the network listener; `bob` has no `--host` option and no login.
- **State or logic of its own.** `bob` keeps no configuration file, cache or local history, and resolves no short
  number itself: the service validates, resolves and refuses (REQ-016).
- **Commands for later components.** Schedules, triggers, skills, instructions, knowledge sources and mail get only
  their reserved group names here (REQ-001); their specs add the commands.
- **Shell completion and colour themes.** This version prints plain output, with colour only on a terminal.
- **A raw operation command.** There is no `bob call <operation> <json>` and no command generated from the operation
  catalogue (Alternatives Considered).
- **An install launcher.** Installation and service setup puts `bob` on the `PATH`; until then it runs as
  `node src/cli/bob.ts`.
- **Mail to the front desk and presentation in the browser.** Email doesn't reach the front desk (S-001), and the web
  chat and board belong to the Web interface spec.

## Alternatives Considered

- **Commands generated from the operation catalogue** (`bob jobs.create --title …`). Rejected: almost no code per
  operation, but the output is raw, the names follow operations instead of what a team member does (no
  `bob jobs answer`), short numbers need special cases anyway, and it fights the decision to print text by default and
  JSON for scripts.
- **Curated commands plus a raw `bob call <operation> <json>` escape hatch.** Rejected: full reach for scripts and
  debugging, but a second, unpolished way to do everything, and the manual would have to explain which to use.
- **Verb, then noun** (`bob list jobs`). Rejected: the top level crowds as later groups arrive.
- **JSON-only or text-only output.** Rejected: team members read text, scripts need a stable shape, so both exist.
- **A full-screen terminal interface for chat and follow.** Rejected for this version: plain lines work in pipes,
  scripts and any terminal.
- **`bob jobs export` and `bob jobs import`.** Rejected: the copy holds the whole database, conversations included,
  not only jobs, so the commands are top-level.

## Interfaces

### Exposed: the `bob` commands

**Contract** (command names and the operations each calls; `<job>` is a job ID or short number in any letter case,
resolved by the service, S-004 REQ-002):

| Command | Operations called | Requirement |
|---|---|---|
| `bob jobs create <text>` | `jobs.create`, with the title, role, model, thinking level, workspace and stated name the team member gives (S-004 REQ-007) | REQ-004 |
| `bob jobs list` | `jobs.list`, filtered by status, origin letter and Related job, with a limit and a cursor (S-004 REQ-014) | REQ-004 |
| `bob jobs show <job>` | `jobs.get`, then `jobs.worklog.list` and `jobs.history.list` (S-004 REQ-010, REQ-011, REQ-014) | REQ-004 |
| `bob jobs update <job>` | `jobs.update`: title, description, definition of done (S-004 REQ-004) | REQ-004 |
| `bob jobs relate <job> <job>`, `bob jobs unrelate <job> <job>` | `jobs.relate`, `jobs.unrelate` (S-004 REQ-009) | REQ-004 |
| `bob jobs complete <job> <justification>`, `bob jobs cancel <job> <justification>` | `jobs.complete`, `jobs.cancel` (S-004 REQ-005, REQ-007) | REQ-004 |
| `bob jobs answer <job> <text>` | `jobs.get` for the lead conversation, then `conversations.submit` to it (S-001 REQ-020; S-004 REQ-006) | REQ-005 |
| `bob jobs follow <job>` | `jobs.get`, `jobs.history.list`, `conversations.list` and `conversations.get` for the job's conversations, the instance feed filtered to the job, and the conversation feed and `conversations.entries` of each of its conversations (S-002 REQ-014; S-004 REQ-015) | REQ-006 |
| `bob follow` | the instance feed (S-002 REQ-014) | REQ-007 |
| `bob status` | `daemon.status` (S-002 REQ-003) | REQ-008 |
| `bob usage` | `usage.get` for the total, `conversations.list`, then `usage.get` for each conversation (S-002 REQ-012) | REQ-008 |
| `bob chat` | `desk.get`, `conversations.entries`, the conversation feed, `conversations.submit` for each line, `conversations.abort` and `submissions.get` on Ctrl-C, `submissions.wait` after Ctrl-D, and `submissions.wait` and `conversations.entries` after each line without a terminal (S-001 REQ-021; S-002 REQ-012) | REQ-009, REQ-010 |
| `bob chat --reset` | `desk.get`, `conversations.reset` (S-001 REQ-024), then as `bob chat` | REQ-009 |
| `bob conversations list` | `conversations.list`, optionally for one job, with `jobs.get` first to name that job (S-001 REQ-016) | REQ-011 |
| `bob conversations show <id>` | `conversations.get`, `conversations.entries`, `conversations.invocations` (S-001 REQ-016) | REQ-011 |
| `bob conversations send <id> <text>` | `conversations.submit`, busy mode steer unless the team member names follow-up or reject (S-001 REQ-020) | REQ-011 |
| `bob conversations stop <id>` | `conversations.abort` (S-001 REQ-008) | REQ-011 |
| `bob conversations reset <id>` | `conversations.reset` (S-001 REQ-011) | REQ-011 |
| `bob conversations seat <id>` | `conversations.seat`: role, model, thinking level, workspace, optional reset and note (S-001 REQ-004, REQ-011) | REQ-011 |
| `bob conversations compact <id>` | `conversations.compact`, with optional instructions (S-002 REQ-012) | REQ-011 |
| `bob roles list`, `bob roles show <name>` | `roles.list` (S-001 REQ-003) | REQ-012 |
| `bob roles create`, `change`, `remove`, `restore` | `roles.create`, `roles.change`, `roles.remove`, `roles.restore` (S-001 REQ-003; S-002 REQ-022) | REQ-012 |
| `bob workspaces list`, `register`, `unregister` | `workspaces.list`, `workspaces.register`, `workspaces.unregister` (S-001 REQ-018) | REQ-012 |
| `bob models list` | `models.list` (S-002 REQ-012) | REQ-012 |
| `bob export <file>` | `jobs.export`, with the file made absolute against the current directory (S-004 REQ-016) | REQ-013 |
| `bob import <file>` | none: S-004's import step, in-process (S-004 REQ-017) | REQ-013 |
| `bob serve` | none: runs the daemon (S-002 Interfaces, the `bob serve` command) | REQ-014 |

The names of the options other than `--json`, `--runtime-dir` and `--help`, and the layout of text output, are not
contract; the tasks fix them and the manual's command reference records them (REQ-017). Every option a command takes
maps to the input of the same meaning in the operation it calls.

### Exposed: conventions every group follows

**Contract:**

- `bob <group> <verb> [arguments] [options]`; the verbs `list`, `show`, `create`, `change` and `remove` where they
  apply.
- `--json` on every data command; `--help` on `bob`, every group and every command.
- `--runtime-dir <dir>`, else the environment variable `BOB_RUNTIME_DIR`, else the runtime directory S-002 REQ-006
  resolves, names the directory of the daemon's `bob.sock` (REQ-002).
- Data on standard output; errors, notices and hints on standard error.
- Exit codes: `0` success; `1` the service refused or failed, with its error code and message on standard error; `2`
  a usage error, or a reserved group; `3` the daemon can't be reached (REQ-003).
- With `--json`, standard output holds the service's answer unchanged. A `show` command that calls several
  operations prints one JSON object keyed by operation name, each value that operation's answer unchanged (for
  example `{ "jobs.get": …, "jobs.worklog.list": …, "jobs.history.list": … }`). `bob usage` prints
  `{ "total": …, "conversations": { "<id>": … } }`, each value a `usage.get` answer unchanged. A following command
  prints one JSON value per line: each feed snapshot or delta, or each answer it waits for.
- Reserved groups: `schedules`, `triggers`, `skills`, `instructions`, `knowledge`, `mail`.

### Consumed

- S-003's client library over the local socket (S-003 REQ-009), with its socket override, its "unreachable" error and
  both feed scopes; the local socket records way in `command line` for every call (S-003 REQ-001, REQ-007).
- The operation catalogue, its error codes and the observation feed of S-002 (REQ-012, REQ-013, REQ-014, REQ-015),
  including `desk.get` (S-002 v0.10).
- S-004's import step (REQ-017) and the instance directories of S-002 REQ-006.

## Workflow

A command, from the shell to its exit code:

```
bob <group> <verb> … or bob <top-level command> …
  ↓
Unknown command, flag or missing argument → the group's usage on standard error, exit 2      REQ-001
Reserved group → "not available yet", exit 2                                                REQ-001
  ↓
serve → runs the daemon (S-002)                                                             REQ-014
import → S-004's import step, daemon stopped; refused while a daemon holds the lock, exit 1  REQ-013
  ↓
Socket: --runtime-dir, else BOB_RUNTIME_DIR, else the default runtime directory             REQ-002
  ↓
Call the operation(s) through the client library                                            REQ-004 to REQ-013
  (no daemon answers → "The Intern isn't running here (<path>); start it with bob serve", exit 3)  REQ-002
  (service refusal → its code and message on standard error, exit 1)                         REQ-003
  ↓
Print text, or the answer unchanged with --json; exit 0                                     REQ-003
```

A following command (`bob chat`, `bob follow`, `bob jobs follow`):

```
Subscribe: snapshot, then deltas, printed as lines                                          REQ-006, REQ-007, REQ-009
  ├─ chat: each typed line → conversations.submit (queued while busy); Ctrl-C → abort the
  │        turn, queued lines dropped and named, chat stays open; Ctrl-D → exit 0            REQ-009
  ├─ chat without a terminal: submit each line, wait until it settles, print its answer,
  │        exit 0 at end of input                                                           REQ-010
  └─ jobs follow: exits 0 when the job is Done                                               REQ-006
Daemon unreachable or unavailable → notice on standard error, reconnect when it is back      REQ-015
Feed ends "lagging" → subscribe again                                                       REQ-015
  → fresh snapshot, then entries read from the last one seen, then deltas                   REQ-015
```

## Behavioral Requirements

The service tests run `bob` as a child process against a test daemon on the fake model (S-002 Definitions), with its
runtime directory named by `--runtime-dir`.

### REQ-001 — Command shape, help and reserved groups

`bob` SHALL take a group and a verb (`bob jobs list`) or a top-level command (`chat`, `follow`, `status`, `usage`,
`serve`, `export`, `import`), with the groups and commands of Interfaces. `bob --help`, `bob <group> --help` and
`bob <group> <verb> --help` SHALL print the usage of that level on standard output and exit 0. An unknown command or
flag, or a missing argument, SHALL print the usage of the group concerned on standard error and exit 2. The reserved
groups SHALL NOT appear in help; a command in one of them SHALL print that the group isn't available yet and exit 2.

#### AC-001.1 — Help at each level

- **Given:** `bob`
- **When:** a team member runs `bob --help`, `bob jobs --help` and `bob jobs list --help`
- **Then:** each prints the usage of that level and exits 0, and none lists a reserved group

**Verification:** test — a unit test of argument parsing and a service test running `bob` as a child process.

#### AC-001.2 — Usage errors

- **Given:** `bob`
- **When:** a team member runs `bob jbos list`, `bob jobs list --bogus` and `bob jobs show` with no job
- **Then:** each prints the usage of the group concerned on standard error, prints nothing on standard output, calls no
  operation and exits 2

**Verification:** test — a unit test of argument parsing and a service test running `bob` as a child process.

#### AC-001.3 — A reserved group

- **Given:** `bob`
- **When:** a team member runs `bob schedules list`
- **Then:** it prints on standard error that schedules aren't available yet and exits 2

**Verification:** test — a service test running `bob` as a child process.

### REQ-002 — Reaching the daemon

Every command that calls the service SHALL use the socket `bob.sock` in the runtime directory named by
`--runtime-dir`, else by the environment variable `BOB_RUNTIME_DIR`, else resolved as S-002 REQ-006 resolves it, and
SHALL pass it to the client library's socket override (S-003 REQ-009). When no daemon answers on that socket, the
command SHALL print "The Intern isn't running here (<path>); start it with `bob serve`" on standard error, naming the
socket path, and exit 3.

#### AC-002.1 — The runtime directory is chosen in order

- **Given:** a test daemon whose runtime directory is a temporary folder
- **When:** `bob status` runs with `--runtime-dir` naming it, with only `BOB_RUNTIME_DIR` naming it, and with both set
  to different folders
- **Then:** the first two reach the daemon, and the third uses the folder `--runtime-dir` names

**Verification:** test — a service test running `bob` as a child process.

#### AC-002.2 — No daemon

- **Given:** a runtime directory with no daemon
- **When:** any command that calls the service runs, for example `bob jobs list`
- **Then:** it prints "The Intern isn't running here (<path>/bob.sock); start it with `bob serve`" on standard error
  and exits 3

**Verification:** test — a service test running `bob` as a child process.

### REQ-003 — Output and exit codes

Every data command SHALL print text output by default and, with `--json`, the service's answer unchanged on standard
output, one JSON value per line for a following command. Errors, notices and hints SHALL go to standard error and data
to standard output. A command SHALL exit 0 on success; 1 when the service refuses or fails, printing the service's
error code and message on standard error; 2 on a usage error; 3 when the daemon can't be reached (REQ-002). Text output
SHALL use colour only when standard output is a terminal. Command names, `--json` output and exit codes are a
contract: changing them needs an amendment of this spec.

#### AC-003.1 — Text and JSON

- **Given:** a test daemon
- **When:** `bob jobs create "Check why the nightly build is slow"` runs, then the same with `--json`
- **Then:** the first prints `C-n created (To do)` and the second prints exactly the job `jobs.create` returns, whose
  origin letter is `C`; both exit 0

**Verification:** test — a service test running `bob` as a child process, comparing the JSON with the operation's
answer.

#### AC-003.2 — A service refusal

- **Given:** job `C-7` In progress
- **When:** `bob jobs complete C-7 ""` runs with an empty justification
- **Then:** it prints the service's `invalid_input` code and message on standard error, nothing on standard output,
  and exits 1

**Verification:** test — a service test running `bob` as a child process.

#### AC-003.3 — The JSON shape and exit codes per group

- **Given:** a test daemon
- **When:** one read command and one control command of each group, and each top-level data command, run with
  `--json`, and each once with input the service refuses
- **Then:** each JSON output equals the answer of the operation it calls, or for a command that calls several
  operations has the shape Interfaces names, and each exit code is 0 or 1 as the call succeeded or was refused

**Verification:** test — a service test running `bob` as a child process.

#### AC-003.4 — No colour outside a terminal

- **Given:** a test daemon
- **When:** `bob jobs list` runs with its output piped
- **Then:** the output holds no terminal control sequence

**Verification:** test — a unit test of output formatting and a service test running `bob` as a child process.

### REQ-004 — Job commands

`bob jobs create`, `list`, `show`, `update`, `relate`, `unrelate`, `complete` and `cancel` SHALL call the operations
of Interfaces with the arguments and options given and print the result. `bob jobs create` SHALL print the new job's
short number and status. `bob jobs list` SHALL print one line per job with its short number, status, title and, when
Blocked, its Blocked reason. `bob jobs show` SHALL print the job's title, status, Blocked reason or resolution,
description, definition of done, Related jobs, latest worklog entries and history. A job created with `bob` has the
origin letter `C`, because the local socket records way in `command line` (S-003 REQ-007; S-004 REQ-002).

#### AC-004.1 — Create, list and show

- **Given:** a test daemon with jobs in each status
- **When:** a team member runs `bob jobs create "Check why the nightly build is slow"`, `bob jobs list --status
  blocked` and `bob jobs show c-7`
- **Then:** the first prints `C-n created (To do)`; the second prints one line per Blocked job with its number,
  status, title and Blocked reason; the third prints `C-7`'s definition of done, status, latest worklog and history,
  whatever the letter case given

**Verification:** test — a service test running `bob` as a child process.

#### AC-004.2 — Update, relate, complete and cancel

- **Given:** jobs `C-7` and `W-9` In progress, `C-7` with a definition of done
- **When:** a team member updates `C-7`'s title, relates it to `W-9`, completes `C-7` and cancels `W-9`, each with a
  justification where one is needed
- **Then:** each command prints the changed job, exits 0, and `jobs.get` shows the same changes

**Verification:** test — a service test running `bob` as a child process.

### REQ-005 — Answering a job

`bob jobs answer <job> <text>` SHALL read the job with `jobs.get` and submit the text to its lead conversation with
`conversations.submit`, so the input is recorded with way in `command line`, and print that it was sent to the job's
lead. Input to the lead of a Blocked job resumes it (S-001 REQ-020; S-004 REQ-006). A Done job's lead
conversation is closed, so the service refuses the input `conflict` (S-001 REQ-026); an unknown job is refused
`not_found`. Either way the command exits 1 and prints the service's error. When `jobs.get` returns no
`leadConversation`, the command submits nothing, prints that the job has no lead conversation and exits 1.

#### AC-005.1 — An answer resumes a Blocked job

- **Given:** job `W-3` Blocked, its lead conversation parked
- **When:** a team member runs `bob jobs answer W-3 "use the staging database"`
- **Then:** it prints `sent to W-3's lead` and exits 0, the lead's transcript holds the text with way in
  `command line`, and `W-3` is In progress

**Verification:** test — a service test running `bob` as a child process on the fake model.

#### AC-005.2 — An answer the job can't take

- **Given:** a completed job, a job cancelled before its lead conversation was created, and a job ID no job has
- **When:** a team member runs `bob jobs answer` with each
- **Then:** each exits 1: the completed job with `conflict`, the cancelled one with the message that the job has no
  lead conversation, and the unknown one with `not_found`; no input is submitted

**Verification:** test — a service test running `bob` as a child process on the fake model.

### REQ-006 — Following a job

`bob jobs follow <job>` SHALL print the job's current status, then, as lines, the job's status changes, edits and
worklog entries from the instance feed and the activity of each of the job's conversations from their conversation
feeds, subscribing to each conversation of the job as it appears. It SHALL exit 0 when the job is Done, printing its
resolution, or when the team member presses Ctrl-C. A job that is already Done prints its resolution and exits 0.

#### AC-006.1 — Follow until Done

- **Given:** job `C-7` whose lead invokes an agent and then completes the job
- **When:** a team member runs `bob jobs follow C-7`
- **Then:** it prints the status changes and the activity of the lead and the invoked agent in order, prints the
  resolution when `C-7` is Done and exits 0

**Verification:** test — a service test running `bob` as a child process on the fake model.

### REQ-007 — Following the instance

`bob follow` SHALL print the instance feed as lines: jobs created, changing status, blocked with their reason and
done, and agents starting and stopping runs, until the team member presses Ctrl-C, when it exits 0.

#### AC-007.1 — The instance as lines

- **Given:** a running `bob follow`
- **When:** a job is created, blocks, resumes and completes
- **Then:** one line appears for each, with the Blocked reason on the block and the resolution on the completion, and
  lines for the lead's runs starting and stopping

**Verification:** test — a service test running `bob` as a child process on the fake model.

### REQ-008 — Status and usage

`bob status` SHALL print the daemon status (`daemon.status`: phase, versions, start time, instance directories,
worker threads in use and waiting), and `bob usage` the usage per conversation and in total (`usage.get`). With
`--json`, `bob usage` SHALL print one object that holds both, in the shape Interfaces names.

#### AC-008.1 — Status and usage

- **Given:** a ready test daemon with one finished run
- **When:** a team member runs `bob status` and `bob usage`, each also with `--json`
- **Then:** the text names the phase "ready" and the worker threads, and the usage of that run; the `bob status` JSON
  equals the `daemon.status` answer, and the `bob usage` JSON holds the `usage.get` answers for the total and for each
  conversation, unchanged

**Verification:** test — a service test running `bob` as a child process.

### REQ-009 — Chat on a terminal

On a terminal, `bob chat` SHALL open the front desk (`desk.get`), print its recent history (`conversations.entries`)
and a prompt, and then:

- submit each line the team member types with `conversations.submit` as a follow-up, so a line typed while the front
  desk is busy queues and is answered after the current one (S-001 REQ-020)
- print the front desk's answers from the conversation feed as they stream
- on Ctrl-C, stop the current turn with `conversations.abort` and keep the chat open. The abort also withdraws the
  input still queued (S-001 REQ-008), so `bob` reads the state of each line it submitted and not yet answered
  (`submissions.get`) and prints on standard error each line that was dropped, so the team member can send it again
- on Ctrl-D, exit 0

`bob chat --reset` SHALL reset the front desk with `conversations.reset` (S-001 REQ-024), then open it as above.

#### AC-009.1 — A chat with a queued line

- **Given:** the front desk with earlier messages
- **When:** a team member runs `bob chat`, types "what's running?" and, while the answer streams, a second line
- **Then:** the chat shows the last messages and a prompt, streams the first answer, then answers the second line,
  and both lines are in the front desk's transcript with way in `command line`

**Verification:** test — a service test driving `bob chat` on a pseudo-terminal on the fake model.

#### AC-009.2 — Ctrl-C and Ctrl-D

- **Given:** a running `bob chat` whose front desk is answering, with a second line queued
- **When:** the team member presses Ctrl-C, types another line, then presses Ctrl-D
- **Then:** the turn stops and the chat stays open, the queued line is not answered and `bob` names it as dropped on
  standard error, the line typed after Ctrl-C is answered, and `bob chat` exits 0

**Verification:** test — a service test driving `bob chat` on a pseudo-terminal on the fake model.

#### AC-009.3 — Reset

- **Given:** the front desk with entries
- **When:** a team member runs `bob chat --reset`
- **Then:** `desk.get` names the same conversation, its next context is empty, and the chat opens

**Verification:** test — a service test running `bob` as a child process on the fake model.

### REQ-010 — Chat without a terminal

When standard input or output isn't a terminal, `bob chat` SHALL show no prompt, history or colour; it SHALL submit
each line of standard input in turn and wait for the submission to settle, calling `submissions.wait` again each time
a wait ends with the submission still unsettled (each wait lasts at most 5 minutes, S-002 REQ-012). It SHALL then read
the front desk's answer with `conversations.entries`, print it and, at the end of input, exit 0.

#### AC-010.1 — A piped question

- **Given:** jobs, two of them Blocked
- **When:** a script runs `echo "what's blocked?" | bob chat`
- **Then:** it prints the front desk's answer and nothing else on standard output, and exits 0

**Verification:** test — a service test running `bob` as a child process on the fake model.

#### AC-010.2 — An answer longer than one wait

- **Given:** a client whose first `submissions.wait` for the piped line returns the submission unsettled, and whose
  second returns it settled
- **When:** `bob chat` reads "what's running?" from a pipe
- **Then:** `bob` waits a second time, reads the answer with `conversations.entries`, prints it once, and exits 0

**Verification:** test — a unit test of `bob chat` with a client whose waits are scripted.

#### AC-010.3 — Standard output redirected

- **Given:** a terminal on standard input and standard output redirected to a file
- **When:** a team member runs `bob chat`, types a line and presses Ctrl-D
- **Then:** the file holds only the front desk's answer, with no prompt, history or control sequence, and `bob` exits 0

**Verification:** test — `test/service/bob_chat_terminal.test.ts` ("bob chat with standard output redirected").

### REQ-011 — Conversation commands

`bob conversations list`, `show`, `send`, `stop`, `reset`, `seat` and `compact` SHALL call the operations of
Interfaces and print the result: `list` one line per conversation with its id, job and lead flag or the front-desk
mark, seat, status and last activity; `show` the conversation, its transcript with seat records and attribution,
and the conversations it invoked, recursively (`conversations.invocations`); `send` that the message was submitted,
steered or held. A closed conversation (S-001 REQ-026) lists with status `closed`, and `send`, `stop`, `reset`,
`seat` and `compact` on it are refused `conflict` by the service and exit 1.

#### AC-011.1 — Steer a conversation

- **Given:** a job whose lead conversation runs
- **When:** a team member runs `bob conversations list --job C-7`, `bob conversations send <id> "check the logs
  first"`, `bob conversations show <id>` and `bob conversations stop <id>`
- **Then:** the list shows `C-7`'s conversations, the transcript holds the steer with way in `command line`, and the
  conversation is aborted; each exits 0

**Verification:** test — a service test running `bob` as a child process on the fake model.

#### AC-011.2 — Seat, reset and compact

- **Given:** a conversation seated as `bob`
- **When:** a team member runs `bob conversations seat <id>` naming `gp`, then `reset` and `compact` on it, and once
  more `seat` naming an unknown role
- **Then:** the seat record names `gp` and way in `command line`, the reset and compaction appear in the transcript,
  and the unknown role is refused with exit 1 and the seat unchanged

**Verification:** test — a service test running `bob` as a child process on the fake model.

#### AC-011.3 — Invoked conversations

- **Given:** a lead conversation that invoked two agents, one of which invoked its own
- **When:** a team member runs `bob conversations show` on the lead conversation, also with `--json`
- **Then:** the output lists the three invoked conversations under their invokers, and the JSON holds the answer of
  `conversations.invocations` unchanged

**Verification:** test — a service test running `bob` as a child process on the fake model.

#### AC-011.4 — A closed conversation

- **Given:** a conversation of a Done job
- **When:** a team member runs `bob conversations list`, then `send`, `stop`, `reset`, `seat` and `compact` on it
- **Then:** the list shows it with status `closed`, and each of the other commands exits 1 with `conflict`

**Verification:** test — a service test running `bob` as a child process on the fake model.

### REQ-012 — Roles, workspaces and models

`bob roles list`, `show`, `create`, `change`, `remove` and `restore`, `bob workspaces list`, `register` and
`unregister`, and `bob models list` SHALL call the operations of Interfaces and print the result. `bob roles show
<name>` SHALL print that role from `roles.list`, and exit 1 naming the role when the list holds none of that name.

#### AC-012.1 — Shape a role and a workspace

- **Given:** a test daemon and an owner-only folder
- **When:** a team member registers the folder, creates a role with it as default workspace, changes the role, shows
  it, removes it, unregisters the folder, and tries to remove `bob`
- **Then:** each change is listed by `bob roles list` and `bob workspaces list`, and the removal of `bob` is refused
  with exit 1

**Verification:** test — a service test running `bob` as a child process.

#### AC-012.2 — Models

- **Given:** a test daemon on the fake model
- **When:** a team member runs `bob models list`
- **Then:** it prints the models and thinking levels `models.list` returns

**Verification:** test — a service test running `bob` as a child process.

### REQ-013 — Export and import

`bob export <file>` SHALL call `jobs.export` with the file made absolute against the current directory and print the
path and size written (S-004 REQ-016). `bob import <file>` SHALL run S-004's import step in-process for the instance
its directory flags or defaults name, the same flags as `bob serve`, under the single-owner lock, and SHALL refuse,
with the step's message and exit 1, while a daemon holds the lock or in any other case S-004 REQ-017 refuses
(S-002 REQ-001).

#### AC-013.1 — Back up and restore

- **Given:** a test daemon running jobs
- **When:** a team member runs `bob export backup.db`, stops the daemon, and runs `bob import backup.db` for a new
  instance
- **Then:** the export prints the absolute path and size and the jobs go on; the import succeeds, and the new
  instance starts with every job of the export

**Verification:** test — a service test running `bob` as a child process with two temporary instances.

#### AC-013.2 — Import while running

- **Given:** a running daemon
- **When:** a team member runs `bob import backup.db` for its instance
- **Then:** it prints the lock holder's message on standard error, changes nothing and exits 1

**Verification:** test — a service test running `bob` as a child process.

### REQ-014 — Running the daemon

`bob serve` SHALL keep the contract of S-002 Interfaces: its flags, its log on standard error, nothing on standard
output and its exit statuses. It is not a data command and takes no `--json`.

#### AC-014.1 — serve is unchanged

- **Given:** the existing `bob serve` tests
- **When:** they run after the command groups are added
- **Then:** they pass unchanged, except that the cases that run `bob` with no command or an unknown one expect the
  top-level usage, as REQ-001 and AC-001.2 require; those cases test the top level, not `bob serve`

**Verification:** test — the existing `bob serve` service tests.

## Quality Requirements

### REQ-015 — Following survives restarts and lag

When the daemon can't be reached during `bob chat`, `bob follow` or `bob jobs follow`, or answers `unavailable`
because it is starting or stopping (S-003 AC-009.2), the command SHALL print a notice on standard error, keep trying,
and when the daemon answers again subscribe again. When a feed ends with `lagging` (S-002 REQ-015, 1000 undelivered
deltas), the command SHALL subscribe again. Each new subscription starts from a fresh snapshot; for each conversation
it shows, the command SHALL then read `conversations.entries` from the last entry it printed and print the entries
it missed, before the new deltas. Events of the instance feed missed in between are not replayed: the snapshot shows
the state they led to. A line submitted to the chat survives a restart and is answered after it (S-001 REQ-021);
only a Ctrl-C withdraws queued lines (REQ-009).

#### AC-015.1 — A restart while watching

- **Given:** a running `bob chat` with a line submitted and not answered, and a running `bob follow`
- **When:** the test daemon is killed and started again
- **Then:** both print a notice on standard error, reconnect, the chat prints each front-desk entry written while
  it was away, including the answer to the line, once, and `bob follow` goes on printing new events; neither exits

**Verification:** test — a service test running `bob` as a child process and restarting the test daemon.

#### AC-015.2 — A lagging feed

- **Given:** a running `bob follow`, and a running `bob jobs follow` on a job whose conversation feed ends with
  `lagging` after entries it hasn't printed
- **When:** each feed ends
- **Then:** each subscribes again without exiting; `bob jobs follow` prints the missed entries once, read from the last
  entry it printed, then the new deltas

**Verification:** test — a unit test with a client whose feed ends with `lagging`.

#### AC-015.3 — A daemon that is stopping

- **Given:** a running `bob follow`
- **When:** the daemon stops and the client gets `unavailable`, then the daemon starts again
- **Then:** `bob follow` prints a notice, waits as for an unreachable daemon, and resumes when it is ready

**Verification:** test — a service test running `bob` as a child process and restarting the test daemon.

### REQ-016 — Thin and quick

`bob` SHALL keep no state of its own: no configuration file, cache or local history, and no short-number resolution
or validation the service does. A command that only calls the service SHALL NOT load the daemon's code. As a
reference, not an acceptance threshold, `bob jobs list` answers in under half a second on a development machine.

#### AC-016.1 — No state and no daemon code

- **Given:** the `bob` entry point and its command modules
- **When:** a reviewer reads them, and runs `bob jobs list` with module loading traced
- **Then:** no file is written outside standard output and standard error, and no daemon module (host, service,
  listeners, jobs, agents) is loaded by a command other than `serve` and `import`

**Verification:** inspection — the `bob` entry point and its command modules, and the module trace of one run.

#### AC-016.2 — Reference timing

- **Given:** a ready test daemon with 100 jobs
- **When:** `bob jobs list` runs on a development machine
- **Then:** the time it took is reported beside the half-second reference, and the test passes whatever it is

**Verification:** test — a service test that prints the timing.

### REQ-017 — The command reference and the vocabulary

The user manual SHALL hold a command reference page that lists every command, its arguments and options, its JSON
output and the exit codes, matching `bob --help` for each group, and the page SHALL change in the same change as a
command. Help and messages SHALL say team member, job and invokes, and never user, subagent or task in its general
sense.

#### AC-017.1 — The reference matches the help

- **Given:** the manual's command reference page
- **When:** a reviewer compares it with `bob --help` for `bob` and each group
- **Then:** every command and option in the help is on the page with the same meaning, and the page names the exit
  codes and `BOB_RUNTIME_DIR`

**Verification:** inspection — the command reference page in `docs/manual/` against `bob --help` for each group.

#### AC-017.2 — The words of help and messages

- **Given:** the help texts and messages of `bob`
- **When:** a reviewer reads them
- **Then:** none says user, subagent or task in its general sense

**Verification:** inspection — the help texts and messages of the `bob` command modules.

## Configuration Requirements

- **Runtime directory for clients.**
  - **What:** which daemon a command reaches: the runtime directory holding its `bob.sock` (REQ-002).
  - **Where:** the `--runtime-dir` flag, else the environment variable `BOB_RUNTIME_DIR` (**Contract**: the variable
    name), else the runtime directory S-002 REQ-006 resolves.
  - **Constraints:** an absolute path, as for `bob serve`'s directory flags.
  - **Missing:** the default runtime directory; when no daemon answers there, exit 3 (REQ-002).
- **Instance directories for `bob import`.**
  - **What:** which instance's database the import step writes (REQ-013).
  - **Where:** the same directory flags as `bob serve` (S-002 REQ-006, REQ-021).
  - **Constraints:** absolute paths.
  - **Missing:** the default instance directories.

`bob` reads no configuration file of its own.

## Assumptions and Dependencies

- **S-003's client library exposes every operation and both feed scopes over the local socket.** Confirmed in
  `src/client` (S-003 REQ-009): it calls any operation by name, subscribes to the instance and conversation feeds,
  takes a socket override, and fails "unreachable" naming the socket path.
- **The service resolves short numbers in any letter case.** Confirmed in `src/service/job_record_operations.ts`
  (S-004 REQ-002).
- **Node 24's built-in argument parsing and line reading are enough; no new dependency.** Confirmed with the pinned
  Node 24.22: `parseArgs` from `node:util` with `allowPositionals` returns the group and verb as positionals and, in
  strict mode, fails an unknown option with `ERR_PARSE_ARGS_UNKNOWN_OPTION`, which REQ-001 needs; `node:readline` and
  `node:readline/promises` provide `createInterface` and keypress events for `bob chat`. `bob serve` already uses
  `parseArgs`.
- **S-001 v0.11, S-002 v0.11 and S-004 v0.9.** The front desk, `desk.get`, closed conversations and the job operations
  exist as specified.
- **S-004's import step** (REQ-017) runs in-process and holds the single-owner lock (S-002 REQ-001).
- **Installation and service setup** puts `bob` on the `PATH`; until then the manual shows `node src/cli/bob.ts`.
- **Later specs** (Schedules and triggers, Skills and instructions, Team knowledge, Email) add their groups under the
  reserved names and follow the conventions of Interfaces.

## Success Criteria

1. Every command of Interfaces runs against a test daemon on the fake model with the result its acceptance scenarios
   name, and `npm test` passes (REQ-001 to REQ-017).
2. For each group, `--json` output equals the answer of the operation it calls, and the exit codes are 0, 1, 2 and 3
   as REQ-003 states. Measured by `npm test`.
3. Live check: `bob chat` on a real model creates a job through the front desk and prints its short number, and
   `bob jobs follow` on that job prints its activity until it is Done (REQ-006, REQ-009). Measured by a live check in
   `test/live/`.
4. The manual's command reference lists every command and option `bob --help` shows for each group (REQ-017).
   Measured by inspection.
5. `bob chat` and `bob follow` survive a daemon restart without exiting (REQ-015). Measured by `npm test`.

## Implementation Order

| Phase | Outcome | Depends on |
|---|---|---|
| 1 | The command framework: groups, help, usage errors, reserved groups, the runtime directory, text and `--json` output, exit codes, `serve` kept as it is | S-003's client library |
| 2 | Job commands, `jobs answer`, `status`, `usage`, `export` and `import` | Phase 1, S-004 delivered |
| 3 | Conversations, roles, workspaces and models commands | Phase 1 |
| 4 | The following commands: `follow`, `jobs follow` and `chat`, with reconnection and lag handling | Phases 1 and 2, the front desk of S-001 v0.8 and `desk.get` of S-002 v0.10 |
| 5 | The command reference in the user manual, the live check and the spec map | Phases 1–4 |

## Open Questions

None.

## Amendment Log

| Date | What changed | Why | Affected tasks |
|------|-------------|-----|----------------|
| 2026-11-03 | v0.2. Clarifications, no change of scope: AC-014.1, the cases that run `bob` with no command or an unknown one expect the top-level usage (REQ-001); Interfaces, a `show` command that calls several operations prints one JSON object keyed by operation name; Design Principles, a command calls the operations Interfaces names, not "one or two". | Product owner approval of the keyed `--json` shape, 2026-11-03 (finding F14 of the S-001 v0.9 consistency review). Architect ruling on T-162 (AC-014.1). Reviews of T-165 (the keyed JSON) and of the plan (the number of operations). | T-162, T-165 (built as clarified) |
| 2026-11-03 | v0.2. REQ-005: a Done job's lead conversation is closed (S-001 v0.9 REQ-026), so `bob jobs answer` is refused `conflict`, and an unknown job `not_found`. REQ-011: a closed conversation lists as `closed`, and `send`, `stop`, `reset`, `seat` and `compact` on it exit 1. Architecture consistency review (finding F10), same version: REQ-005, when `jobs.get` returns no `leadConversation` the command submits nothing, prints that the job has no lead conversation and exits 1; new AC-005.2 for a completed job, a job cancelled before its lead started and an unknown job; new AC-011.4 for a closed conversation. | Product owner decision of 2026-11-03 on T-166. Architecture consistency review of the closed-conversation amendment, 2026-11-03. | T-166, T-167 |
| 2026-11-03 | v0.2, still. AC-005.2: the cancelled job is one cancelled before its lead conversation was created (S-004 REQ-007, S-001 AC-026.8). | Architecture consistency review of S-001 v0.9, 2026-11-03. | T-166, T-167 |
| 2026-11-04 | v0.3. Interfaces: the Contract names the operations `bob jobs follow`, `bob usage` and `bob conversations list --job` call. Interfaces, REQ-008, AC-008.1 and AC-003.3: `bob usage --json` prints `{ "total", "conversations" }`, holding the usage per conversation and the total. The `bob chat` row names `submissions.wait` after Ctrl-D. REQ-010: chat without a terminal also applies when standard output isn't a terminal, as Definitions and Design Principles state; new AC-010.3. Assumptions: current versions; the breakdowns are done. | PR #148 review findings, product owner decision of 2026-11-04. | None; fixed on the PR branch |
| 2026-11-05 | Same version, format only; no requirement changed. Restructured to the ai-team 0.19.0 spec layout: `## Architecture` is gone and `## Alternatives Considered` is a top-level section holding solution alternatives only. The design principles are dropped: each is a requirement, its rationale or an implementation constraint already recorded elsewhere. All alternatives stay: each is a different interface for the same need. | ai-team 0.20.0 upgrade; specs say what, the architecture documents and ADRs say how | T-185 |
