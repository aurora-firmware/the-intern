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
