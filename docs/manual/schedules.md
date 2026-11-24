# Schedules

A schedule entry is recurring work. At each due time The Intern starts a fresh job, with nobody present, and the job
runs and ends like any other job. A job that a schedule entry started is a scheduled run. Its short number has the
letter `S`, and its Request text is the entry's request. A scheduled run carries nothing over from earlier ones. Its
lead is told which entry started it and that it can read that entry's earlier scheduled runs.

Nothing else starts a job by itself. A job that ends or a mail that arrives starts nothing.

## Add an entry

You can add an entry in any of four ways:

- Run [`bob schedules create <name>`](commands.md#schedules).
- Select **Add** on the [Schedules page](#the-schedules-page).
- Ask the front desk in chat, for example "every night, check that the backups ran". See
  [The front desk](front_desk.md).
- Edit `config.toml` by hand.

Anyone who can reach The Intern can add an entry. It runs with the service account's access.

## The `[[schedule]]` section

Each entry is one `[[schedule]]` section in `config.toml`, in any order:

```toml
[[schedule]]
name = "nightly-backups"
cron = "0 2 * * *"
request = "Check that last night's backups ran and the services on the network answer."
role = "ops"
model = "provider/model"
thinking_level = "low"
workspace = "/srv/infra"
```

| Key              | Needed   | Meaning                                                                                      |
| ---------------- | -------- | -------------------------------------------------------------------------------------------- |
| `name`           | Yes      | The entry's name: 1 to 64 letters, digits and hyphens, starting with a letter or a digit. Names are case-sensitive and unique. You can't change a name, because it ties the entry to its history. |
| `cron`           | Yes      | When the entry fires: five fields, as [Time](#time) describes. An expression that can never come due, such as `0 0 31 2 *`, is refused. |
| `request`        | Yes      | The text of each scheduled run. It can't be empty.                                           |
| `role`           | No       | The role of the run's lead. An existing role. Without it, the lead is `bob`.                  |
| `model`          | No       | The model of the run's lead. Without it, the role's default model.                           |
| `thinking_level` | No       | The thinking level of the run's lead. Without it, the role's default.                        |
| `workspace`      | No       | The absolute path of a registered workspace. Without it, the role's default workspace.       |

The file uses `thinking_level`. The command takes `--thinking-level`, and the page labels it Thinking level. Any other
key is refused. A refusal names the entry, the key and the reason.

### Hand edits

The service reads hand edits of `config.toml` only at startup, like the rest of the file. A hand edit of an entry takes
effect at the next restart. If an entry breaks a rule, the service doesn't start: the error names the file, the entry
and the reason, and no job starts. The one exception is a model that isn't available. At startup an entry may name one,
and the thinking level only has to be a known level. Creating or changing an entry later checks that the model is
available and supports the thinking level.

If you edit the file by hand while the service runs, restart it before you add, change or remove an entry another way.
Otherwise the service refuses the change as a conflict, names the file and changes nothing. See
[Running The Intern](running_the_intern.md#the-configuration-file).

## Commands

The [Command reference](commands.md#schedules) lists every option and what each command prints. In short:

| Command                        | What it does                                              |
| ------------------------------ | --------------------------------------------------------- |
| `bob schedules list`           | List the entries with their next due time and latest scheduled run. |
| `bob schedules show <name>`    | Show one entry and its recent runs.                       |
| `bob schedules create <name>`  | Create an entry.                                          |
| `bob schedules change <name>`  | Change an entry.                                          |
| `bob schedules remove <name>`  | Remove an entry.                                          |
| `bob schedules run <name>`     | Start a scheduled run of the entry now.                   |

To list the jobs of one entry, run [`bob jobs list --schedule <name>`](commands.md#bob-jobs-list).

A change applies at once and is written to `config.toml` first. It affects only later fires: a job that is already
running keeps its role, model, thinking level and workspace.

## The Schedules page

Select **Schedules** in the sidebar, or open `/ui/#/schedules`. The page shows one card for each entry:

- The entry's name and its next due time.
- A form with Cron, Request, Role, Model, Thinking level and Workspace. Choose **Default** to leave a value unset. The
  name is fixed.
- **Save** changes the entry, and an unset value clears the entry's value. **Run now** starts a scheduled run.
  **Remove** deletes the entry.
- The ten most recent items of the run history, newest first.

Below the cards, **Add an entry** takes a name and the same values, and **Add** creates the entry. If the service
refuses a value, the page shows its reason next to the form or the entry, and nothing changes. The page follows the
service as it works: a new scheduled run or skipped fire appears without a reload, and a second browser shows each
change.

## Skipped fires

A fire creates no job and is recorded as a skipped fire when any of these holds:

| Reason                       | What the history shows                                             |
| ---------------------------- | ------------------------------------------------------------------ |
| The entry has an open scheduled run | "A job of this schedule entry is still open: S-4." The number links to the run. |
| The workspace's folder no longer exists | The reason names the folder.                              |
| The service refuses the job, for example because the model is no longer available | The reason names the refusal. |
| The entry has no model: it names none, and neither its role nor pi agent's settings do | The reason is "no model". |

An open scheduled run is one that is To do or In progress. A Blocked or Done scheduled run doesn't stop a fire: a
Blocked scheduled run stays Blocked while the next one starts, so the check goes on even when nobody answers.

A To do scheduled run is open too. It waits for a worker thread and starts as soon as one is free. A scheduled run
created with no model, as run now can do, waits for a model instead. While it is To do,
it holds back every fire of its entry, and run now is refused, until someone starts or cancels it. If it stays To do,
for example because a team member stopped its lead while it waited, send the lead a message to start it, or cancel the
job. See [Giving, following and answering jobs](jobs.md#statuses-and-actions).

A fire skipped for "no model" isn't made up after you sign in to pi and choose a default model. The entry's next due
time fires as usual, and the skipped fire uses no job number. An entry that names its own model fires as before, and so
does an entry whose role has a model of its own. See
[Models and the pi login](running_the_intern.md#models-and-the-pi-login).

A scheduled run that ends cancelled isn't run again until the next due time.

## Run now

**Run now** on the page, or `bob schedules run <name>`, starts a scheduled run at once. It doesn't change the entry's
next due time. The Job page and `bob schedules show` mark it as run on demand, and its origin records the way in you
used.

Run now isn't refused for want of a model. If the entry has no model, as described under
[Skipped fires](#skipped-fires), it creates the scheduled run's job. The job stays To do with the notice "There is no
default model: pi agent's settings name none. This conversation waits and runs once a model is available." It runs once
a model is available, and you send nothing again. Until then it counts as the entry's open scheduled run: it holds back
every fire of the entry and run now is refused (`busy`, naming the run). Cancel the job to free the entry sooner.

The service refuses it, creates nothing and records no skipped fire when:

- the entry has an open scheduled run (`busy`, naming the run);
- the workspace's folder doesn't exist, or the model isn't available (`invalid_input`, naming it);
- no entry has the name (`not_found`).

## Time

An entry's `cron` value has five fields separated by spaces: minute, hour, day of month, month and day of week. Each
field takes `*`, numbers, lists with `,`, ranges with `-` and steps with `/`. Day of week runs from 0 to 7, where 0 and
7 are Sunday. When you restrict both day fields, a time matching either one is due.

Every entry uses the local time of the machine where the service runs. There is no time zone for each entry. Times
that the manual, the commands and the page show carry their offset from UTC.

- When a clock change repeats a local time, that time is due once.
- When a clock change removes a local time, nothing fires at that time that day.
- The service doesn't catch up on missed due times. A due time that passes while the service is stopped or starting, or
  while the machine is off, starts no job and leaves no record, however short the gap. The next fire is the entry's
  next due time.
- A due time more than one minute old never fires. If the machine sleeps and wakes within a minute of a due time, it
  fires then.

A fire creates its job or its skipped fire within one minute of the due time. A job may then wait for a worker thread.

## Read the run history

An entry's run history lists its scheduled runs and its skipped fires, newest first.

- `bob schedules show <name>` prints the entry's values and next due time, then its recent runs. Each run shows its
  short number, fire time, whether it was run on demand, its status and, once Done, its resolution and justification.
  Each skipped fire shows its due time and reason, and the open scheduled run if there is one.
- The Schedules page shows the same items for each entry: a run as its fire time and a link to its Job page, a skipped
  fire as its due time, "skipped:" and the reason. Open the Job page for the status, worklog and resolution.
- `bob jobs list --schedule <name>` lists the entry's jobs.

A scheduled run's fire time is its due time, or the moment it started if you used run now.

On a scheduled run's Job page, the origin reads "Schedule", the entry's name and the fire time. A run on demand adds
"on demand by" and the way in, with the network address when the run came from the web interface, or "through the front
desk" when the front desk started it. See [The web interface](web_interface.md#job-page).

## Remove and add entries again

Removing an entry stops its fires. Its jobs and run history stay, and a job that is running carries on. If you add an
entry with the same name later, its history continues, and the earlier scheduled runs count toward the open scheduled
run rule. To pause an entry, remove it and add it again.

The service refuses to remove a role that an entry names, or whose per-role default workspace an entry names, and to
unregister a workspace that an entry names. The refusal names the entry.

## Entries and exports

Schedule entries live in `config.toml`, so they aren't in an export. Scheduled runs, skipped fires and the rest of the
run history are in the database, and travel with [`bob export`](commands.md#bob-export-file) and the Status page's
download. After [`bob import`](commands.md#bob-import-file) on an instance whose `config.toml` has no entries, the
history is there and nothing fires until you restore the entries. Back up `config.toml` on its own.
