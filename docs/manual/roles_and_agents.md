# Roles, workspaces and agents sharing a job

Every job is done by agents. Each agent is made from a role and works in a workspace. This page explains the roles
The Intern ships, how you configure roles and workspaces, and how agents share the work of a job.

## Roles

A role is what an agent is made from. A role brings:

- instructions, which tell the agent how to work
- tools, chosen from the tools The Intern ships
- skills, which the agent reads when it needs them
- a default model, a default thinking level and a default workspace

The Intern ships three roles:

| Role  | What it is for                                                                                          |
| ----- | ------------------------------------------------------------------------------------------------------- |
| `bob` | Leads jobs. It is the default lead: a job starts with `bob` unless its source names another role. `bob` defines the job (goal, needs, plan and definition of done), asks for what is missing, then does the work itself, hands it to a better-suited role or invokes other agents for parts of it, and finally verifies the result against the definition of done. |
| `gp`  | A general-purpose executor. It carries out a part of a job to completion and reports back. It comes with a shipped skill that describes how. |
| `desk` | Assists team members in the [front desk](front_desk.md). It answers questions about the work from jobs, conversations, status and usage, turns every request for real work into a job instead of doing it, reports the new job's short number, and passes answers and steering to a job's conversations when a team member asks. |

You can create your own roles, change any role (including `bob`, `gp` and `desk`) and remove the roles you created. You
can't remove a shipped role.

A change to a role affects only agents seated after the change. An agent that is already working keeps its
instructions, tools, skills, model, thinking level and workspace until its seat changes.

## The configuration file

Roles and workspaces live in `config.toml` in the config directory (see
[Running The Intern](running_the_intern.md#the-configuration-file)). The file has a `[roles.<name>]` table for each
role you create or change, and a `[workspaces]` table.

### The `[roles.<name>]` tables

Each table is named after the role. A role name starts with a lowercase letter, then uses lowercase letters, digits
and hyphens, in at most 40 characters in all.

| Key              | Meaning                                                                       | Default                                  |
| ---------------- | ----------------------------------------------------------------------------- | ---------------------------------------- |
| `instructions`   | A string with the role's instructions. It can't be empty.                     | None for your own roles: required. For a shipped role, the shipped text. |
| `tools`          | A list of tool names: `read`, `write`, `edit` and `bash`.                      | None for your own roles: required. For `bob` and `gp`, all four. For `desk`, an empty list. |
| `skills`         | A list of absolute paths to skill folders.                                     | An empty list. For `gp`, its shipped skill. |
| `model`          | The role's default model, written `provider/id`.                               | The default model of the service account's pi login. |
| `thinking_level` | The role's default thinking level. It must be one the model supports.          | The default thinking level of the pi login. |
| `workspace`      | The absolute path of the role's default workspace. It must be registered.      | The role's own workspace, described below. |

In a job, every role is also offered `handoff`, `invoke` and `steer` (see [Sharing a job](#sharing-a-job)) and the
job tools `read_job`, `update_job`, `add_worklog`, `create_job`, `relate_jobs`, `block_job` and `complete_job`. A tool
list can't leave them out, so you don't list them. Only a job's lead can use `block_job` and `complete_job`: an agent
it invoked gets an error result from either, and its run goes on. `complete_job` must be the only tool call of its
turn. An agent seated before the job tools existed keeps its tools until its seat changes.

For a shipped role, set only the keys you want to change. Any key you leave out keeps its shipped value. For your own
role, `instructions` and `tools` are required.

The service refuses to start, and names the role and the key, when a table has a key it doesn't know, a value of the
wrong type, a tool it doesn't ship, a model or thinking level it can't resolve, or a workspace that isn't registered.

An example that creates a role and changes `bob`'s model:

```toml
[roles.reviewer]
instructions = "You review changes and report what is wrong, never how to fix it."
tools = ["read", "bash"]
skills = ["/home/you/skills/code-review"]
thinking_level = "high"

[roles.bob]
model = "anthropic/claude-sonnet-4-5"
```

The `desk` role has an empty tool set: it changes no file and runs no command. In the front desk it is offered only
the tools for reading jobs, conversations, and the daemon's status and usage; for creating and editing jobs; and for
passing input to or stopping a job's conversations. See [The front desk and `bob chat`](front_desk.md).

### Undo a change to a shipped role

A change to `bob`, `gp` or `desk` is kept in your configuration. The installed copy is never edited. To restore the
shipped role, remove its `[roles.bob]`, `[roles.gp]` or `[roles.desk]` table from the file, or only the keys you want
to undo, and restart the service. You can also restore a shipped role while the service runs, with
`bob roles restore <name>`.

### The `[workspaces]` table

| Key          | Meaning                                                     | Default           |
| ------------ | ----------------------------------------------------------- | ----------------- |
| `registered` | A list of absolute paths of the folders you register as workspaces. A path can be listed only once. | An empty list. |

```toml
[workspaces]
registered = ["/home/you/projects/website"]
```

## Workspaces

A workspace is a local folder that an agent works in. It holds the files the agent works on, extra instructions and
skills, and scratch space. Tools start in the agent's workspace. A workspace doesn't confine the agent: agents act on
the machine with the service account, and can reach whatever that account reaches.

### Default workspaces

Each role has a default workspace that The Intern creates for you, under the data directory:

```
<data dir>/workspaces/<role>
```

For example, `bob` works in `<data dir>/workspaces/bob` unless you give it another workspace. The folders are created
for the account only. You can't unregister them. They don't appear in the `registered` list.

### Register a workspace

You can use a folder as a workspace only after you register it. The Intern checks that the folder:

- has an absolute path
- exists and is a directory
- belongs to the service account and isn't open to the group or others (`chmod 700` gives it that)

A folder that fails the check is refused, with an error naming the path and the reason. If it comes from
`config.toml`, the service doesn't start. The check happens once, at registration. Later, if the folder disappears,
the agent's tool calls that need it fail with an ordinary error that the agent sees, and the service keeps running.

You can unregister a registered workspace unless a role's default workspace is that folder; the refusal names the
role. Agents already working in an unregistered workspace keep working there until their seat changes. After that,
nobody can choose it for a new seat.

### Instructions and skills from the workspace

An agent reads the `AGENTS.md` or `CLAUDE.md` files of its workspace, and the skills in it. It also reads the
`AGENTS.md` files of every parent folder of the workspace. You are responsible for what those parent folders
contribute, so check them when you register a workspace.

## Changing settings while the service runs

You can change roles and workspaces while the service runs, and the change applies at once. The Intern checks it as it
checks the file at startup. An invalid change is refused with the reason, and nothing changes. A valid change is
written to `config.toml`.

The service reads hand edits of `config.toml` only at startup. After you edit the file by hand, restart the service
before you make a change another way. See [Running The Intern](running_the_intern.md#the-configuration-file).

Use `bob roles create`, `change`, `remove` and `restore` for roles, and `bob workspaces register` and `unregister` for
workspaces. To move a running conversation to a changed role, use `bob conversations seat <id>`. The
[Command reference](commands.md#roles) lists their options.

## Sharing a job

Every job has one lead agent at a time. It works in the job's lead conversation, carries the job from definition to
verification, and is the only agent that completes it. Other agents work on parts of the job and never complete it.

A lead's turn can end with the job still In progress and nothing left to wait for: no input queued for it and no
invoked agent of the job running or reporting. The Intern then acts for the job:

- If the job has no definition of done, it blocks the job with the reason "no definition of done".
- Otherwise it sends the lead one reminder, which asks it to continue, block or complete the job. If the lead stops
  again without completing or blocking, the Intern blocks the job with the reason "the lead stopped without completing
  or blocking".

The reminder shows in the lead's conversation as a steer from the daemon, and the block shows in the job's history with
the daemon as author. A job that is blocked and then resumed gets a new reminder at the lead's next stop.

Every role carries the job tools, whatever its tool list says. They read the job, edit its title, description and
definition of done, add to its worklog, create a follow-up job and relate jobs. A follow-up job is Related to the job
only when the agent chooses to relate it. Only the job's lead can block and complete the job. An agent the lead
invoked gets an error result from either, and its run goes on. A message sent to a lead that is parked for its Blocked
job continues it and resumes the job. [Giving, following and answering jobs](jobs.md) describes jobs in full.

Every role is also offered three capabilities for sharing the work.

### Handoff

An agent can hand its conversation to an agent of another role. The conversation stays the same and the new agent
continues straight away, with no confirmation from you. When the conversation is the job's lead conversation, the new
agent becomes the job's lead.

The agent that hands off chooses what the new agent starts from:

| Context mode | The new agent starts from                                                   |
| ------------ | --------------------------------------------------------------------------- |
| Full         | The whole context so far.                                                   |
| Compact      | A compaction of the context, guided by a handoff note the agent writes.     |
| Clean        | Only the handoff note. Earlier entries stay in the transcript for you to read. |

The agent can also choose a model, a thinking level and a registered workspace other than the new role's defaults.

### Invoking agents

An agent invokes one or more agents for parts of its job. Each invoked agent gets:

- a new conversation of the same job
- a role, and optionally a model, a thinking level and a registered workspace
- a job prompt describing its part
- a context mode: Full (a copy of the invoking conversation's context, then the job prompt), Compact (a compaction of
  that context guided by the job prompt, then the job prompt) or Clean (only the job prompt)

Invoked agents run in parallel. They can hand off and invoke agents of their own, and neither agent owns the other.

The invoking agent then carries on in one of two ways:

- **Steerable.** It keeps running and can steer the agents it invoked.
- **Parked.** Its run ends and frees its worker thread. The Intern keeps its state, and it continues when an invoked
  agent reports. A parked agent can't steer. A message sent to a conversation parked for reports waits until the
  conversation continues. A lead parked because its job is Blocked continues with the message instead, and the job
  becomes In progress again: any message to a Blocked job's lead resumes the job, and the Blocked reason stays in the
  job's history. When an agent invokes agents and parks, the invocation must be the only tool call of that turn.

### Reports

When an invoked agent decides its part is done, its summary goes to the invoking conversation as a new input. If the
invoking agent is running, the report arrives like a follow-up message. If it is parked, it continues with the report
as soon as a worker thread is free. A parked agent continues on each report as it arrives. The transcript shows which
invoked agent sent each report, also a report that waited while the invoking agent was parked. An invoked agent that
still waits for reports from agents it invoked reports back only after those arrive and its own run ends.

### Aborting

Aborting a conversation also aborts the agents it still waits for, and the agents they wait for, in turn. Nothing
aborted stays parked, waits for a report or keeps its held messages. An agent aborted on its own sends a report that
says so, with its last answer when it has one, and a parked agent that invoked it continues on that report. The agents
aborted along with their invoker send no report back.

When a job is completed or cancelled, every conversation of the job is closed and its work aborted, as
[Statuses and actions](jobs.md#statuses-and-actions) describes. A closed conversation can't be aborted: the abort is
refused as `conflict`. A coordination or job tool called from a conversation of a Done job gets an error result and
changes nothing, and the run goes on: `invoke` creates no conversation, `handoff` changes no seat and `steer` delivers
nothing.

### Steering

You and any agent can steer a running conversation with a message. The message arrives after the current tool calls, or
as a follow-up after the run ends. The transcript records who steered. To steer a conversation yourself, run
`bob conversations send <id> <text>` (see [`bob conversations send`](commands.md#bob-conversations-send-id-text)).

A closed conversation, one of a Done job, can't be steered. A `steer` aimed at it gets an error result and delivers
nothing, and the run of the agent that sent it goes on. A message you send to it is refused as `conflict`.

### Limits

- Invocations chain to a depth of at most 10. A job's lead conversation has depth 0, and an invoked conversation is one
  deeper than the conversation that invoked it. An invocation past the cap is refused: the invoking agent gets an
  error that names the cap, and its run continues. Handoffs don't change depth.
- The service runs at most 32 agent runs at once, one per worker thread, counted across every job. A parked or idle
  conversation holds no worker thread, and neither does a blocked job. Work beyond the 32 waits its turn in arrival
  order and isn't dropped.

You can't change either limit.
