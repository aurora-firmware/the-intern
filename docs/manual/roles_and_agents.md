# Roles, workspaces and agents sharing a job

Every job is done by agents. Each agent is made from a role and works in a workspace. This page explains the roles
The Intern ships, how you configure roles and workspaces, and how agents share the work of a job.

## Roles

A role is what an agent is made from. A role brings:

- instructions, which tell the agent how to work
- tools, chosen from the tools The Intern ships
- skills, which the agent reads when it needs them
- a default model, a default thinking level and a default workspace

The Intern ships two roles:

| Role  | What it is for                                                                                          |
| ----- | ------------------------------------------------------------------------------------------------------- |
| `bob` | Leads jobs. It is the default lead: a job starts with `bob` unless its source names another role. `bob` defines the job (goal, needs, plan and definition of done), asks for what is missing, then does the work itself, hands it to a better-suited role or invokes other agents for parts of it, and finally verifies the result against the definition of done. |
| `gp`  | A general-purpose executor. It carries out a part of a job to completion and reports back. It comes with a shipped skill that describes how. |

You can create your own roles, change any role (including `bob` and `gp`) and remove the roles you created. You can't
remove a shipped role.

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
| `tools`          | A list of tool names: `read`, `write`, `edit` and `bash`.                      | None for your own roles: required. For a shipped role, all four. |
| `skills`         | A list of absolute paths to skill folders.                                     | An empty list. For `gp`, its shipped skill. |
| `model`          | The role's default model, written `provider/id`.                               | The default model of the service account's pi login. |
| `thinking_level` | The role's default thinking level. It must be one the model supports.          | The default thinking level of the pi login. |
| `workspace`      | The absolute path of the role's default workspace. It must be registered.      | The role's own workspace, described below. |

Every role is also offered `handoff`, `invoke` and `steer` (see [Sharing a job](#sharing-a-job)). A tool list can't
leave them out, so you don't list them.

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

### Undo a change to a shipped role

A change to `bob` or `gp` is kept in your configuration. The installed copy is never edited. To restore the shipped
role, remove its `[roles.bob]` or `[roles.gp]` table from the file, or only the keys you want to undo, and restart
the service. You can also restore a shipped role while the service runs; the command for it comes with the
command-line documentation.

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

The commands for these changes come with the command-line documentation.

## Sharing a job

Every job has one lead agent at a time. It works in the job's lead conversation, carries the job from definition to
verification, and is the only agent that closes it. Other agents work on parts of the job and never close it.

Every role is offered three capabilities for sharing the work.

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
  agent reports. A parked agent can't steer. A message sent to a parked conversation waits until the conversation
  continues. When an agent invokes agents and parks, the invocation must be the only tool call of that turn.

### Reports

When an invoked agent decides its part is done, its summary goes to the invoking conversation as a new input. If the
invoking agent is running, the report arrives like a follow-up message. If it is parked, it continues with the report
as soon as a worker thread is free. A parked agent continues on each report as it arrives. An invoked agent that still
waits for reports from agents it invoked reports back only after those arrive and its own run ends.

### Steering

You and any agent can steer a running conversation with a message. The message arrives after the current tool calls, or
as a follow-up after the run ends. The transcript records who steered. The commands for you to steer a conversation
come with the command-line documentation.

### Limits

- Invocations chain to a depth of at most 10. A job's lead conversation has depth 0, and an invoked conversation is one
  deeper than the conversation that invoked it. An invocation past the cap is refused: the invoking agent gets an
  error that names the cap, and its run continues. Handoffs don't change depth.
- The service runs at most 32 agent runs at once, one per worker thread, counted across every job. A parked or idle
  conversation holds no worker thread, and neither does a blocked job. Work beyond the 32 waits its turn in arrival
  order and isn't dropped.

You can't change either limit.
