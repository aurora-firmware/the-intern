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
