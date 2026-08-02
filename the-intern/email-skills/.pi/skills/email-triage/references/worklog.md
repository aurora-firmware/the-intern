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
  workflow, sent an escalation email, or attempted and was blocked by S-004.
- **Left** — what remains open, if anything. "Nothing" for a fully-handled
  message; otherwise a short description of the open condition (e.g.
  "awaiting manager reply", "blocked by S-004 — no admitting allow rule").
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

- bob was stopped across a scheduled tick (ADR-006) — the tick is skipped
  silently, no process and no record;
- the schedule entry's per-entry `cwd` was missing at fire time (S-009);
- `max_processes` was exhausted, so no dedicated worker was available for a
  per-entry-`cwd` job (S-002).

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
`\Seen` flag as a side effect regardless of what the classification decides
to do — acting, escalating, or hitting an S-004 block all mark the message
`Seen` the same way. That means the mailbox itself cannot be used to tell
"still needs attention" apart from "fully handled": once read, a message
never reappears as unseen on a later tick no matter how the run left it.

Because of this, an escalated or blocked message is carried forward as an
open item through the worklog **only** — its `Left` field staying anything
other than "nothing" is what marks it open. Never infer that a message still
needs attention from its `Seen`/unseen state, and never rely on toggling
`Seen` back off as a way to mark something open; the worklog entry is the
sole record.

## How an open item closes

An open item has exactly two causes, and each closes differently:

- **Escalation.** Closes when the manager's reply arrives — as ordinary
  unseen mail in the mailbox, addressed back through normal delivery, with
  no separate reply channel. It re-enters triage like any other unseen
  message on a later run and is classified and handled from there; nothing
  about the original entry auto-resolves it.
- **S-004 block.** Closes once an admitting allow rule is added to bob's
  action ruleset so the previously-blocked `bash`/himalaya call is no longer
  denied. There is nothing to do inside this skill to close a block — it
  closes only when the S-004 configuration changes, and the next run's
  attempt then succeeds.

Until one of those conditions is met, the item is not closed. During
first-run reconciliation, every entry still found open in the most recent
worklog file with open items is re-checked against these two conditions:

- if resolved, note the resolution in today's file (e.g. "Left: nothing —
  manager reply received and handled" or "Left: nothing — allow rule now
  admits this call, retried and succeeded") and the item is done;
- if not yet resolved, append an entry to today's file recording it as still
  open (`Left` unchanged from the source item, `Next` restating what would
  close it) — this is what "carried forward" means concretely. Because that
  entry lands in *today's* file, today's file becomes the most recent
  worklog file with open items, so the next day's first-run reconciliation
  finds it without needing to look further back.

Unresolved items are carried forward this way at every subsequent day's
first-run reconciliation until whichever condition above actually closes
them — there is no automatic expiry.
