# Daily Worklog

The worklog is the diary that gives independent scheduler firings continuity.
It lives entirely in the job's own working directory — no bob-side session or
queue state may be relied on to remember what happened on a previous run.

## Location

One file per calendar day, at:

```
<workspace>/worklog/<YYYY-MM-DD>.md
```

`<workspace>` is the job's own working directory (the scheduled entry's
per-entry `--cwd`). `<YYYY-MM-DD>` is today's date in the local calendar day
the run executes in.

## Creating the worklog file

Before appending an entry, check whether `<workspace>/worklog/` and today's
`<YYYY-MM-DD>.md` file inside it exist. If either does not exist — the first
run against a freshly deployed workspace has no `worklog/` directory at all,
and any run is the first to write on a given calendar day — create whatever
is missing (the directory, the file, or both) first, then append. Never skip
an entry because the directory or file was missing; missing is the normal
state for a brand-new day or a brand-new deployment, not an error condition.

Use this exact append-command shape for the write step:

```bash
TODAY=$(date +%F)
TIME=$(date +%H:%M)
mkdir -p worklog
cat >> worklog/$TODAY.md <<EOF
## $TIME — <subject> (from <sender>)

- Done: <what was done for this message this run>
- Left: <what is still outstanding, or "nothing" if fully resolved>
- Next: <what happens next, and on what trigger>

EOF
```

Keep the redirect target exactly `worklog/$TODAY.md`: cwd-relative and
unquoted immediately after `>>`. The deployed action-authorization rule for
this append step matches the literal substring `>> worklog/`, so rewriting the
redirect as `>> "worklog/$TODAY.md"` or as an absolute workspace path changes
the command text enough to miss the rule even though the append is otherwise
legitimate. This unquoted form is still safe here because `TODAY` comes from
`date +%F`, which yields only the calendar date characters used in the
worklog filename.

## Per-message entry format

Append one entry to today's file for every unseen message handled this run —
whether it was acted on, escalated, or blocked. Each entry records exactly
three things about that message:

```
## <HH:MM> — <subject> (from <sender>)

- Done: <what was done for this message this run>
- Left: <what is still outstanding, or "nothing" if fully resolved>
- Next: <what happens next, and on what trigger>
```

- **Done** — the concrete action taken this run: acted per a category
  workflow, sent an escalation email, or attempted and was blocked by the
  action-authorization gate. When the blocked call was the escalation send
  itself, `Done` must say the escalation attempt was blocked — not that an
  escalation email was sent.
- **Left** — what remains open, if anything. "Nothing" for a fully-handled
  message; otherwise a short description of the open condition (e.g.
  "awaiting manager reply", "blocked by the action-authorization gate — no
  admitting allow rule").
- **Next** — what will resolve the item and how it will be noticed (e.g.
  "closes when the manager's reply arrives as unseen mail", "closes once an
  allow rule admits this call — re-check at the next first-run
  reconciliation").

## First-run reconciliation

Reconciliation happens once — on each calendar day's **first executed run**,
never on every tick. A `*/15`-style cron does not revisit the open-item list
intra-day; every run after the first for a given day skips reconciliation
entirely and goes straight to listing unseen mail.

Do not assume the previous run was yesterday. Any of the following can
eliminate an entire day's runs with no trace in this workspace:

- bob was stopped across a scheduled tick — the tick is skipped silently,
  no process and no record;
- the schedule entry's per-entry `cwd` was missing at fire time;
- `max_processes` was exhausted, so no dedicated worker was available for a
  per-entry-`cwd` job.

Because of this, first-run reconciliation must read **the most recent
worklog file that still contains open items** — found by walking
`<workspace>/worklog/*.md` from today's date backward, in date order, and
opening each file until one is found containing at least one entry whose
`Left` is not "nothing" — not simply the file for the previous calendar day.
If no such file exists (every prior day was fully closed out, or no prior
worklog exists at all), there is nothing to reconcile and the run proceeds
straight to listing unseen mail.

## Open items live in the worklog only, never in mailbox flag state

Classifying a message requires reading it, and reading a message sets its
`\Seen` flag as a side effect regardless of what the classification decides to
do — acting, escalating, or hitting a block from the action-authorization gate
all mark the message `Seen` the same way. That means the mailbox itself cannot
be used to tell "still needs attention" apart from "fully handled": once read,
a message never reappears as unseen on a later tick no matter how the run left
it.

Because of this, an escalated or blocked message is carried forward as an
open item through the worklog **only** — its `Left` field staying anything
other than "nothing" is what marks it open. Never infer that a message still
needs attention from its `Seen`/unseen state, and never rely on toggling
`Seen` back off as a way to mark something open; the worklog entry is the
sole record.

That applies equally to a blocked escalation send. Once the message has been
read, it may already be `Seen`, but the open blocked-escalation item still
lives only in the worklog entry. The entry must not be rewritten as a
successful escalation just because the intended action was to escalate.

## How an open item closes

An open item has exactly two causes, and each closes differently:

- **Escalation.** Closes when the manager's reply arrives — as ordinary
  unseen mail in the mailbox, addressed back through normal delivery, with
  no separate reply channel. It re-enters triage like any other unseen
  message on some later run and is classified and handled from there;
  nothing about the original entry auto-resolves it — the reply's own
  per-message entry is what marks the matter handled.
- **Denied by the action-authorization gate.** Closes once an admitting
  allow rule is added to bob's action ruleset, so a retry of the
  previously-blocked `bash`/himalaya call is no longer denied by policy.

Until whichever condition applies is met, the item stays open. At each day's
first-run reconciliation, every entry still open in the most recent worklog
file with open items is carried forward: append a corresponding entry to
today's file noting it is still open (`Left` unchanged from the source item,
`Next` restating what would close it — for a block from the
action-authorization gate, this is also the point at which the blocked action
is retried, since no other point in the workflow revisits it). Because that
carried-forward entry lands in *today's* file, today's file becomes the new
"most recent worklog file with open items," so the next day's first-run
reconciliation finds it directly rather than needing to look further back.

There is no automatic expiry. An item stays open, carried forward this way
day after day, until whichever condition above genuinely closes it.
