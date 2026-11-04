# The front desk and `bob chat`

The front desk is the one standing conversation of an instance. You ask it what is being worked on, and you give it
requests for work. It turns each request into a job. This page explains what it does and doesn't do, and how you talk
to it with `bob chat`.

## What the front desk is

Every instance has exactly one front desk. The daemon creates it the first time it starts, and it stays the same
conversation after every restart, with its history. Every team member shares it, by every way in: the command line and,
when it is released, the web interface. Everything anyone writes goes into one history, in the order it arrived, and the
history records the way in of each line. The front desk doesn't tell team members apart.

The front desk belongs to no job, and it never closes. Completing or cancelling a job doesn't touch it.

## What it does

The front desk is seated as the shipped `desk` role (see
[Roles, workspaces and agents sharing a job](roles_and_agents.md)). It can:

- **Answer questions about the work.** It reads jobs, conversations, the daemon's status and usage. Ask "what's
  blocked?" and it lists the Blocked jobs with their reasons.
- **Turn a request for work into a job.** It creates the job, then tells you the job's short number. A job it creates
  from a request you wrote with `bob chat` is numbered `C-n`. A job from a request through the web interface is numbered
  `W-n`. See [Giving, following and answering jobs](jobs.md#short-numbers). The job's origin records that the front
  desk created it.
- **Pass answers and steering to a job's conversations.** Ask it to tell `C-14` to use the staging database, and it
  sends your words to the job's lead conversation. Input to the lead of a Blocked job resumes the job. It can also
  stop a conversation of a job. The conversation's transcript shows that the input came through the front desk.
- **Maintain jobs.** It can change a job's title, description and definition of done, add to a worklog and relate jobs.

## What it doesn't do

The front desk never does the work itself. The `desk` role has no `read`, `write`, `edit` or `bash` tool, so it
changes no file and runs no command. It can't hand off, invoke agents, or block or complete a job. When you ask it for
work, it creates a job and the job's agents do the work.

## A Done job

When a job is Done, whether completed or cancelled, all of its conversations are closed for good. The front desk can
still read them. It can't pass answers or steering to them: its tools get an error result and change nothing, and the
front desk's run goes on. More work after a Done job is a new job. Ask the front desk to create one, and to relate it
to the first.

## Chat on a terminal

Run:

```
bob chat
```

On a terminal, `bob chat` shows the last lines of the front desk's history and a prompt. Type a line and press Enter to
send it. The answer prints as it streams, and what you type stays on the last line, below it.

- **Queueing.** A line you type while the front desk is busy queues, and the front desk answers it after the current
  line. A line sent to the front desk survives a restart of the daemon and is answered after it.
- **Ctrl-C** stops the front desk's current turn and drops the lines still queued. `bob chat` prints each dropped line
  on standard error, so you can send it again. The chat stays open. Pressed while Ctrl-D waits, it stops the turn and
  names the dropped lines, and the chat then exits 0.
- **Ctrl-D** leaves the chat and exits with status 0. It first waits for the answers to the lines the front desk has
  taken, so a long turn keeps the command open without a prompt. If the daemon is away when you press Ctrl-D, or goes
  away while it waits, the chat exits 0 and says on standard error that the daemon went away, naming each line that was
  not sent and each that was not answered.
- **A restart of the daemon.** `bob chat` prints a notice on standard error and tries again until the daemon answers. It
  then prints what the front desk wrote while it was away, and the chat goes on. A line you type meanwhile is sent when
  the daemon answers. The chat doesn't exit on its own.

### Start with an empty context

Run:

```
bob chat --reset
```

`--reset` empties the front desk's context before the chat opens. The front desk then answers without remembering
earlier lines. The history stays stored and you can still read it. The conversation, its seat and its number don't
change. A reset is the only way to start the front desk clean. Between resets, the daemon compacts a long context
itself.

## Chat without a terminal

When standard input or standard output isn't a terminal, `bob chat` shows no prompt, history or colour. This includes
`bob chat > answers.txt`. It sends each line of standard
input in turn, waits for the answer, prints it on standard output, and exits with status 0 at the end of input. A
script can use it:

```
echo "what's blocked?" | bob chat
```

The output holds the front desk's answer and nothing else. A long answer can take several minutes; `bob chat` waits for
it. If the daemon isn't running when the command starts, it prints a message on standard error and exits with status
3, as every command does (see the [Command reference](commands.md#text-json-and-exit-codes)). If the daemon goes away
later, the command prints a notice on standard error, waits for the daemon and goes on.

With `--json`, `bob chat` prints JSON instead of text. See [`bob chat`](commands.md#bob-chat) for the options and the
JSON.
