# Command reference

`bob` is the command line of The Intern. This page lists every command with its arguments, its options, the JSON it
prints with `--json` and the exit codes. `bob --help`, `bob <group> --help` and `bob <group> <command> --help` print the
same lists at each level.

Until installation puts `bob` on your `PATH`, run it from a checkout of the project as `node src/cli/bob.ts`. Every
example here writes `bob` for short; write `node src/cli/bob.ts` in its place.

```
bob jobs list --status blocked
node src/cli/bob.ts jobs list --status blocked
```

The service decides what is valid. `bob` passes your arguments to it, prints what it answers, and keeps no
configuration file, cache or history of its own.

## Command shape

A command is a group and a verb, such as `bob jobs list`, or a top-level command, such as `bob chat`. The top-level
commands are `serve`, `status`, `usage`, `export`, `import`, `follow` and `chat`. The groups are `jobs`,
`conversations`, `roles`, `workspaces` and `models`.

In the usage lines below, `<name>` is a required argument. Options come after the arguments and take a value unless the
table says they are switches. Give an option once, except `--tool` and `--skill`, which you repeat for several values.

The groups `schedules`, `triggers`, `skills`, `instructions`, `knowledge` and `mail` are reserved for later features.
They have no command yet: `bob schedules list` prints that the group isn't available yet and exits with status 2.

## Options every command shares

| Option                  | Effect                                                                                   |
| ----------------------- | ---------------------------------------------------------------------------------------- |
| `--help`                | Print the usage of that level on standard output and exit 0. Every command and group takes it. |
| `--json`                | Print the service's answer as JSON instead of text. Every command except `serve` and `import` takes it. |
| `--runtime-dir <value>` | The directory of the daemon's socket. Every command except `serve` and `import` takes it. |

`serve` and `import` take their own directory flags, listed with them below.

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

| Exit code | Meaning                                                                                              |
| --------- | ---------------------------------------------------------------------------------------------------- |
| 0         | The command succeeded.                                                                               |
| 1         | The service refused or failed. Standard error holds its error code and message, as `conflict: <message>`. |
| 2         | A usage error: an unknown command or option, a missing or extra argument, or a reserved group. Standard error holds the usage of the group concerned. |
| 3         | The daemon can't be reached.                                                                         |

### JSON output

Most commands print the answer of one service operation as one JSON value. Two kinds of command print more:

- A `show` command that reads several operations prints one JSON object. Each key is the name of an operation and each
  value is that operation's answer unchanged. `bob jobs show` prints the keys `jobs.get`, `jobs.worklog.list` and
  `jobs.history.list`. `bob conversations show` prints `conversations.get`, `conversations.entries` and
  `conversations.invocations`.
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

Options: `--json`, `--runtime-dir <value>`, `--help`.

### `bob usage`

Print the usage per conversation and in total. With `--json` it prints the total usage, the answer of `usage.get`.

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
status, blocked or done, and each time an agent starts or stops a run. If the daemon restarts or the feed lags, it
prints a notice on standard error and goes on.

With `--json` it prints the feed snapshot, then each delta, one JSON value per line.

Options: `--json`, `--runtime-dir <value>`, `--help`.

### `bob chat`

Talk to the front desk. Its behaviour depends on where your input comes from.

- On a terminal, it shows the last lines of the front desk's history and a prompt. A line you type while the front desk
  is busy queues and is answered after the current one. Ctrl-C stops the current turn, drops the queued lines and names
  each on standard error, so you can send it again; the chat stays open. Ctrl-D leaves and exits 0. If the daemon
  restarts, the chat prints a notice, reconnects and prints what the front desk wrote while it was away.
- Without a terminal, such as `echo "what's blocked?" | bob chat`, it shows no prompt, history or colour. It sends each
  line of standard input in turn, waits for the answer, prints it and exits 0 at the end of input.

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
| `--limit <value>`    | The most jobs to list.                                               |
| `--cursor <value>`   | Continue after the cursor an earlier listing printed.                |

### `bob jobs show <job>`

Show a job: its title, status, Blocked reason or resolution, description, definition of done, Related jobs, latest
worklog entries and history. With `--json` it prints the keyed object with `jobs.get`, `jobs.worklog.list` and
`jobs.history.list`. Each worklog and history value is the first page of entries as the service gives it, with a
`cursor` when more follow.

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
conversations. A line of a conversation starts with the conversation's ID in brackets. It exits 0 when the job is Done,
after printing its resolution, or when you press Ctrl-C. A job that is already Done prints its resolution and exits 0.
If the daemon restarts or a feed lags, it prints a notice on standard error and goes on.

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

List conversations, one line each with the ID, the job's ID (followed by `lead` for a lead conversation) or `front desk`,
the seat, the status and the last activity. The status is `closed`, `waiting for a worker thread`, `running`, `parked` or
`idle`. With `--json` it prints the array of conversations.

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
| `--instructions <value>`  | The role's instructions.                             |
| `--tool <value>`          | A tool the role may use; repeat for several.         |
| `--skill <value>`         | The absolute path of a skill; repeat for several.    |
| `--model <value>`         | The role's model.                                    |
| `--thinking <value>`      | The role's thinking level.                           |
| `--workspace <value>`     | The role's default workspace.                        |

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
