# Roles, workspaces and agents sharing a job

Every job is done by agents. Each agent is made from a role and works in a workspace. This page explains the roles
The Intern ships, how you configure roles and workspaces, and how agents share the work of a job.

## Roles

A role is what an agent is made from. A role brings:

- instructions, which tell the agent how to work, kept in a file you can edit
- tools, chosen from the tools The Intern ships
- skills, which the agent reads when it needs them, by name
- a default model, a default thinking level and a default workspace

The Intern ships four roles:

| Role  | What it is for                                                                                          |
| ----- | ------------------------------------------------------------------------------------------------------- |
| `bob` | Leads jobs. It is the default lead: a job starts with `bob` unless its source names another role. `bob` defines the job (goal, needs, plan and definition of done), asks for what is missing, then does the work itself, hands it to a better-suited role or invokes other agents for parts of it, and finally verifies the result against the definition of done. |
| `gp`  | A general-purpose executor. It carries out a part of a job to completion and reports back. It comes with a shipped skill that describes how. |
| `desk` | Assists team members in the [front desk](front_desk.md). It answers questions about the work from jobs, conversations, status and usage, turns every request for real work into a job instead of doing it, reports the new job's short number, sets up and runs schedules, and passes answers and steering to a job's conversations when a team member asks. |
| `triage` | Leads the triage job of an email that reaches an owned mail account. See [The `triage` role](#the-triage-role). |

You can create your own roles, change any role (including `bob`, `gp`, `desk` and `triage`) and remove the roles you created. You
can't remove a shipped role. You also can't remove a role that a schedule entry names, or a role whose default
workspace, the one The Intern creates for it, a schedule entry names. The refusal names the entry. A role whose default
workspace is one you set isn't held by that. A role that an open conversation is seated with can't be removed either:
the refusal is `conflict` and names the conversations.

A change to a role's tools, default skills, model, thinking level or workspace affects only agents seated after the
change. An agent that is already working keeps its tools, enabled skills, model, thinking level and workspace until its
seat changes. A change to a role's instructions is the exception: it reaches the agents of the role from their next
model request. See [Skills and instructions](skills_and_instructions.md).

A role of your own whose instruction file is missing or empty can't be seated. A seat change, the start of a job's lead
and a job that names the role are refused, and a handoff or an invocation gives the agent an error result. Each refusal
names the file.

## The configuration file

Roles and workspaces live in `config.toml` in the config directory (see
[Running The Intern](running_the_intern.md#the-configuration-file)). The file has a `[roles.<name>]` table for each
role you create or change, a `[skills]` table and a `[workspaces]` table. The [Skills and
instructions](skills_and_instructions.md) page describes `[skills]`.

### The `[roles.<name>]` tables

Each table is named after the role. A role name starts with a lowercase letter, then uses lowercase letters, digits
and hyphens, in at most 40 characters in all.

| Key              | Meaning                                                                       | Default                                  |
| ---------------- | ----------------------------------------------------------------------------- | ---------------------------------------- |
| `tools`          | A list of tool names: `read`, `write`, `edit`, `bash` and `mail`.              | None for your own roles: required. For `bob` and `gp`, `read`, `write`, `edit` and `bash`. For `desk`, an empty list. For `triage`, `read` and `mail`. |
| `skills`         | A list of skill names. It is the set of skills an agent starts with.           | An empty list. For a shipped role, the defaults of the running version, listed below. |
| `model`          | The role's default model, written `provider/id`.                               | The default model of the service account's pi login. |
| `thinking_level` | The role's default thinking level. It must be one the model supports.          | The default thinking level of the pi login. |
| `workspace`      | The absolute path of the role's default workspace. It must be registered.      | The role's own workspace, described below. |

In a job, every role is also offered `handoff`, `invoke` and `steer` (see [Sharing a job](#sharing-a-job)) and the job
tools `read_job`, `read_schedule_runs`, `update_job`, `add_worklog`, `create_job`, `relate_jobs`, `block_job` and
`complete_job`. `read_job` reads the agent's own job, or another job when you name it. `read_schedule_runs` reads the
history of a schedule entry. A tool list can't leave them out, so you don't list them. Only a job's lead can use
`block_job` and `complete_job`: an agent it invoked gets an error result from either, and its run goes on.
`complete_job` must be the only tool call of its turn. An agent seated before the job tools existed keeps its tools
until its seat changes.

A table has no `instructions` key. A role's instructions are the text of its file, `instructions/roles/<role>.md` in
the internal folder under the data directory. You write them when you create the role, and edit the file afterwards.
[Skills and instructions](skills_and_instructions.md#edit-the-text) describes the ways to edit it. An older
`config.toml` that still holds `instructions` is converted at the first start of this version, as
[Configuration files from an earlier version](skills_and_instructions.md#configuration-files-from-an-earlier-version)
describes.

For a shipped role, set only the keys you want to change. Any key you leave out keeps its shipped value. For your own
role, `tools` is required, and you give its instructions when you create it.

The shipped roles start with these skills:

| Role   | Skills                                  |
| ------ | --------------------------------------- |
| `bob`  | `about-the-intern`, `bob-command-line`  |
| `gp`   | `carry-out-a-part`, `bob-command-line`  |
| `desk` | `about-the-intern`                      |
| `triage` | `about-the-intern`                    |

A shipped role with no `skills` key gets the defaults of the running version. Once you change its skills, the list is
yours and an upgrade doesn't change it.

The list is only where an agent starts. Each agent has its own enabled set, which you or the agent change while it
works, and which a change of seat resets to the new role's defaults. A name in the list that no skill matches doesn't
stop the service: the agent goes without it. [Enable skills](skills_and_instructions.md#enable-skills) describes both.

Every agent, the front desk included, is also offered the `skill` tool, whatever its role's tool list says. It reads the
text of a skill the agent has enabled. You don't list it. See [The `skill` tool](skills_and_instructions.md#the-skill-tool).

The service refuses to start, and names the role and the key, when a table has a key it doesn't know, a value of the
wrong type, a tool it doesn't ship, a model or thinking level it can't resolve, or a workspace that isn't registered.

An example that creates a role and changes `bob`'s model:

```toml
[roles.reviewer]
tools = ["read", "bash"]
skills = ["code-review"]
thinking_level = "high"

[roles.bob]
model = "anthropic/claude-sonnet-4-5"
```

This creates the role `reviewer` in `config.toml`. Its instructions, such as "You review changes and report what is
wrong, never how to fix it.", are in `<data dir>/instructions/roles/reviewer.md`. The skill `code-review` has to come
from a [skill search path](skills_and_instructions.md#where-skills-come-from) or the agent's workspace. Until it
does, `bob skills list` shows it as missing.

The `desk` role has an empty tool set: it changes no file and runs no command. In the front desk it is offered the `skill`
tool and the tools for reading jobs, conversations, and the daemon's status and usage; for creating and editing jobs; for schedule
entries; and for passing input to or stopping a job's conversations. See [The front desk and `bob chat`](front_desk.md).

### The `mail` tool set entry

`mail` is not one tool. It stands for the mail tools: list folders, search messages, read a message, save attachments,
move messages, set flags, save a draft and send. An agent of a role whose `tools` list names `mail` is offered them in
a job's conversation, and each names the mail account it acts on. The front desk is never offered them, whatever role
its seat has. A role that doesn't name `mail` gets none. Write `mail` in the list as you write `read`, as in
`tools = ["read", "mail"]`. See [Email](email.md) for the accounts the tools reach, and for what a monitored account
refuses.

The `mark_request` job tool isn't one of the mail tools. The lead of a job that came by email is offered it whatever
its role's tools say, and any other agent or job is refused. See [The request mark](jobs.md#the-request-mark).

### The `triage` role

The shipped `triage` role leads the triage job of each email that reaches an owned mail account, unless you name
another role as the account's triage role. Its tool set is `read` and `mail`, and its skill is `about-the-intern`. Its
instructions direct the agent to:

- write the job's definition of done as its first duty, then read the saved email and its attachments
- take one decision: discard the email, record what matters and complete, hand a request off, or block the job to ask
  for what is missing
- set the request mark only when the email asks The Intern for something
- rewrite a request so that its definition of done states the work, and hand it off to a suitable role
- write each mail text for the person who reads it, with none of The Intern's internals
- follow the team's own triage rules

You change the role like any shipped role: its tools, skills, model, thinking level, workspace and instructions, and
`bob roles restore triage` undoes the change. You can't remove it, and you can't remove a role that an owned mail
account names as its triage role: the refusal is `conflict` and names the account.

To add your own triage rules, add them as instructions and skills of the `triage` role. Edit
`instructions/roles/triage.md`, or enable a skill with `bob skills enable <name> --role triage`. [Triage](email.md#add-triage-rules)
shows both, and [Skills and instructions](skills_and_instructions.md) explains how they work.

### Undo a change to a shipped role

A change to `bob`, `gp`, `desk` or `triage` is kept in your configuration, and a change to its instructions in its file in the
internal folder. The installed copy is never edited. To restore the shipped role while the service runs, use
`bob roles restore <name>`. It removes the change from `config.toml`, so the role's skills are the defaults of the
running version again, and it puts the shipped text back in the role's instruction file. Removing the role's table, or
only the keys you want to undo, and restarting the service restores the settings but not the instructions. For those,
run `bob instructions restore <name>`.

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

You can unregister a registered workspace unless a role's default workspace is that folder or a schedule entry names it;
the refusal names the role or the entry. Agents already working in an unregistered workspace keep working there until
their seat changes. After that, nobody can choose it for a new seat.

When you give a role its own workspace, The Intern stops registering that role's default workspace under the data
directory. If a schedule entry names that path, the service refuses to start at the next start, and names the file and
the entry. Change the entry or the file, then start again. Changing a role isn't refused for this reason.

### Instructions and skills from the workspace

An agent reads the `AGENTS.md` or `CLAUDE.md` files of its workspace, and the skills in its `.pi/skills` folder. It
also reads the `AGENTS.md` files of every parent folder of the workspace. You are responsible for what those parent
folders contribute, so check them when you register a workspace.

The prompt takes these files after the common prompt and the role's instructions, and the skills of the workspace are
always enabled for the agent. A skill of the workspace wins over a skill of the same name from anywhere else. An edit
to one of these files reaches the agents working in that workspace from their next model request, and so does a skill
folder you add or remove. See [Where skills come from](skills_and_instructions.md#where-skills-come-from).

## Changing settings while the service runs

You can change roles and workspaces while the service runs, and the change applies at once. The Intern checks it as it
checks the file at startup. An invalid change is refused with the reason, and nothing changes. A valid change is
written to `config.toml`. A change to a role's instructions is written to the role's instruction file instead.

What applies when:

- An edit to a role's instructions or to the common prompt, by any means, reaches running agents from their next model
  request. No restart and no new seat is needed.
- A change to a role's tools, default skills, model, thinking level or workspace affects only agents seated afterwards.
- A change to one agent's enabled skills applies from that agent's next model request.

The service reads hand edits of `config.toml` only at startup. After you edit the file by hand, restart the service
before you make a change another way. See [Running The Intern](running_the_intern.md#the-configuration-file).

Use `bob roles create`, `change`, `remove` and `restore` for roles, and `bob workspaces register` and `unregister` for
workspaces. `bob skills` and `bob instructions` cover skills and instruction files. To move a running conversation to a changed role, use `bob conversations seat <id>`. The
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

A stop you make is the exception. When you stop the lead of an In progress job while it runs, has input queued or
waits for agents it invoked, the lead gets no reminder. Once the stop and the aborts that follow it have ended, the
Intern blocks the job with the reason "stopped by a team member", with the daemon as author in the history, whatever the
definition of done holds. A message to the lead resumes the job. Stopping an idle lead changes nothing, and stopping
the lead of a Blocked job keeps its reason. [A Blocked job](jobs.md#a-blocked-job) describes the answer.

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
