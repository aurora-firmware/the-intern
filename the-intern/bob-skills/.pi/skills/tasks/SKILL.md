---
name: tasks
description: >
  Task-board discipline for anything that must survive past the end of this
  run: filing new work, seeing what's open, moving a task between statuses,
  logging a note against it without changing its status, and reading one
  back. Use this skill whenever a piece of work will not be finished before
  this session ends, when a task needs to be picked up by an operator or by
  a later, independent run with no memory of this one, or when work stalls
  and the reason it stalled needs to survive after this run ends. This
  skill does not decide the on-disk file format or the exact command
  syntax — the task-board command that backs it is the only authority on
  both — it decides when something belongs on the board at all, how to
  describe it so a cold reader can act on it, what each status commits the
  board to, and which subcommand performs each move. Load this skill
  before running any task-board command, or before deciding whether a
  piece of work needs a task at all.
allowed-tools: Read Bash
---

# Tasks

A task board is a set of small markdown files that outlive a single
session. Unlike an in-session checklist — a plan a run keeps to organize
its own remaining steps and discards once it finishes — a task on the
board is visible to every other run and to the operator, and stays there,
finished or not, until something explicit closes it.

This is the board-discipline skill: it says when work belongs on the
board, how to write a task so a reader with none of this run's context can
pick it up, and what each status and subcommand mean. It is not an
account of the file format: the task-board command that reads and writes
these files is the only thing that defines that, and a description here
that tried to restate it would only be free to drift out of date. Where
exact syntax matters, this skill points at the command's own help instead
of repeating it.

## When work belongs on the board

Put something on the board when any of the following is true:

- It will not be finished before this run ends.
- Someone other than this run — a later scheduled run, a different chat
  session, or the operator — needs to be able to find it, understand it,
  and continue it without asking this run any questions.
- The work has stalled, and the fact that it stalled, and why, needs to
  survive after this run ends.

Keep it off the board, as an ordinary in-session plan instead, when the
work will be fully finished — done or abandoned — before this run's own
output is returned. A checklist kept purely for a single response's own
bookkeeping is not a task; forcing every such step onto the board only
adds noise nobody else will ever act on.

## Writing a task a cold reader can act on

Assume nothing survives from this run's own context: not this
conversation, not files scratched elsewhere in the workspace, not "you'll
remember what I meant." Someone with none of that has to be able to read
the task file alone and know what to do.

- **Description.** State what needs to happen and why it matters, in
  enough detail that a reader with no other context can start work
  immediately. If finishing the task depends on information that lives
  somewhere else — a file, a prior conversation, a person to ask — either
  fold that information into the description or say explicitly where to
  find it. A description that only makes sense to whoever wrote it has
  failed at its one job.
- **Definition of Done.** List the checklist of observable conditions that
  make the task finished. Each item should be something a reader can check
  for themselves — "the new file exists and contains X," "the command
  runs and reports Y" — rather than something that depends on judgment the
  writer had in their head and never wrote down. If a reader cannot tell
  whether an item is satisfied without asking the original author, the
  item is not specific enough yet.

Write both at task-creation time, not later. A task created without a
real description or Definition of Done just moves the cold-start problem
onto whoever picks it up next.

## What each status commits to

- **todo** — not yet started. Anyone can pick it up; nothing about it is
  claimed.
- **doing** — actively being worked. Before starting work on a task
  already marked doing, or moving a task to doing, make sure nothing else
  is already mid-flight on it — two runs editing the same task at once is
  not reconciled automatically.
- **blocked** — stalled on something outside this run's control. A
  blocked task that just says "blocked" is nearly useless to whoever
  finds it next: record what it is waiting on (a decision, an external
  event, another task) and who or what owns lifting the block, so a
  reader can tell whether they are the one who can unblock it or whether
  they should leave it alone. The command accepts a move to blocked with
  no such note; the discipline of supplying one is entirely on whoever
  makes the move.
- **done** — finished. Before moving a task to done, check that its
  Definition of Done items are actually satisfied. The command does not
  enforce this — it will accept the move regardless — so the discipline
  is the only thing that keeps "done" meaning "done."

## Which subcommand performs each move

- **File new work** — creates a task with its initial status,
  description, and Definition of Done.
- **See what's open** — lists tasks grouped by status; finished work is
  hidden by default and has to be asked for explicitly.
- **Move a task between statuses** — changes todo/doing/blocked/done and
  records why the move happened. Always give a reason when moving to
  blocked; that reason is what makes the block legible to the next
  reader.
- **Record progress without changing status** — appends a dated note to
  a task without touching todo/doing/blocked/done. Use this for a status
  update, a partial result, or context worth leaving behind mid-task.
- **Read a task back** — prints a task's contents, or just its file
  path, by its full or partial identifier.

The exact flags each of these takes are not repeated here — run the
command's own help for the current, authoritative syntax rather than
trusting this description to have kept up with it.

## Where the board lives

Board discovery walks upward from the current working directory to find
the nearest task board already in place, and creates one where discovery
started if filing a new task finds none upward. This means every run
started anywhere inside the same workspace reaches the same board rather
than starting a second one — the board's location is resolved from where
the command runs, not chosen by hand.

## Tool usage

Every call this skill makes is subject to the host system's own
action-authorization gate, the same as any other tool call a session
makes. This skill's runtime surface is narrow: **`bash`**, to run the
task-board command itself. If a call this skill makes is denied, that is
a deployment gap in the admitting allow rule, not a reason to work around
it by editing task files directly — the board's files are meaningful only
through the command that owns their format.
