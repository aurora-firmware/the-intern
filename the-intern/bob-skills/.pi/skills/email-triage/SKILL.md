---
name: email-triage
description: >
  Runs the scheduled email-triage workflow: on a "Check email" (or an
  equivalent scheduled triage) prompt fired from this package's own working
  directory, retry this job's own still-open tasks, detect unseen mail, and,
  for each unseen message, either act on it or escalate it to the
  configured manager address — filing a `bob task` for anything the run
  cannot finish this pass and recording a worklog entry for every message
  handled. This is the triage-policy skill: it carries the confidence-gated
  act-or-escalate decision and the retry, on every run, of every task still
  `blocked` or `todo` on this job's own task board. It delegates the diary
  mechanics — where the worklog lives, how today's file is created, and its
  entry format — to the `bob worklog` command, and the task-board
  mechanics — where the board lives, how a task is filed, moved, and read
  back — to the `bob task` command: load the `worklog` skill for when a run
  journals and the item-identifier convention, load the `tasks` skill for
  when work belongs on the board and what each status commits to, load
  `himalaya` for the mail commands, and see `references/worklog.md` (this
  skill's own email-specific diary notes) and `references/escalation.md`
  for the triage-specific rules this loop follows rather than restating
  them here.
allowed-tools: Read Bash
---

# Email Triage

This is the triage-policy skill: it decides what to do with a mailbox — not
how to drive `himalaya`, not how to keep a diary, and not how the task
board itself works. Every run of this loop follows the same four steps —
list this job's own task board and retry every task still `blocked` or
`todo`, detect unseen mail, act on or escalate each unseen message (filing
a task for anything this run cannot finish), and record a worklog entry
for it, naming any task filed or closed — and delegates the CLI mechanics
to the `himalaya` skill, the diary mechanics to the `bob worklog` command
(with the `worklog` skill for when a run journals and the item-identifier
convention), the task-board mechanics to the `bob task` command (with the
`tasks` skill for when work belongs on the board and what each status
commits to), and its own domain-specific reference detail to this skill's
own `references/` files rather than restating any of it here.

---

## Tool usage

Every tool call this skill, the `himalaya` skill, the `worklog` skill, or
the `tasks` skill calls for is subject to bob's action-authorization gate —
not only the himalaya invocations. The action-authorization gate governs
every pi-agent tool call, so the config read, the `bob worklog` calls the
`worklog` skill defines, the `bob task` calls the `tasks` skill defines,
and any on-demand `references/*.md` load are all gated the same way. This
skill keeps that surface uniform and explicit, so one narrow allow-rule set
can admit the whole package:

- **`read`** — reference material only: any `references/*.md` file — this
  skill's own references, the `worklog` skill's own references, and the
  `himalaya` skill's own reference file when that skill is in play. This
  skill never reads a `worklog/*.md` file itself; `bob worklog append`
  handles diary writes without a separate read, and this loop never calls
  `bob worklog list` on a run's behalf. It never reads a task file directly
  either; `bob task list` surfaces everything the loop needs from the
  board.
- **`bash`** — every himalaya CLI invocation (per the `himalaya` skill), the
  skill-local config read (`config/email-triage.toml`, from the job's own
  `cwd`), every worklog operation (`bob worklog append` once per message
  handled, per the `worklog` skill — this loop never calls
  `bob worklog list` on a run's behalf), and every task-board operation
  (`bob task list` once at the start of the run, and `bob task new` /
  `bob task status` as this run's outcomes require, per the `tasks`
  skill). `bob worklog` creates the
  worklog directory and today's file itself and stamps each entry from its
  own clock, and `bob task` creates the board itself where this job's own
  working directory names it — this loop never probes for, creates, or
  writes those files by hand. Keeping the config read and every mutation —
  worklog writes, task-board writes, and himalaya calls alike — on the
  same `bash` tool, rather than also reaching for the `write`/`edit` tools,
  keeps this package's whole runtime surface behind one tool family for a
  later allow rule to admit by argument shape.

If the `bash` call that reads `config/email-triage.toml`, a `bob worklog`
call, or a `bob task` call is denied by the action-authorization gate, that
is a deployment gap in the admitting allow rule, not a per-message
condition — there is no lower-level record left to write for that run.
Treat it as a run-ending problem for this run, the same way an unconfigured
`himalaya` account is a run-ending problem.

---

## The loop

### 1. List this job's own task board and retry open tasks

Call `bob task list`, with the board resolved **explicitly** to this job's
own working directory rather than through `bob task`'s own default upward
search — see the `tasks` skill's own "Where the board lives" section and
S-010's "Task board location" Configuration Requirement for why: an upward
search could let two independently scheduled jobs converge on one shared
board, each retrying the other's open items. Use `bob task`'s explicit
board-selection flag (or its documented environment-variable override —
run `bob task --help` for the current syntax) scoped to this job's own
working directory on every `bob task` call this skill makes, not only this
one. The `tasks` skill covers the command's own mechanics — how a task is
filed, listed, moved, and read back; do not re-derive or restate them here.

For this skill, every task still `blocked` or `todo` on that board is
something an earlier run could not finish: a pending manager escalation
(`todo`, awaiting a reply) or an action the action-authorization gate
refused (`blocked`, awaiting an admitting allow rule). Retry each of them
this run, before or alongside the new unseen mail below — no other point
in this loop revisits an unfinished item, so leaving one open on the board
without retrying it here would keep it stuck indefinitely:

- For a `blocked` task naming an action the gate refused, attempt that
  same `himalaya` `bash` call again.
  - If it now succeeds, the item is resolved: move the task to `done` via
    `bob task status`, then call `bob worklog append` once for it — the
    same item-identifier convention step 4 below uses (`<subject> (from
    <sender>)` of the message the task named) — with `Done` naming the
    task closed and describing the now-successful action, and `Left`:
    nothing.
  - If it is still refused, leave the task `blocked`. Record the attempt
    on the task itself (per the `tasks` skill's "Record progress without
    changing status") rather than in the worklog, so the board keeps
    showing what has already been tried.
- For a `todo` task naming an escalation still awaiting a manager's reply,
  there is nothing to actively resend this step: the reply, once it
  arrives, surfaces as ordinary unseen mail in step 2 below and is
  classified and handled like any other message. Closing that reply
  message's outcome — moving the task to `done` and naming it in that
  message's own worklog entry — is what resolves the item; see step 4.

### 2. List unseen mail

List unseen envelopes using the `himalaya` skill's own documented command
for filtering on the unseen flag (see its Operation Index → "Filter for
unseen mail") — do not restate the command or its syntax here; it belongs
to that skill, not this one. This is a `bash` call like every other
himalaya invocation, gated by the action-authorization gate the same way
(see "Tool usage" above). If it is denied, no message has yet been
identified as unseen, so there is nothing to record a per-message worklog
entry against yet — treat the block as a run-ending problem for this run
rather than a per-message open item.

Everything the rest of this loop does operates on the envelopes this
listing returns.

### 3. For each unseen message, act on it or escalate it

For every envelope the previous step returned, in turn:

1. Read the message (a `himalaya` `bash` call, subject to the
   action-authorization gate like any other) and classify it against the
   starter category taxonomy in
   `references/categories/README.md`: check the message against each
   category's listed matching signals, then apply that index's confidence
   rubric to decide whether this *specific* message is a confident match
   for exactly one category. The gate below is always confidence in that
   judgment for this message — never the action's reversibility, and never
   a sender allowlist.
2. **Confident match:** follow the matched category's own workflow file,
   `references/categories/<category>.md` (for example
   `references/categories/newsletter-bulk.md`), for what to do with this
   message — do not restate that workflow's steps here. Acting on it means
   whichever `himalaya` `bash` call(s) the matched workflow calls for —
   reply, forward, compose, move, flag, delete, whatever is appropriate —
   per the `himalaya` skill.
   - If any of those calls is denied by the action-authorization gate: stop
     acting on this message, do not substitute some other action instead,
     and file a `bob task` for it — status `blocked`, naming the message,
     the action that was refused, and what would need to change (an
     admitting allow rule) before it can be retried. Name that task in this
     message's worklog entry in step 4 below (`Left`: the blocked action;
     `Next`: retried the next time step 1 lists this job's own board). The
     message is not treated as handled.
3. **No confident match** (including an ambiguous match between two
   categories, which `references/categories/README.md`'s confidence rubric
   treats as not confident, and a message that does not clearly satisfy any
   one category's signals): escalate per `references/escalation.md` — send
   exactly one escalation email to the configured manager address and take
   no further action on this message this run. When the send succeeds,
   file a `bob task` for it — status `todo`, naming the message and the
   question the escalation asked — so a later run can tell this item is
   still awaiting the manager's reply; name that task in this message's
   worklog entry in step 4 below. Never fall back to choosing the closest
   category and acting on it anyway — "closest" is not "confident"
   (`references/categories/README.md`'s "No confident match" section).
   `references/escalation.md` defines the full escalation policy — the
   email's required content, what happens if the send is denied by the
   action-authorization gate, and what happens if `manager_address` is
   missing or malformed, including the fallback path for that
   missing-configuration case; do not restate any of it here. Never fall
   back to acting on the message autonomously because escalation failed or
   could not be attempted for any reason — `references/escalation.md`
   governs the outcome in every one of those cases.

   The `manager_address` lookup comes from the skill-local
   `config/email-triage.toml` in this job's own `cwd`; load it with `bash`
   (for example `cat config/email-triage.toml`) before attempting the
   escalation send, rather than using the `read` tool for that file.
   For the escalation email itself, use one explicit non-interactive
   `template write` -> `template send` pipe. The subject and a summary/
   excerpt of the body come from the message being escalated — untrusted,
   arbitrary-sender content — so they must never be typed directly into the
   command as literal quoted text: load them into shell variables first
   using the `himalaya` skill's "Embedding message-derived text safely"
   heredoc pattern (`references/command-reference.md`), then run:
   `himalaya template write -H 'To:<manager_address>' -H "Subject:Escalation: $SUBJECT" -- "$BODY" | himalaya template send`.
   Do not switch to the editor-based `message write`/`message reply` family,
   and do not spread the escalation across an editor session or temporary
   draft workflow.
   If that explicit send command is denied by the action-authorization
   gate, treat this message's outcome as **blocked**, not **escalated**:
   no escalation email was sent, so file a `bob task` for it instead of the
   `todo` task above — status `blocked`, naming the message and the refused
   send — and name that task in this message's worklog entry in step 4
   below (`Left`: the blocked escalation attempt; `Next`: retried the next
   time step 1 lists this job's own board).

Escalating and acting are mutually exclusive outcomes for a given message
on a given run — never do both.

### 4. Record a worklog entry for the message

Whatever the outcome above — acted, escalated, or blocked at either
step — call `bob worklog append` once for this message. The command
creates the worklog directory and today's file if either is still missing,
stamps the entry from its own clock, and takes the item-identifier plus the
`Done`/`Left`/`Next` fields every entry carries — the `worklog` skill
covers when to make this call and what those fields mean; do not restate
that here. This skill's own `references/worklog.md` defines the one thing
specific to email triage: the entry's item identifier is the message's
`<subject> (from <sender>)`. Do this before moving on to the next unseen
message, so a run interrupted partway still leaves a complete record for
every message it did handle before stopping.

The entry must describe the actual outcome from step 3, not the intended
one, and must name the identifier of any `bob task` this message's
handling filed or closed, so the diary and the board stay
cross-referenced:

- Filed a `blocked` or `todo` task this step (a blocked action, a blocked
  escalation send, or a successfully sent escalation)? Name that task's
  identifier in whichever of `Done`/`Left` describes the condition the
  task now tracks.
- Closed a task this step (this message was the manager's reply an earlier
  task was awaiting)? Name that task's identifier in `Done`, alongside
  moving it to `done` via `bob task status`.

If an escalation send was denied by the action-authorization gate, do
**not** write that an escalation email was sent. Record the blocked
attempt instead, with `Done` naming the blocked task filed for it, `Left`
describing the still-open message, and `Next` pointing to the retry the
next time step 1 lists this job's own board.

A completed run leaves no unseen message from step 2 without exactly one
of: an action taken, an escalation sent, or a block recorded as a filed
task — never silently skipped.
