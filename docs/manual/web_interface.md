# The web interface

The web interface is The Intern's page for your browser. From any computer that reaches the service you see every job,
answer a Blocked job, follow an agent while it works, stop or redirect it, talk to the front desk, shape roles and
workspaces, and download a backup. It adds nothing the service doesn't already do: every action calls the same
operation the command line does.

::: warning Anyone who can reach the page can act and download everything
The web interface has no login, and nobody enters a name. Anyone who can reach the page is a team member and can give,
stop, redirect, complete and cancel jobs, change roles and workspaces, and download every conversation and the whole job
record from the Status page. The download can hold whatever an agent's tool output wrote into a conversation, secrets
included, and it leaves the service account's protection once the browser saves it. The connection isn't encrypted
either. Limit who can reach the address and port with your network setup, for example a firewall. See
[Reach The Intern over the network](running_the_intern.md#reach-the-intern-over-the-network) and
[Who can use The Intern](running_the_intern.md#who-can-use-the-intern).
:::

## Open the pages

The pages are served by the network listener, which is off until you add a `[network]` section to `config.toml`. Set
it up as [Running The Intern](running_the_intern.md#reach-the-intern-over-the-network) describes, then open
`http://<address>:<port>/` in a desktop browser. It redirects to `/ui/`, the Board.

Use a current Chrome, Firefox or Edge on a desktop computer. Safari isn't a target, though nothing blocks it. The pages
are made for desktop screens, so phones and tablets aren't supported.

The dark sidebar on every page links to the Board, Front desk, Roles, Workspaces and Status. Each page has an address
of its own, and the browser's back, forward and reload buttons work across them:

| Address                                | Page          |
| -------------------------------------- | ------------- |
| `/ui/`                                 | Board         |
| `/ui/#/jobs/<short number>`            | Job page      |
| `/ui/#/desk`                           | Front desk    |
| `/ui/#/roles`                          | Roles         |
| `/ui/#/workspaces`                     | Workspaces    |
| `/ui/#/status`                         | Status        |

## Share a job's address

Copy the address of a Job page, such as `http://192.168.1.20:8080/ui/#/jobs/W-3`, and send it to a colleague. It opens
the same job in their browser, with nothing stored there. Both of you can act on the job at once: the service decides
between simultaneous actions, and both pages show the result without a reload. If the job doesn't exist, the page says
so and links back to the Board.

## Board

The Board shows every job in four columns, in this order: To do, In progress, Blocked and Done. Each job shows its
short number and title. Select a job to open its Job page.

- A Blocked job stands out from the others with a badge, and shows its Blocked reason or the start of it, so you can
  see what waits for you.
- A job moves between columns on its own when its status changes. You don't reload.
- The Done column lists the newest jobs first. Select **Load more** to add older ones.
- With no jobs, the four columns are empty and the Board links to the Front desk.

## Job page

The Job page shows one job: its short number, title, description, definition of done, status, the Blocked reason while
it is Blocked, where it came from (the way in and the network address), its related jobs with links, its worklog and
history, and, once it is Done, its resolution and justification. It stays current without a reload.

### Answer a Blocked job

While a job is Blocked, the page shows an **Answer** box. Type your answer and select
**Send**. The lead agent receives the text, the job moves to In progress and the Blocked reason clears. If another
team member answered or cancelled the job first, the service refuses your answer, the page shows its message and your
text stays in the box. See [Giving, following and answering jobs](jobs.md#a-blocked-job).

### Change a job

The page lets you edit the title, description and definition of done, complete or cancel the job with a
justification, and relate it to another job or remove a relation. The service refuses what a job's rules don't allow,
such as a cancel with no justification or completing a job that has no definition of done. The page shows the message
and changes nothing.

### Follow an agent

Below the record the page shows the live activity of the job's lead conversation and of every conversation its agents
invoke, as it happens: messages, tool calls and tool results, each labelled with the agent it belongs to. The entries
already stored come first. Long output is collapsed; select **Show more** to expand it.

### Stop and Redirect

While an agent of the job is running, or waiting for the reports of the agents it invoked, its conversation offers two
actions:

- **Stop** asks for one confirmation, then ends the agent's work and that of the agents it invoked. Stopping the lead
  agent does not remind it to go on. The job becomes Blocked with the reason "stopped by a team member", and an answer
  resumes it. If the agent has already finished, the page says so.
- **Redirect** sends your words to the running agent, which takes them into account after its current tool round. The
  activity shows them as coming from a team member by the web interface. If the agent is waiting for reports, the page
  says "held until it continues": the service keeps your words and delivers them when the agent goes on.

### Conversation controls

Under Stop and Redirect, each conversation has a collapsed **Settings** area with three controls:

- **Compact** shortens what the model sees of the conversation.
- **Reset** clears what the model sees. It asks for one confirmation. The conversation and its entries stay.
- **Change seat** seats another role, model or workspace in the conversation.

## Front desk

The Front desk page shows the recent conversation with the [front desk](front_desk.md) and lets you send it messages.
Its answers appear as it writes them. A message you send while it is busy waits its turn.

**Stop** ends the front desk's current answer, with no confirmation, because it ends only a chat turn. Messages still
queued are dropped, and the page lists the ones you sent from this page. Under the chat, **Create a job** gives a job
directly: type its text and, if you want, a title. The job appears on the Board with a number starting with `W`.

## Roles

The Roles page lists every role with its instructions, tools, skills, default model, thinking level and workspace.
You can create a role, change any role's settings, restore a shipped role you changed, and remove a role you created.
A change affects only agents seated afterwards; agents already seated keep their settings. The rules for roles are in
[Roles, workspaces and agents sharing a job](roles_and_agents.md).

## Workspaces

The Workspaces page lists the registered workspaces. To register one, give the absolute path of an existing directory
on the machine where the service runs, and select **Register**. Select **Unregister** to remove one from the list. The
service refuses a path that doesn't exist, and the page shows its message.

## Status

The Status page shows the daemon's state (its phase, versions, directories and worker threads), the usage in total and
for each conversation, and the available models and thinking levels. It stays current without a reload.

### Download a copy of the database

Select **Download a copy** to download the export. A dialog states what the file holds: every conversation and the whole
job record. It doesn't hold the configuration file. It also says that anyone who can reach the page can take it. Select
**Download** to confirm. Your browser saves a file named `the-intern-<instance>-<date>.sqlite`, and work goes on while
it is made. If the copy fails, the page shows an error. Only a finished download is a good backup; if your browser
reports it as failed or incomplete, download again.

The page cannot import a file. To use the download on another computer or to restore it:

1. Stop the instance's daemon.
2. Make sure the state directory holds no database file.
3. Run [`bob import <file>`](commands.md#bob-import-file) with the downloaded file.
4. Start the service.

[Restore a copy as the database](running_the_intern.md#restore-a-copy-as-the-database) lists the checks the step makes.
Back up `config.toml` on its own.

## The connection banner

When a page can't reach the service, for example while it restarts, it shows a banner: "The service can't be reached.
Trying to connect again; what you type is kept." The page disables its buttons and keeps any text you were typing. It
reconnects on its own. When it does, it loads fresh data, removes the banner and enables the buttons, and you can send
your kept text. You don't reload.

## What the web interface does not have

- **No notifications.** It sends no pop-ups or sounds when a job blocks. Check the Board.
- **No names on actions.** Nobody enters a name. The record shows the way in, `web interface`, and the network address
  and port of the browser's connection.
- **No file browsing or editing.** You can't open a workspace's files. An agent's file changes appear only in its tool
  calls and results.
- **No login and no encryption.** See the warning above.
- **No pages for skills, instruction files, schedules, triggers or knowledge sources.** Each comes with its feature.
- **No import.** It stays on the command line.
- **No export to a path on the service's machine.** The browser downloads the file; use
  [`bob export <file>`](commands.md#bob-export-file) for a file on the machine itself.
- **No settings of its own.** The `[network]` section of `config.toml` sets its address and port.
