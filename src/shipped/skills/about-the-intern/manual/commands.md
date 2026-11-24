# Command reference

`bob` is the command line of The Intern. This page lists every command with its arguments, its options, the JSON it
prints with `--json` and the exit codes. `bob --help`, `bob <group> --help` and `bob <group> <command> --help` print the
same lists at each level.

The install script puts `bob` on your `PATH`; see [Installing and upgrading](installing.md). From a checkout of the
project, run it as `node src/cli/bob.ts`. Every example here writes `bob` for short; write `node src/cli/bob.ts` in its
place.

```
bob jobs list --status blocked
node src/cli/bob.ts jobs list --status blocked
```

The service decides what is valid. `bob` passes your arguments to it, prints what it answers, and keeps no
configuration file, cache or history of its own.

## Command shape

A command is a group and a verb, such as `bob jobs list`, or a top-level command, such as `bob chat`. The top-level
commands are `serve`, `status`, `usage`, `export`, `import`, `follow`, `chat`, `upgrade`, `rollback` and `uninstall`.
The groups are `jobs`, `conversations`, `roles`, `workspaces`, `models`, `schedules`, `skills`, `instructions`, `mail`
and `service`.

In the usage lines below, `<name>` is a required argument. Options come after the arguments and take a value unless the
table says they are switches. Give an option once, except `--tool` and `--skill`, which you repeat for several values.

The group `knowledge` is reserved for a later feature.
It has no command yet: `bob knowledge list` prints that the group isn't available yet and exits with status 2.

## Options every command shares

| Option                  | Effect                                                                                   |
| ----------------------- | ---------------------------------------------------------------------------------------- |
| `--help`                | Print the usage of that level on standard output and exit 0. Every command and group takes it. |
| `--json`                | Print the service's answer as JSON instead of text. Every command except `serve` and `import` takes it. |
| `--runtime-dir <value>` | The directory of the daemon's socket. Every command except `serve` and `import` takes it. |

`serve` and `import` take their own directory flags, listed with them below. The installation commands in
[Install, upgrade and remove](#install-upgrade-and-remove) take neither `--json` nor `--runtime-dir`, except that
`bob service status` takes `--json`.

### The runtime directory

A command that calls the service reaches the daemon through the socket `bob.sock` in the runtime directory. `bob`
chooses that directory in this order:

1. The `--runtime-dir` option.
2. The environment variable `BOB_RUNTIME_DIR`. An empty value counts as not set.
3. The default runtime directory: `$XDG_RUNTIME_DIR/the-intern`, else the `run` folder inside the state directory. See
   [Where The Intern keeps its files](running_the_intern.md#where-the-intern-keeps-its-files).

Give an absolute path. When no daemon answers on the socket, the command prints
``The Intern isn't running here (<path>/bob.sock); start it with `bob serve` `` on standard error and exits with
status 3.

### Text, JSON and exit codes

By default a command prints readable text. The wording of the text can change between versions. With `--json` it prints
the service's answer unchanged on standard output. The names of the commands, the JSON output and the exit codes are
stable, so a script can rely on them.

Data goes to standard output. Errors, notices and hints go to standard error. Text output uses colour only when
standard output is a terminal.

Text output prints what jobs, worklogs, roles and conversations hold, and agents write some of it. `bob` removes
control sequences and control characters from that text before it prints, so text from an agent can't redraw your
screen, change the window title or set the clipboard. Where a field holds several lines, `bob jobs show`, `bob follow`
and `bob jobs follow` indent every line after the first by four spaces, so a line of data never reads as a line of
`bob`'s own. `--json` prints the data as stored; the characters U+0080 to U+009F, which some terminals read as control
sequences, are written as JSON escapes, so the value read back is the same.

A data command stops quietly, with exit 0, when the program that reads its output closes it early, as in
`bob follow | head -n 1`.

| Exit code | Meaning                                                                                              |
| --------- | ---------------------------------------------------------------------------------------------------- |
| 0         | The command succeeded.                                                                               |
| 1         | The service refused or failed. Standard error holds its error code and message, as `conflict: <message>`. `bob chat` without a terminal also exits 1, with the no-default-model notice, when the front desk has no model. |
| 2         | A usage error: an unknown command or option, a missing or extra argument, or a reserved group. Standard error holds the usage of the group concerned, except for a reserved group, which prints one line saying the group isn't available yet. |
| 3         | The daemon can't be reached.                                                                         |

`bob chat`, `bob follow` and `bob jobs follow` exit 3 when no daemon runs at the start. When the daemon is there but
starting or stopping, they print a notice on standard error and wait for it.

### JSON output

Most commands print the answer of one service operation as one JSON value. Three kinds of command print more:

- A `show` command that reads several operations prints one JSON object. Each key is the name of an operation and each
  value is that operation's answer unchanged. `bob jobs show` prints the keys `jobs.get`, `jobs.worklog.list` and
  `jobs.history.list`. `bob conversations show` prints `conversations.get`, `conversations.entries` and
  `conversations.invocations`.
- `bob usage` prints one JSON object with the keys `total` and `conversations`: the answer of `usage.get` for the
  instance and the same answer for each conversation, by its id.
- A following command prints one JSON value per line: `bob follow`, `bob jobs follow` and `bob chat`. Each line is a
  feed snapshot, a feed delta or an answer the command reads. Read the output line by line.

Each command below says what its JSON holds.

## Run and move the instance

### `bob serve`

Run the daemon in the foreground. It takes no `--json` and no arguments. Its log goes to standard error and nothing
goes to standard output. See [Running The Intern](running_the_intern.md) for what the daemon does and its exit statuses.

| Option                  | Meaning                                  |
| ----------------------- | ---------------------------------------- |
| `--config-dir <value>`  | The configuration directory.             |
| `--state-dir <value>`   | The state directory.                     |
| `--data-dir <value>`    | The data directory.                      |
| `--runtime-dir <value>` | The runtime directory.                   |
| `--verbose`             | Write debug lines to standard error. A switch. |
| `--help`                | Print this usage.                        |

### `bob status`

Print the daemon's status: its phase, versions, start time, instance directories and worker threads in use and
waiting. With `--json` it prints the answer of `daemon.status`.

While pi's settings name no default model, the text ends with one more line: the daemon's notice, which says where pi
agent's folder is and how to sign in to pi. The line is gone once a model is named, with no restart of the daemon. The
`--json` output is unchanged; it holds the notice as the `noDefaultModel` field of the answer.

Options: `--json`, `--runtime-dir <value>`, `--help`.

### `bob usage`

Print the usage per conversation and in total. With `--json` it prints an object with `total` and `conversations`:
`total` is the answer of `usage.get`, and `conversations` holds the same answer for each conversation, by its id.

Options: `--json`, `--runtime-dir <value>`, `--help`.

### `bob export <file>`

Write a copy of the database to a new file while the daemon runs. `bob` makes the file absolute against your current
directory and prints the path and size written. With `--json` it prints an object with `path` and `size`.

Options: `--json`, `--runtime-dir <value>`, `--help`.

### `bob import <file>`

Place an exported database file as the database of a stopped instance. It runs without a daemon and takes no `--json`.
If a daemon holds the instance, or the file can't be imported, it prints the reason on standard error and exits 1.

| Option                  | Meaning                                  |
| ----------------------- | ---------------------------------------- |
| `--config-dir <value>`  | The configuration directory.             |
| `--state-dir <value>`   | The state directory.                     |
| `--data-dir <value>`    | The data directory.                      |
| `--runtime-dir <value>` | The runtime directory.                   |
| `--help`                | Print this usage.                        |

## Watch and talk

### `bob follow`

Print the instance feed until you press Ctrl-C, which exits 0. It prints one line for each job created, changing
status, blocked or done, and each time an agent starts or stops a run. If the daemon restarts, it prints a notice on
standard error and goes on. If the feed lags, it goes on without a notice. If no daemon answers when it starts, it
exits 3 as every command does.

With `--json` it prints the feed snapshot, then each delta, one JSON value per line.

Options: `--json`, `--runtime-dir <value>`, `--help`.

### `bob chat`

Talk to the front desk. Its behaviour depends on where your input comes from.

- On a terminal, it shows the last lines of the front desk's history and a prompt. A line you type while the front desk
  is busy queues and is answered after the current one. The answer streams: a line still being written shows as one
  row, its last part, and when the line ends it is written whole, so a long URL or command copies as one line. Ctrl-C
  stops the current turn, drops the queued lines and names each on standard error, so you can send it again; the chat
  stays open. Ctrl-D waits for the answers to the lines the front desk has taken, prints them and exits 0. If the
  daemon restarts, the chat prints a notice, reconnects and prints what the front desk wrote while it was away. A line
  typed while the daemon is away is sent when it returns. If the daemon is away when you press Ctrl-D, or goes away
  while Ctrl-D waits, the chat exits 0 and says on standard error that the daemon went away, naming each line not sent
  and each line not answered. Ctrl-C while Ctrl-D waits stops the turn and names the dropped lines as before; the chat
  then exits 0. If Ctrl-C's abort could not reach the daemon before Ctrl-D, the chat says so on standard error.
  While pi's settings name no default model, the front desk can't answer, unless you set a `model` for the `desk` role
  in `config.toml`; then it keeps running and none of the rest of this paragraph applies. With no model, the chat prints
  the daemon's no-default-model notice on standard error and stays open. A line you type is accepted and waits, and the
  chat shows the `notice: <text>` entry the front desk's history holds. The front desk answers the waiting lines once a
  model is available, in the same chat, and you send nothing again. Ctrl-C names each line still unanswered as dropped.
- Without a terminal, such as `echo "what's blocked?" | bob chat`, or with its output redirected, such as
  `bob chat > answers.txt`, it shows no prompt, history or colour. It sends each line of standard input in turn, waits
  for the answer, prints it and exits 0 at the end of input. If the daemon isn't running when the command starts, it
  exits 3. If the daemon goes away later, it prints a notice on standard error, waits for the daemon and goes on. While
  pi's settings name no default model and the `desk` role has no `model` of its own in `config.toml`, it submits every
  line without waiting for answers, prints the daemon's no-default-model notice once on standard error, prints nothing
  on standard output and exits 1. The lines wait in the front desk and are answered once a model is available; send
  nothing again.

| Option    | Meaning                                                           |
| --------- | ----------------------------------------------------------------- |
| `--reset` | Empty the front desk's next context before chatting. A switch.    |
| `--json`  | Print the service's answer as JSON.                               |
| `--runtime-dir <value>` | The directory of the daemon's socket.               |
| `--help`  | Print this usage.                                                 |

With `--json`, on a terminal the command prints one JSON value per line: the `desk.get` answer, each page of the
front desk's history, the feed snapshot and each delta. The prompt goes to standard error. Without a terminal, it
prints each page of entries it reads after sending a line.

## Jobs

`<job>` is a job's short number, such as `C-14`, in any letter case, or its ID. See
[Giving, following and answering jobs](jobs.md). A job you create with `bob` has the origin letter `C`.

| Command                                                  | What it does                                                     |
| -------------------------------------------------------- | ---------------------------------------------------------------- |
| `bob jobs create <text>`                                 | Create a job from the text of a request.                         |
| `bob jobs list`                                          | List jobs, newest first.                                         |
| `bob jobs show <job>`                                    | Show one job.                                                    |
| `bob jobs update <job>`                                  | Change a job's title, description or definition of done.         |
| `bob jobs relate <job> <other>`                          | Relate two jobs.                                                 |
| `bob jobs unrelate <job> <other>`                        | Remove the relation between two jobs.                            |
| `bob jobs complete <job> <justification>`                | Complete an In-progress job, with a justification.               |
| `bob jobs cancel <job> <justification>`                  | Cancel a job, with a justification.                              |
| `bob jobs answer <job> <text>`                           | Send text to a job's lead, which resumes a Blocked job.          |
| `bob jobs follow <job>`                                  | Print a job's changes and its conversations' activity until the job is Done. |

Every job command takes `--json`, `--runtime-dir <value>` and `--help`.

### `bob jobs create <text>`

Create a job. It prints the new job's short number and status, such as `C-14 created (To do)`. With `--json` it prints
the job.

| Option                 | Meaning                                  |
| ---------------------- | ---------------------------------------- |
| `--title <value>`      | The job's title.                         |
| `--role <value>`       | The role of the job's lead.              |
| `--model <value>`      | The model of the job's lead.             |
| `--thinking <value>`   | The thinking level of the job's lead.    |
| `--workspace <value>`  | The workspace of the job's lead.         |
| `--stated-by <value>`  | Who stated the request.                  |

### `bob jobs list`

List jobs, one line each with the short number, status and title, and the Blocked reason for a Blocked job. When more
jobs match than the page holds, the last line gives the `--cursor` value that continues the listing. With `--json` it
prints an object with `jobs` and, when more follow, `cursor`.

| Option               | Meaning                                                              |
| -------------------- | -------------------------------------------------------------------- |
| `--status <value>`   | Only jobs with this status: `to_do`, `in_progress`, `blocked` or `done`. |
| `--letter <value>`   | Only jobs with this origin letter.                                   |
| `--related <value>`  | Only jobs Related to this job.                                       |
| `--schedule <value>` | Only the scheduled runs of this schedule entry.                      |
| `--mail <value>`     | Only the jobs that came through this mail account.                   |
| `--limit <value>`    | The most jobs to list.                                               |
| `--cursor <value>`   | Continue after the cursor an earlier listing printed.                |

### `bob jobs show <job>`

Show a job: its title, status, Blocked reason or resolution, description, definition of done, Related jobs, latest
worklog entries and history. A job that came by email also shows an `Email:` section: the account, the sender, the
subject, the request mark, the path of the saved message, each attachment with its size and path, and the job's mail
thread, one line per message with its direction (`received` or `sent`), sender, recipients, subject and date. With
`--json` it prints the keyed object with `jobs.get`, `jobs.worklog.list` and
`jobs.history.list`; for a job that came by email, the `jobs.get` value also holds the details under `email`. Each
worklog and history value is the first page of entries as the service gives it, with a `cursor` when more follow.

### `bob jobs update <job>`

Change a job. Give at least one option, or the command prints the options and exits 2. It prints the changed job; with
`--json` it prints the job.

| Option                        | Meaning                                         |
| ----------------------------- | ----------------------------------------------- |
| `--title <value>`             | The job's title.                                |
| `--description <value>`       | The job's description.                          |
| `--definition-of-done <value>` | What has to be true for the job to be complete. |

### `bob jobs relate <job> <other>` and `bob jobs unrelate <job> <other>`

Relate two jobs, or remove the relation. Each prints the two changed jobs, one line each. With `--json` it prints an
object with the jobs as `a` and `b`.

### `bob jobs complete <job> <justification>` and `bob jobs cancel <job> <justification>`

Complete an In-progress job, or cancel a job, with a justification. An empty justification is refused with exit 1. Each
prints the changed job; with `--json` it prints the job.

`bob jobs complete` takes one more option, `--mail-text <text>`: the text the sender of an email job receives as the
reply. When the job's email needs a mail text and you give none, the service refuses the completion with exit 1 and
changes nothing; give the option and run the command again.

### `bob jobs answer <job> <text>`

Send text to the job's lead, with way in `command line`. Text sent to the lead of a Blocked job resumes the job. It
prints `sent to <number>'s lead`. With `--json` it prints the answer of the submission: an object with `submissionId`,
or `{ "held": true }` when the lead holds the text until it continues.

The command refuses in three cases, each with exit 1 and nothing sent:

- The job is Done. Its lead conversation is closed, so the service answers `conflict`.
- The job has no lead conversation, for example because it was cancelled before its lead started. `bob` prints that the
  job has no lead conversation to send to.
- No job has that short number or ID. The service answers `not_found`.

### `bob jobs follow <job>`

Print the job's current status, then its status changes, edits and worklog entries, and the activity of each of its
conversations. A line of a conversation starts with the conversation's ID in brackets. It prints each notice entry in
a conversation as `notice: <text>`, such as the no-model notice while the conversation waits for a model. It exits 0
when the job is Done, after printing its resolution, or when you press Ctrl-C. A job that is already Done prints its
resolution and exits 0. If the daemon restarts, it prints a notice on standard error and goes on, and it prints the
entries the job's conversations wrote while the daemon was away. Worklog entries, edits and status changes made
meanwhile are not replayed, so they are not printed afterwards; a job that was completed meanwhile prints its
resolution and exits. If a feed lags, it goes on without a notice.

With `--json` it prints the job first. A job that is already Done ends there. Otherwise it goes on with the snapshot
and each delta of the instance feed that concern the job, and the snapshot and each delta of the feed of each of its
conversations, one JSON value per line.

## Conversations

`<id>` is the ID of a conversation, as `bob conversations list` prints it. Every conversation command takes `--json`,
`--runtime-dir <value>` and `--help`.

A conversation of a Done job is closed. `bob conversations list` shows it with the status `closed`. `send`, `stop`,
`reset`, `seat` and `compact` on a closed conversation print `conflict` and the service's message on standard error and
exit 1.

| Command                              | What it does                                                        |
| ------------------------------------ | ------------------------------------------------------------------- |
| `bob conversations list`             | List conversations.                                                 |
| `bob conversations show <id>`        | Show one conversation.                                              |
| `bob conversations send <id> <text>` | Send text to a conversation; while it runs the text steers it.      |
| `bob conversations stop <id>`        | Abort a conversation's current run.                                 |
| `bob conversations reset <id>`       | Reset a conversation to an empty context.                           |
| `bob conversations seat <id>`        | Seat a conversation in a role, with optional overrides.             |
| `bob conversations compact <id>`     | Compact a conversation's context.                                   |

### `bob conversations list`

List conversations, one line each with the ID, the job's ID (followed by `lead` for a lead conversation) or `front
desk`, the seat, the status and the last activity. The status is `closed`, `waiting for a worker thread`, `running`,
`parked` or `idle`. With `--json` it prints the array of conversations.

| Option            | Meaning                              |
| ----------------- | ------------------------------------ |
| `--job <value>`   | Only the conversations of this job.  |

### `bob conversations show <id>`

Show the conversation, its transcript with seat records and who sent each input, and the conversations it invoked,
each under its invoker, to any depth. With `--json` it prints the keyed object with `conversations.get`,
`conversations.entries` and `conversations.invocations`.

### `bob conversations send <id> <text>`

Send text to a conversation, with way in `command line`. While the conversation runs, the text steers it. It prints
`steered to <id>` or `submitted to <id>`, or that the text is held until the conversation continues. With `--json` it
prints the answer of the submission.

| Option         | Meaning                                                                  |
| -------------- | ------------------------------------------------------------------------ |
| `--follow-up`  | Deliver the text after the current run instead of steering. A switch.    |
| `--reject`     | Refuse the text with `busy` while the conversation runs. A switch.       |

Give at most one of the two; both together exit 2.

### `bob conversations stop <id>`, `reset <id>` and `compact <id>`

`stop` aborts the conversation's current run. `reset` empties its context. `compact` compacts its context. Each prints
one line, such as `stopped <id>`. With `--json` each prints the service's answer, which is the empty object `{}`.

| Option                    | Meaning                                  |
| ------------------------- | ---------------------------------------- |
| `--instructions <value>`  | What the compaction should keep. Only `compact` takes it. |

### `bob conversations seat <id>`

Seat the conversation in a role, with optional overrides. It prints the new seat. With `--json` it prints an object
with the new seat's `role`, `model` and `workspace`.

| Option                 | Meaning                                                      |
| ---------------------- | ------------------------------------------------------------ |
| `--role <value>`       | The role to seat the conversation in.                        |
| `--model <value>`      | A model, instead of the role's.                              |
| `--thinking <value>`   | A thinking level, instead of the role's.                     |
| `--workspace <value>`  | A registered workspace, instead of the role's.               |
| `--reset`              | Reset the conversation to the Clean mode with the new seat. A switch. |
| `--note <value>`       | The note of the reset; needs `--reset`, or the command exits 2. |

## Roles

`<name>` is a role's name. Every role command takes `--json`, `--runtime-dir <value>` and `--help`. See
[Roles, workspaces and agents sharing a job](roles_and_agents.md).

| Command                       | What it does                                         |
| ----------------------------- | ---------------------------------------------------- |
| `bob roles list`              | List roles.                                          |
| `bob roles show <name>`       | Show one role.                                       |
| `bob roles create <name>`     | Create a role.                                       |
| `bob roles change <name>`     | Change a role.                                       |
| `bob roles remove <name>`     | Remove a role.                                       |
| `bob roles restore <name>`    | Restore a shipped role to its shipped definition.    |

`bob roles list` prints one line per role with its name, whether it is shipped, changed or a team role, and its model.
With `--json` it prints an object with `roles`. `bob roles show` prints the role with its thinking level, workspace,
tools, skills and instructions; with `--json` it prints that role. When no role has the name, it prints so and exits 1.
`create`, `change`, `remove` and `restore` print one line, such as `reviewer created`. With `--json`, `create`,
`change` and `restore` print an object with the role under `role`, and `remove` prints the empty object `{}`.

`bob roles create` and `bob roles change` take these options. `change` sends only the options you give.

| Option                    | Meaning                                              |
| ------------------------- | ---------------------------------------------------- |
| `--instructions <value>`  | The text of the role's instruction file.             |
| `--tool <value>`          | A tool the role may use; repeat for several.         |
| `--skill <value>`         | The name of a skill the role starts with; repeat for several. |
| `--model <value>`         | The role's model.                                    |
| `--thinking <value>`      | The role's thinking level.                           |
| `--workspace <value>`     | The role's default workspace.                        |

A role's instructions are the text of its instruction file, `instructions/roles/<name>.md` in the data directory, and
its skills are names. `--instructions` writes that file. `bob roles change` reads the role's file first, so a file you
edited by hand since is refused as a `conflict` instead of overwritten; run the command again to write over what it
now reads. `bob roles show` prints `Instructions: missing` when the file is gone.

`bob roles change --instructions` is refused for a role whose file is gone, and the message names the file's full path
and the remedy. For a shipped role, run `bob instructions restore <name>`. For a team role, create the file again by
hand, or remove the role and create it again. The other options still apply. To list the files that build a prompt, or
to enable a skill for a role, use [`bob instructions`](#instructions) and [`bob skills`](#skills).

## Workspaces

`<path>` is the absolute path of a folder. Every workspace command takes `--json`, `--runtime-dir <value>` and
`--help`.

| Command                          | What it does                          |
| -------------------------------- | ------------------------------------- |
| `bob workspaces list`            | List workspaces.                      |
| `bob workspaces register <path>` | Register a folder as a workspace.     |
| `bob workspaces unregister <path>` | Unregister a workspace.             |

`list` prints one line per workspace with its path and either `registered` or `default of <role>`. With `--json` it
prints an object with `workspaces`. `register` and `unregister` print one line, such as `<path> registered`. With
`--json`, `register` prints an object with the `path`, and `unregister` prints the empty object `{}`.

## Models

### `bob models list`

List models and their thinking levels, one line per model. With `--json` it prints the array of models, each with
`model` and `thinkingLevels`.

Options: `--json`, `--runtime-dir <value>`, `--help`.

## Schedules

`<name>` is a schedule entry's name. Every schedules command takes `--json`, `--runtime-dir <value>` and `--help`.

| Command                        | What it does                                                   |
| ------------------------------ | -------------------------------------------------------------- |
| `bob schedules list`           | List the entries.                                              |
| `bob schedules show <name>`    | Show one entry and its recent runs.                            |
| `bob schedules create <name>`  | Create an entry.                                               |
| `bob schedules change <name>`  | Change an entry.                                               |
| `bob schedules remove <name>`  | Remove an entry.                                               |
| `bob schedules run <name>`     | Start a scheduled run of the entry now.                        |

`list` prints one line per entry with its name, cron expression, next due time and latest scheduled run. With `--json`
it prints an object with `schedules`. `show` prints the entry's values and next due time, then its recent runs: each
run with its short number, fire time, whether it was run on demand, status and resolution, and each skipped fire with
its reason. With `--json` it prints the keyed object with `schedules.get` and `schedules.runs`; the runs are the first
page, newest first, with a `cursor` when more follow. When no entry has the name, `show` exits 1 with the service's
reason.

`create`, `change` and `remove` print one line, such as `nightly created`. With `--json`, `create` and `change` print an
object with the entry under `schedule`, and `remove` prints the empty object `{}`. `run` prints one line, such as
`nightly started as S-4`; with `--json` it prints the new job. It starts the entry's scheduled run at once, takes no
key, and records the way in `command line` in the job's origin. The service refuses it, with exit 1, when the entry has
an open scheduled run (`busy`), or its model or workspace has gone (`invalid_input`).

`bob schedules create` and `bob schedules change` take these options. `create` needs `--cron` and `--request`. `change`
sends only the options you give. The service checks every value, and a refusal exits 1.

| Option                    | Meaning                                                  |
| ------------------------- | -------------------------------------------------------- |
| `--cron <value>`          | The cron expression that says when the entry fires.      |
| `--request <value>`       | The request of each scheduled run.                       |
| `--role <value>`          | The role of the run's lead.                              |
| `--model <value>`         | The model of the run's lead.                             |
| `--thinking-level <value>` | The thinking level of the run's lead.                   |
| `--workspace <value>`     | The workspace of the run.                                |

## Mail

`<name>` is a mail account's name. The manual page on email explains what the accounts are and how to set one up.
Every mail command takes `--json`, `--runtime-dir <value>` and `--help`.

| Command                                | What it does                                                                        |
| -------------------------------------- | ----------------------------------------------------------------------------------- |
| `bob mail list`                        | List mail accounts.                                                                 |
| `bob mail show <name>`                 | Show one mail account.                                                              |
| `bob mail create <name>`               | Create a mail account; a password or client secret is typed or read with `--secret-stdin`. |
| `bob mail change <name>`               | Change a mail account; `--new-secret` reads a new secret as `create` does.          |
| `bob mail signin <name>`               | Sign in a `google` or `microsoft` account and wait until it is ready.               |
| `bob mail test <name>`                 | Check the login to an account's servers.                                            |
| `bob mail remove <name>`               | Remove a mail account.                                                              |
| `bob mail notices [set\|clear]`        | Show the notice mail settings; with `set` or `clear`, change them.                  |

`list` prints one line per account with its name, address, kind, status and time of the last check, or `never`. With
`--json` it prints an object with `accounts`. `show` prints the account's settings, allowlist, triage role, status and
last error, one per line. With `--json` it prints an object with the account under `account`. No output holds a
secret. When no account has the name, `show` exits 1 with the service's reason.

`test` logs in to the account's IMAP server and, when the account has one, its SMTP server, and prints one line per
server: `IMAP: ok`, or `IMAP: failed` with the server's words. With `--json` it prints an object with `imap` and, when
the account has an SMTP server, `smtp`; each holds `ok` and, for a refusal, `message`. A server that refuses the login
does not make the command exit 1: read the lines or the `ok` values.

`remove` prints one line, such as `intern removed`. With `--json` it prints the empty object `{}`. The service refuses
it, with exit 1, while the notice mail comes from the account.

### How a secret is read

`bob mail create` and `bob mail change --new-secret` read a secret for an account whose `--auth` is `password`,
`google` or `microsoft_app`: the password, or the client secret of the app. No option or environment variable carries
a secret, so it stays out of your shell history and the process list.

- On a terminal, `bob` prints `Password: ` or `Client secret: ` on standard error and reads what you type without
  showing it. Press Enter to finish. Ctrl-C ends the command with exit 2.
- With `--secret-stdin`, `bob` reads all of standard input as the secret and drops one line end at its end:
  `printf '%s\n' "$PASSWORD" | bob mail create intern --secret-stdin ...`.

An account with `--auth password_command` keeps no secret: `--password-command` names the command that prints the
password, one word per option. If the secret can't be read, because standard input ended or the prompt was
interrupted, the command prints why and exits 2. `change --new-secret` exits 2 for an account whose authentication
keeps no secret.

### `bob mail create <name>` and `bob mail change <name>`

`create` makes an account and prints it as `show` does. `change` sends only the options you give and prints the changed
account. With `--json` each prints an object with the account under `account`. The service checks every value, and a
refusal exits 1. A value that must be a whole number but isn't exits 2.

| Option                       | Meaning                                                               |
| ---------------------------- | --------------------------------------------------------------------- |
| `--kind <value>`             | `owned` or `monitored`.                                               |
| `--address <value>`          | The account's email address.                                          |
| `--imap-host <value>`        | The IMAP server.                                                      |
| `--imap-port <value>`        | The IMAP port.                                                        |
| `--imap-security <value>`    | `tls`, `starttls` or `none`.                                          |
| `--smtp-host <value>`        | The SMTP server.                                                      |
| `--smtp-port <value>`        | The SMTP port.                                                        |
| `--smtp-security <value>`    | `tls`, `starttls` or `none`.                                          |
| `--login <value>`            | The login name, when it is not the address.                           |
| `--auth <value>`             | `password`, `password_command`, `google`, `microsoft` or `microsoft_app`. |
| `--password-command <value>` | One word of the command that prints the password; repeat for each word. |
| `--client-id <value>`        | The OAuth client ID.                                                  |
| `--tenant <value>`           | The Microsoft tenant.                                                 |
| `--check-interval <value>`   | Seconds between checks of the inbox.                                  |
| `--triage-role <value>`      | The role that triages the account's mail.                             |
| `--allow <value>`            | An address or `@domain` allowed; repeat for several.                  |
| `--secret-stdin`             | Read the secret from standard input, not the terminal. A switch.      |

`change` takes three more options.

| Option                 | Meaning                                                                       |
| ---------------------- | ----------------------------------------------------------------------------- |
| `--disallow <value>`   | An allowed entry to remove; repeat for several.                               |
| `--new-secret`         | Read a new password or client secret. A switch.                               |

`--allow` adds to the account's allowlist and `--disallow` removes from it; the other entries stay.
`--password-command`, `--allow` and `--disallow` are the options you repeat for several values, besides `--tool` and
`--skill`.

### `bob mail signin <name>`

Sign in an account whose `--auth` is `google` or `microsoft`, then wait until it is ready. It first prints what you do
next. For a `microsoft` account that is `Open <address> and enter the code <code>.` For a `google` account it is
`Open <address> in a browser. On another machine, forward port <port> to this one first.` It then waits, and prints
`<name> is ready` and exits 0 when the account turns `ready`. When the sign-in fails it prints `The sign-in of <name>
failed: <reason>` on standard error and exits 1. Press Ctrl-C to stop waiting; the sign-in goes on in the daemon. An
account with another `--auth` has no sign-in, and the service refuses it with exit 1. If no daemon runs, it exits 3.

With `--json` it prints one JSON value per line: first the answer of the start (`kind` `device_code` with `code` and
`address`, or `kind` `browser` with `address` and `port`), then the change of the account's status that ended the wait,
an object with `type` `mail_account_status`, `name`, `status` and, for a failure, `lastError`.

### `bob mail notices [set|clear]`

Show or change the notice mail settings: the address notices go to and the account they come from. With no action it
prints `To:` and `From:` lines, each `(none)` when unset. `set` needs both options below, or the command prints that
and exits 2; it prints the new settings. `clear` removes both and prints `notices cleared`. Any other action exits 2.
With `--json`, `show` and `set` print an object with the settings under `notice`, and `clear` prints the same object
with no `to` or `from`.

| Option              | Meaning                                         |
| ------------------- | ----------------------------------------------- |
| `--to <value>`      | With `set`: the address notices go to.          |
| `--from <value>`    | With `set`: the account notices come from.      |

## Skills

`<name>` is a skill's name and `<path>` is the absolute path of a folder. Every skills command takes `--json`,
`--runtime-dir <value>` and `--help`. See [Roles, workspaces and agents sharing a job](roles_and_agents.md).

| Command                           | What it does                                                   |
| --------------------------------- | -------------------------------------------------------------- |
| `bob skills list`                 | List the skills of a role or a conversation.                   |
| `bob skills enable <name>`        | Enable a skill for a role or a conversation.                   |
| `bob skills disable <name>`       | Disable a skill for a role or a conversation.                  |
| `bob skills paths`                | List the skill search paths.                                   |
| `bob skills add-path <path>`      | Add a skill search path.                                       |
| `bob skills remove-path <path>`   | Remove a skill search path.                                    |
| `bob skills restore <name>`       | Restore a shipped skill to its installed version.              |

`list`, `enable` and `disable` take these options. Give exactly one of them; with none, or both, the command prints its
usage on standard error and exits 2.

| Option                    | Meaning                                              |
| ------------------------- | ---------------------------------------------------- |
| `--role <value>`          | The role whose skills to use.                        |
| `--conversation <value>`  | The conversation whose agent's skills to use.        |

`list` prints one line per skill with its name, its source (`internal`, `path <folder>` or `workspace <folder>`), the
path of its `SKILL.md` and the marks `enabled`, `edited` and `deleted`. A skill that a copy higher in priority shadows
prints an indented `shadowed:` line under the copy in use. For a conversation, the first line is `seat:` with the
agent's role, model, thinking level and workspace. Then come one `missing:` line per enabled name that no skill
matches, and one `left out:` line per skill that failed its check, with the reason. It never prints a skill's text.
With `--json` it prints an object with `skills`, `missing` and `leftOut`, and for a conversation `seat`.

`enable` and `disable` print one line, such as `code-review enabled` or `code-review disabled`. With `--json` they print
an object with `enabledSkills`, the new set of names. The service refuses an unknown name, with exit 1.

`paths` lists the search paths, lowest priority first, one per line. A path that fails the check, because it is missing
or other accounts can reach it, prints `unusable:` and the reason after it. `add-path` and `remove-path` print the
paths as they stand after the change. With `--json` all three print an array of objects with `path`, `ok` and, when
`ok` is false, `reason`. The service refuses a path that isn't absolute or doesn't exist (`invalid_input`), a path
that isn't listed when you remove it (`not_found`), and a change when `config.toml` changed on disk meanwhile
(`conflict`); each exits 1. Adding a path that is already listed changes nothing and exits 0.

`restore` copies the installed version of a shipped skill back, over your edits or in place of a deleted copy, and
prints the skill as `list` does. With `--json` it prints that skill. A name that isn't a shipped skill exits 1.

```
bob skills enable code-review --conversation 5
bob skills list --conversation 5
```

## Instructions

`<name>` is `common` or the name of a shipped role. Every instructions command takes `--json`, `--runtime-dir <value>`
and `--help`. No instructions command prints the text of a file.

| Command                           | What it does                                                   |
| --------------------------------- | -------------------------------------------------------------- |
| `bob instructions list`           | List the instruction files of a role or a conversation.        |
| `bob instructions restore <name>` | Restore the common prompt or a shipped role's instructions to the installed version. |

`list` takes these options. Give exactly one of them; with none, or both, the command prints its usage on standard
error and exits 2.

| Option                    | Meaning                                              |
| ------------------------- | ---------------------------------------------------- |
| `--role <value>`          | The role whose instruction files to list.            |
| `--conversation <value>`  | The conversation whose agent's instruction files to list. |

`list` prints one line per file, in the order the prompt reads them, with its kind (`common`, `role` or `workspace`),
its path and the marks `shipped`, `edited` and `missing`. With `--json` it prints an object with `files`, each with
`kind`, `path`, `shipped`, `edited` and `missing`.

`restore` copies the installed version of the common prompt (`bob instructions restore common`) or of a shipped role's
instructions (`bob instructions restore reviewer`) back, and prints that file's line as `list` does. With `--json` it
prints that file. A name that is neither `common` nor a shipped role exits 1.

## Install, upgrade and remove

These commands set up and maintain the installation. They call no operation of the service, except that
`bob service status` reads the running version from the daemon. They act on the instance directories and the pi login
folder that the service registration holds, not on those of your shell. Notices, questions and errors go to standard
error, and each command takes `--help`. A usage error exits 2. See [Installing and upgrading](installing.md) for what
each command does step by step.

| Command                                 | What it does                                                              | Exit codes |
| --------------------------------------- | ------------------------------------------------------------------------- | ---------- |
| `bob service install`                   | Register the service, start it at boot and wait until it is ready.        | 0 when ready. 1 when it isn't registered or isn't ready; the message names the reason and the command that shows the service's log. |
| `bob service remove`                    | Stop the service and remove its registration. The program and the data stay. | 0. 1 on failure. |
| `bob service status [--json]`           | Show whether the service is registered, starts at boot and runs, the version it runs and the directories it uses. | 0 in every state. |
| `bob upgrade [<version>] [--yes]`       | Upgrade to the latest release, or to `<version>`.                         | 0 when it upgraded, when you chose a fresh database, or when you already run that version. 1 when it failed and switched back, refused or you declined. |
| `bob rollback [--yes]`                  | Return to the previous version and its pre-upgrade copy.                  | 0. 1 when it refused, you declined or it failed. |
| `bob uninstall [--yes] [--remove-data]` | Remove the service, the program and the `bob` link. The data stays by default. | 0. 1 on failure. |

`bob service install` and `bob service remove` take only `--help`.

`bob service status --json` prints one JSON object:

| Field                                            | Value                                                              |
| ------------------------------------------------ | ------------------------------------------------------------------ |
| `registered`                                     | `true` or `false`.                                                 |
| `startsAtBoot`                                   | `true` or `false`; `false` when the service isn't registered.      |
| `running`                                        | `true` when the registered service's daemon answers, else `false`. |
| `version`                                        | The version the running daemon reports, or `null` when it isn't running. |
| `configDir`, `stateDir`, `dataDir`, `runtimeDir` | The instance directories the registration holds, or `null` when the service isn't registered. |
| `piAgentDir`                                     | The pi login folder the registration holds, or `null` when the service isn't registered. |

`bob upgrade` and `bob rollback` take `--yes`, which skips the question before they stop the service. Without a terminal
and without `--yes`, `bob rollback` refuses. `bob upgrade` takes the version as an optional argument and never runs by
itself.

`bob uninstall` asks whether to keep the instance's data, and keeps it by default. It takes these options.

| Option          | Meaning                                                                        |
| --------------- | ------------------------------------------------------------------------------ |
| `--yes`         | Don't ask; keep the data unless you give `--remove-data`. A switch.           |
| `--remove-data` | Remove the instance's directories without asking. A switch.                    |

```
bob service status --json
bob upgrade 0.2.0 --yes
bob uninstall --remove-data
```
