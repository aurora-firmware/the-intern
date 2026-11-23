# The web interface

The web interface is The Intern's page for your browser. From any computer that reaches the service you see every job,
answer a Blocked job, follow an agent while it works, stop or redirect it, talk to the front desk, shape roles and
workspaces, manage mail accounts, and download a backup. It adds nothing the service doesn't already do: every action
calls the same operation the command line does.

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

Use a current Chrome or Firefox on a desktop computer. Edge may also work, but isn't required.
Safari isn't a target, though nothing blocks it.
The pages are made for desktop screens, so phones and tablets aren't supported.

The dark sidebar on every page links to the Board, Front desk, Roles, Workspaces, Schedules, Mail and Status. Each page
has an address of its own, and the browser's back, forward and reload buttons work across them:

| Address                                | Page          |
| -------------------------------------- | ------------- |
| `/ui/`                                 | Board         |
| `/ui/#/jobs/<short number>`            | Job page      |
| `/ui/#/desk`                           | Front desk    |
| `/ui/#/roles`                          | Roles         |
| `/ui/#/workspaces`                     | Workspaces    |
| `/ui/#/schedules`                      | Schedules     |
| `/ui/#/mail`                           | Mail          |
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
it is Blocked, where it came from, its related jobs with links, its worklog and history, and, once it is Done, its
resolution and justification. A job you created on these pages shows the way in and the network address, and one
created from the command line shows the way in. A job the front desk created for you shows the way in and
"through the front desk". A scheduled run shows the schedule entry and its fire time, as in "Schedule nightly-backups,
fire time 2026-11-07T02:00:00.000+01:00". A run started with run now adds "on demand by" and the way in, with the
network address for a run from these pages, or "through the front desk". A follow-up job shows the short number of the
job it came from. The page stays current without
a reload.

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

The **Mail text (Complete only)** box beside the justification is optional. When you select **Complete** with text in
it, the service mails that text as the job's result reply, as [What The Intern sends](email.md#what-the-intern-sends)
describes. It is sent only for a job that came by email and has the request mark, and only when the box has text.
Without text, such a job sends no reply, and the history records that. **Cancel** never sends it. The justification
stays for the team and is never mailed.

### Email of a job

A job that came by email shows an **Email** section on its Job page. Any other job has none. The section shows:

- **Mail account**, the account the email reached.
- **Sender** and **Subject** of the email.
- **Saved message**, the email's text as The Intern saved it.
- **Request mark**, `Set` or `Not set`. The lead sets it when the email asks The Intern for something. See
  [Triage](email.md#triage).
- **Attachments**, each by name and size in bytes.
- **Job thread**, the emails received and sent for the job, each with its direction, sender, recipients, subject and
  date.

The page offers no download of an attachment, and it sends none to the browser. Only the job's agents read attachments,
as files. The section stays current without a reload.

### Follow an agent

Below the record the page shows the live activity of the job's lead conversation and of every conversation its agents
invoke, as it happens: messages, tool calls and tool results, each labelled with the agent it belongs to. The entries
already stored come first. Long output is collapsed; select **Show more** to expand it.

### Stop and Redirect

While an agent of the job is running, or waiting for the reports of the agents it invoked, its conversation offers two
actions:

- **Stop** asks for one confirmation, then ends the agent's work and that of the agents it invoked. Stopping the lead
  agent does not remind it to go on. The job becomes Blocked with the reason "stopped by a team member", and an answer
  resumes it. If the agent has already finished, the page says so. The lead of a To do job, which waits for a worker
  thread, has no Stop; Stop appears once the job is In progress. Cancel stays offered.
- **Redirect** sends your words to the running agent, which takes them into account after its current tool round. The
  activity shows them as coming from a team member by the web interface. If the agent is waiting for reports, the page
  says "held until it continues": the service keeps your words and delivers them when the agent goes on.

### Skills of a conversation

Each conversation has a collapsed **Skills** control. Open it to see the skills of that agent and the instruction files
that build its prompt. [The Skills panel](#the-skills-panel) describes what the panel shows and does. It is offered for
every conversation of the job, including those of a To do job. A check box you change for a running agent takes effect
from its next model request.

The activity shows each change of a skill, in order with the other entries, as a **Skill changed** entry such as
"code-review enabled by team member by web interface". It names who made the change: a team member and the way in,
an agent and its role, or a job source, as in "job source schedule".
A change made with `bob skills enable` shows the same way, at once.

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
The rules for roles are in [Roles, workspaces and agents sharing a job](roles_and_agents.md).

A role's instructions are the text of its instruction file, `instructions/roles/<name>.md` in the data directory. The
page reads the file and writes it when you save. What a change reaches depends on what you changed, and the page says
so above the list:

- A change to a role's instructions reaches running agents of that role from their next model request.
- A change to a role's tools, default skills, default model, thinking level or workspace affects only agents seated
  afterwards. Agents already seated keep their settings.

If the file changed on disk since the page read it, for example by a hand edit, the service refuses the save as a
conflict and shows its message, and nothing is overwritten. If the file is gone, the role shows a notice that names the
file and the remedy. Its Instructions box is disabled, so you can't save instructions for that role, but **Save** still
saves the role's other fields. Saving never writes the missing file back. For a shipped role, select **Restore** under
**Shipped role instructions** in the Skills and instructions section, or run `bob instructions restore <name>`. For a
team role, create the file again by hand, or remove the role and create it again. A role whose file is missing or empty
can't be seated.

Each role has a collapsed **Skills** control that opens its [Skills panel](#the-skills-panel). The check boxes there
set the skills the role starts with, so they affect only agents seated afterwards.

### Skills and instructions section

Below the roles, the **Skills and instructions** section holds what belongs to no single role:

- **Common prompt.** **Edit** opens the common prompt, the first part of every agent's prompt, in the
  [file editor](#edit-a-file). An edit reaches every running agent from its next model request. **Restore** copies
  the installed version back.
- **Skill search paths.** The folders, besides the internal folder, that skills come from. Type an absolute path in
  **Folder** and select **Add**, or select **Remove** beside a path. The service refuses a path that isn't an existing
  folder only you can use, and the page shows its message. A path the service can't use shows an `unusable` badge with
  the reason.
- **Shipped role instructions.** **Restore** for each shipped role copies back the installed version of its instruction
  file.
- **Shipped skills.** **Restore** for each shipped skill copies back the installed version; the `edited` badge marks one
  you changed.

Restore overwrites your edits to that file. The page offers no way to create or delete a skill folder; put a skill
folder where a search path or workspace holds it, as [Roles, workspaces and agents sharing a job](roles_and_agents.md)
describes.

## The Skills panel

The Skills panel is the same on the Job, Roles and Schedules pages. It shows what `bob skills list` and
`bob instructions list` print for one role or one agent, and lets you change the skills and edit the files. Select
**Skills** to open it. It stays current without a reload.

- **Skills.** Each skill has a check box, its description, its source (`internal`, `path <folder>` or
  `workspace <folder>`) and the badges `edited` or `deleted` for a shipped skill. Check the box to enable the skill and
  clear it to disable it. A skill of the agent's workspace is always on and its box can't be changed. A skill that a
  copy higher in priority shadows is listed under that copy as "Shadows ...".
- **Notices.** "Not found" lists enabled names that no skill matches. "Left out" lists a skill that failed its check,
  with the reason.
- **Instruction files.** The files that build the prompt, in the order the prompt reads them: the common prompt, the
  role's file and the context files of the workspace. Each has the badges `shipped`, `edited` or `missing`, and an
  **Edit** button.
- **Edit.** Beside each skill and each instruction file, opens its file in the [file editor](#edit-a-file).

The service refuses a change it can't make, for example an unknown skill name. The page shows its message beside the
skill and leaves the box as the service has it.

Where the panel is opened decides whose skills it shows:

| From                                   | Shows                                              | A change affects                  |
| -------------------------------------- | -------------------------------------------------- | --------------------------------- |
| A conversation on the Job page         | The agent in that conversation                     | That agent, from its next model request |
| A role on the Roles page               | The role                                           | Agents seated with it afterwards  |
| A schedule entry on the Schedules page | The entry's role, or `bob` when the entry has none | Agents seated with it afterwards  |

### Edit a file

**Edit** opens the file's text in a box under the panel, with its path above it. For a skill it opens the skill's
`SKILL.md`. Change the text and select **Save**. The service writes the file, and the change reaches running agents as
the table above says. **Close** hides the box.

You can edit only these files:

- a file inside a skill folder, in the internal folder, a search path or a registered workspace's `.pi/skills`
- a file in the internal folder's `instructions` folder
- the context files of a registered workspace and of each of its parent folders: `AGENTS.override.md`, `AGENTS.md`,
  `AGENTS.MD`, `CLAUDE.md` or `CLAUDE.MD`, the names the agent reads, including a file the agent skips because another
  name in the same folder takes its place

A file that isn't UTF-8 text or is larger than 1 MiB is refused.

A file that is a symbolic link is read and saved at the link's target, wherever it is, and the link stays. Whether the
target can be read or written depends on the permissions of the account The Intern runs as, and a refusal shows the
system's reason.

A save through a link replaces the target file with a new one. A target that another account owned becomes owned by the
account The Intern runs as; its mode is kept, and so is its group where that account may set it. A target in a folder
that account can't write is refused, even when the file itself is writable. The editor never creates or deletes a file.

If the file changed on disk after the editor read it, the service refuses **Save** as a conflict. The page shows the
refusal, keeps the text you typed and offers **Use the text from disk**. Select it to replace your text with the file's
current text, then make your edit again and save. Until you select it, nothing you typed is lost and nothing on disk is
overwritten. Any other refusal shows its reason the same way and keeps your text.

## Workspaces

The Workspaces page lists the registered workspaces. To register one, give the absolute path of an existing directory
on the machine where the service runs, and select **Register**. Select **Unregister** to remove one from the list. The
service refuses a path that doesn't exist, and the page shows its message.

## Schedules

The Schedules page lists the schedule entries, each with its next due time, its recent scheduled runs linked to their
Job pages and its skipped fires with the reason. You can add, change, run now and remove an entry there. The page stays
current without a reload. [Schedules](schedules.md) describes the entries, the skip rules and the run history.

Each entry has a collapsed **Skills** control that opens the [Skills panel](#the-skills-panel) of the entry's role, or
of `bob` when the entry names none. It shows the role's skills, so you can check what a scheduled run starts with. A
change there is a change to the role and affects only agents seated afterwards.

## Mail

The Mail page lists the mail accounts. [Email](email.md) explains the two kinds of account, the statuses and the
sign-in. The page stays current without a reload, and it does what the [`bob mail`](commands.md#mail) commands do.

Each account is a card with its address, kind, status, last error and last check, and with fields for the secret
(**Password** or **Client secret**, as its authentication needs), the check interval, the triage role and the allowlist,
one address per line. The card has no field for the address, servers, security, login, password command, client ID or
tenant. To change those, remove the account and add it again, or use `bob mail change`. The status is
`connecting`, `ready`, `needs_sign_in` or `failing`, and it changes on the card as the service checks the account.
Each card has four actions:

- **Save** changes the account with the fields as they stand. It can't change the name or the kind.
- **Test** logs in to the account's IMAP server and, when it has one, its SMTP server, and shows `IMAP: ok` or
  `IMAP: failed` with the reason, and the same for SMTP. It sends nothing.
- **Sign in** starts the sign-in of a `google` or `microsoft` account. For Microsoft the page shows the address and the
  code to enter there. For Google it shows a link, with the port to forward when you open it from another machine. The
  instructions go away once the account is `ready`. [Sign in with Google](email.md#sign-in-with-google) and
  [Sign in with Microsoft](email.md#sign-in-with-microsoft) describe the steps.
- **Remove** removes the account and its secrets. Its jobs and their saved mail stay. It asks for no confirmation.

**Add an account**, at the end of the page, creates one from its name, kind, address, servers, login and
authentication, with the fields that kind of authentication needs. An account of kind `owned` turns each new email in
its inbox into a job.

A secret field, the password or the client secret, is never filled in. The service doesn't send a secret to the page.
Leave the field empty and **Save** keeps the stored secret; type a new one to replace it. The page clears the field
after each try.

**Notice mail**, at the top, sets the notice address and the owned account that sends to it, with **Save** and
**Clear**. See [The notice address](email.md#the-notice-address). When the service refuses an action, the page shows its
message and changes nothing.

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
- **No file browsing.** You can't open a workspace's files, except its `AGENTS.md` and `CLAUDE.md` and the skill files
  the [Skills panel](#the-skills-panel) lists. An agent's other file changes appear only in its tool calls and results.
- **No creating or deleting skill folders or files.** You edit the text of files that exist.
- **No login and no encryption.** See the warning above.
- **No page for knowledge sources.** It comes with its feature.
- **No import.** It stays on the command line.
- **No export to a path on the service's machine.** The browser downloads the file; use
  [`bob export <file>`](commands.md#bob-export-file) for a file on the machine itself.
- **No settings of its own.** The `[network]` section of `config.toml` sets its address and port.
