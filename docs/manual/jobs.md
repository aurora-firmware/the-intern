# Giving, following and answering jobs

A job is the unit of work you give The Intern: a request, what must be delivered, and the record of how it went. This
page explains what a job is, how it moves from To do to Done, and how you create, follow, edit, answer and end one.
Until the command line and the web interface release their own commands and pages for jobs, you work with jobs through
the job operations, which you call over the local socket.

## What a job is

You hand over a job as text. The Intern keeps that text exactly as you wrote it, together with where it came from, and
starts a lead agent on it. The lead is an agent of the role `bob` unless you name another role. See
[Roles, workspaces and agents sharing a job](roles_and_agents.md).

A job holds these fields:

| Field              | What it holds                                                                                |
| ------------------ | -------------------------------------------------------------------------------------------- |
| `number`           | The short number you name the job by, such as `C-14`.                                        |
| `request`          | The text you gave and where it came from. You can't change it.                               |
| `title`            | A short name. It can be empty until the lead writes one.                                     |
| `description`      | The goal, the needs, the plan and the analysis.                                              |
| `definitionOfDone` | What decides that the job is done. It can be empty until the lead writes one.                |
| `status`           | `to_do`, `in_progress`, `blocked` or `done`.                                                 |
| `blockedReason`    | What the job lacks, while it is Blocked.                                                     |
| `resolution`       | How a Done job ended: `completed` or `cancelled`, with a justification.                      |
| `related`          | The short numbers of the jobs Related to this one.                                           |
| `statedBy`         | A name the creator gave itself. It is kept apart from the request and is not checked.        |
| `createdAt`, `updatedAt`, `doneAt` | When the job was created, last changed and became Done.                      |

You can edit `title`, `description` and `definitionOfDone`. Every other field changes only through the actions below.
A job read with `jobs.get` also shows its `leadConversation`, the conversation the lead works in.

### Short numbers

A short number is a letter, a hyphen and a counter: `C-14`. The letter tells you where the job came from, and each
letter counts on its own, starting at 1. A number is never reused, even when the job is cancelled.

| Letter | Where the job came from                                   |
| ------ | --------------------------------------------------------- |
| `C`    | A request through the local socket (the command line).    |
| `W`    | A request through the network listener (the web interface). |
| `E`    | A request by email.                                       |
| `S`    | A schedule.                                               |
| `T`    | A trigger.                                                |
| `A`    | A follow-up job, created by an agent while it worked on another job. |

Wherever an operation asks for a job, give its short number in any letter case, so `c-14` and `C-14` name the same job.

## Statuses and actions

A job has one of four statuses and moves between them only through five actions.

| Status      | Meaning                                                                                  |
| ----------- | ---------------------------------------------------------------------------------------- |
| To do       | The job exists and its lead waits for a free worker thread.                              |
| In progress | The lead is working on it.                                                               |
| Blocked     | The lead lacks something and waits for an answer. No agent works on the job.             |
| Done        | The job ended, completed or cancelled. This status is final.                             |

| Action   | Moves the job                          | Who does it                                                                   |
| -------- | -------------------------------------- | ----------------------------------------------------------------------------- |
| start    | To do to In progress                   | The Intern, when the lead's first run gets a worker thread.                   |
| block    | In progress to Blocked                 | The lead agent only. It needs a Blocked reason.                               |
| resume   | Blocked to In progress                 | The Intern, on any message to the lead; or you, with `jobs.resume`.           |
| complete | In progress to Done, `completed`       | The lead agent, or you with `jobs.complete`. It needs a definition of done and a justification. |
| cancel   | To do, In progress or Blocked to Done, `cancelled` | You, with `jobs.cancel`. It needs a justification. |

An action from a status that doesn't allow it is refused as `conflict`. An action with a missing reason or
justification, or a complete with no definition of done, is refused as `invalid_input` and names the field.

A job never goes back to To do. Done is final: you can't edit a Done job, add to its worklog, resume, complete or cancel
it. The one change still allowed is relating it to another job. More work on a finished job becomes a new job, Related
to the old one.

Completing or cancelling a job aborts every conversation of the job, so nothing stays parked or waiting for a report.

## The definition of done

The definition of done is the one field that controls completion. It is a clear deliverable, action or end state that
tells anyone, the lead included, whether the job is done. Goal, needs, plan and analysis go in the description.

The lead's first duty is to make sure the job has a definition of done. It writes one if there is none. If it can't,
it blocks the job and says why. Before it completes the job, it checks the result against the definition of done and
states the evidence in the justification. You can write or change the definition of done yourself at any time while the
job isn't Done.

## A Blocked job

The lead blocks a job when it lacks information, a decision or access the service account doesn't have. The Blocked
reason says what is missing. A Blocked job holds no worker thread, and its lead is parked. Only the lead blocks a job,
so Blocked never means a pause that you asked for. The lead can't block while an agent it invoked still runs.

To answer, send the lead a message. Any message that reaches the lead of a Blocked job resumes the job: it becomes In
progress, the Blocked reason is cleared, and the lead continues with your message as its input. The old reason stays in
the job's history. You can send the message with `jobs.resume`, as shown below, or with any other operation that sends
input to the lead conversation.

The Intern blocks a job on the lead's behalf in two cases, with the daemon as author in the history:

- A lead's turn ends with the job In progress and nothing left to wait for, and the job has no definition of done. The
  reason is "no definition of done".
- A lead's turn ends the same way twice: the lead first gets one reminder to continue, block or complete, and when it
  stops again the reason is "the lead stopped without completing or blocking".

## The resolution

A Done job has a resolution. Its kind is `completed` or `cancelled`, and its justification says why: for a completed job
the evidence that the definition of done is met, and for a cancelled job the reason it ended, for example "duplicate of
C-7". If The Intern can't start the lead of a new job after it wrote the job, it cancels the job with a justification
that names the refusal.

## The worklog and the history

Each job has two records. You read both with `jobs.get`, or page them with `jobs.worklog.list` and
`jobs.history.list`.

- **The worklog** holds the notes that agents and team members write: what was tried, what was done, what is left. It
  lets another agent take over without reading the conversation. It only grows: a correction is a new entry. An entry
  has a time, an author and its text.
- **The history** is written by The Intern. It records every change to the title, the description, the definition of
  done, the status, the Blocked reason, the resolution and the Related links, with the old value, the new value, the
  author and the time. An author is an agent (with its conversation and role), a team member (with the way in), or the
  daemon.

## Related jobs and follow-up jobs

Related is a link between two different jobs of any status, in both directions. It is the only link between jobs;
there are no sub-jobs or dependencies. Relate and unrelate through `jobs.relate` and `jobs.unrelate`. Relating two jobs
that are already related changes nothing.

An agent that finds more work while it works on a job creates a follow-up job with its job tools. The new job has the
letter `A`, records the job and conversation it came from, and is Related to the job it came from.

## Work with jobs over the local socket

Every call is a `POST` of a JSON body to `/operations/<name>`, made with the `application/json` content type. The local
socket is `bob.sock` in the runtime directory (see [Running The Intern](running_the_intern.md)). The examples use
`curl` and set the socket once:

```
SOCKET="$XDG_RUNTIME_DIR/the-intern/bob.sock"
```

Use the path of your runtime directory if it isn't the default. A call that works answers `{"result": …}`. A call that
is refused answers `{"error": {"code": …, "message": …}}`, where the code is one of these:

| Code            | Meaning                                                                          |
| --------------- | -------------------------------------------------------------------------------- |
| `invalid_input` | A required input is missing or wrong, a guard failed or a field can't be edited. |
| `not_found`     | No job has that number.                                                          |
| `conflict`      | The action isn't allowed from the job's status, or the job is Done.              |
| `busy`          | The database is in use. Export again in a moment.                                |
| `unavailable`   | The service is stopping.                                                         |
| `internal`      | The service failed. After a failed database write the service stops (see [Running The Intern](running_the_intern.md#start-the-service)). |

### Create a job

`jobs.create` takes `text`, the request, and these optional inputs: `title`, `statedBy`, `idempotencyKey`, `role`,
`model`, `thinkingLevel` and `workspace`. A role, model, thinking level or workspace that can't be used refuses the call
with `invalid_input` and leaves no job and no number.

```
curl --unix-socket "$SOCKET" -X POST -H 'Content-Type: application/json' \
  -d '{"text": "Rotate the staging TLS certificate", "title": "Rotate staging certificate"}' \
  http://localhost/operations/jobs.create
```

The answer is `{"result":{"number":"C-1",…}}`: the new job, with its lead conversation started. The job is To do until
the lead gets a worker thread, then In progress. Give an `idempotencyKey` of your choice when you may repeat the call,
for example after a timeout: the repeat returns the same job and uses no number. You can't give an `origin`: The
Intern records it from the way in you used.

### Follow jobs

List jobs, newest first. `jobs.list` takes the optional `status` (`to_do`, `in_progress`, `blocked` or `done`),
`letter` (`C`, `W`, `E`, `S`, `T` or `A`), `relatedTo` (a job), `limit` (1 to 500, 50 when you give none) and `cursor`.
It answers a page of jobs without worklog and history, and a `cursor` for the next page when there is one:

```
curl --unix-socket "$SOCKET" -X POST -H 'Content-Type: application/json' \
  -d '{"status": "blocked", "letter": "E"}' http://localhost/operations/jobs.list
```

Read one job with its worklog and history, oldest entry first:

```
curl --unix-socket "$SOCKET" -X POST -H 'Content-Type: application/json' \
  -d '{"job": "C-1"}' http://localhost/operations/jobs.get
```

To follow changes as they happen, open the feed. It starts with a `snapshot` event that lists the jobs that aren't Done
with their number, title and status, then sends a `delta` event for each change: `job_created`, `job_changed`,
`job_worklog_added`, `job_status_changed` (with the Blocked reason when the job blocks) and `job_done` (with the
resolution):

```
curl -N --unix-socket "$SOCKET" 'http://localhost/feed?scope=instance'
```

### Edit a job

`jobs.update` takes `job` and any of `title`, `description` and `definitionOfDone`. Naming any other field is refused
as `invalid_input` and changes nothing. Anyone, a team member or an agent of the job, can edit; when two edits change
the same field, the later one stands and both are in the history.

```
curl --unix-socket "$SOCKET" -X POST -H 'Content-Type: application/json' \
  -d '{"job": "C-1", "definitionOfDone": "The staging site serves the new certificate and the old one is revoked."}' \
  http://localhost/operations/jobs.update
```

Add a note to the worklog with `jobs.worklog.add`, which takes `job` and `text`. Relate two jobs with `jobs.relate`,
which takes `job` and `other`; `jobs.unrelate` takes the same input.

### Answer a Blocked job

Read the job and its `blockedReason`, then call `jobs.resume` with `job` and the answer as `text`:

```
curl --unix-socket "$SOCKET" -X POST -H 'Content-Type: application/json' \
  -d '{"job": "C-1", "text": "The nightly build on ci-2, failing since Monday."}' \
  http://localhost/operations/jobs.resume
```

The job becomes In progress and the lead continues with your text. Without `text`, the lead gets a note that a team
member resumed the job. `jobs.resume` on a job that isn't Blocked is refused as `conflict`.

### Complete or cancel a job

Both take `job` and a `justification`. The lead completes a job through its own tool, so you complete one only when you
have checked the result yourself; the job must have a definition of done.

```
curl --unix-socket "$SOCKET" -X POST -H 'Content-Type: application/json' \
  -d '{"job": "C-1", "justification": "Checked: the staging site serves the new certificate."}' \
  http://localhost/operations/jobs.complete

curl --unix-socket "$SOCKET" -X POST -H 'Content-Type: application/json' \
  -d '{"job": "C-2", "justification": "Duplicate of C-1."}' \
  http://localhost/operations/jobs.cancel
```

You can cancel a job in any status except Done. You can complete only a job that is In progress. A team member has no
operation to block a job.

### Export and import

`jobs.export` copies the whole database to a new file while The Intern keeps working. It holds the jobs, their
worklogs and histories, and the conversations and queued work, but not `config.toml`, so back that file up on its own:

```
curl --unix-socket "$SOCKET" -X POST -H 'Content-Type: application/json' \
  -d '{"path": "/home/you/backups/the-intern.sqlite"}' http://localhost/operations/jobs.export
```

The answer is the path and the size written. The path must be absolute and name a file that doesn't exist yet in a
folder that does. [Running The Intern](running_the_intern.md#copy-the-database-as-a-backup) describes the copy.

The import step places an exported file as the database of an instance that has none. It runs while the service is
stopped and has no `bob` command yet; the command line documentation names it when it ships. See
[Running The Intern](running_the_intern.md#restore-a-copy-as-the-database) for what it checks and refuses.

## What jobs don't do

- **No priorities, due dates, estimates or time tracking.** Jobs start in the order they arrive.
- **No assignees, watchers, votes, labels or attachments.** Every team member is equal, and the lead conversation is
  the only owner a job has.
- **No reopening.** A Done job stays Done.
- **No sub-tasks or dependencies.** Related is the only link, and agents the lead invokes take the place of sub-tasks.
- **No blocking by a team member.** Only the lead blocks a job.
- **No permissions per field or per person.** Anyone who reaches The Intern can change any editable field.
- **No syncing with outside ticket trackers.**
- **No deleting of jobs and no clean-up of old ones.** Every job is kept.
- **No conversion between incompatible versions.** An import restores a copy into a version that can read it.
