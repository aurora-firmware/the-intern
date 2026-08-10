# Worklog Reconciliation

## First-run reconciliation

Reconciliation happens once — on each calendar day's **first executed run**,
never on every tick. A `*/15`-style cron does not revisit the open-item list
intra-day; every run after the first for a given day skips reconciliation
entirely and goes straight to the consuming skill's own domain work.

Do not assume the previous run was yesterday. Any of the following can
eliminate an entire day's runs with no trace in this workspace:

- the host service was stopped across a scheduled tick — the tick is
  skipped silently, no process and no record;
- the schedule entry's per-entry working directory was missing at fire
  time;
- a process-count limit was exhausted, so no dedicated worker was available
  for a per-entry-working-directory run.

Because of this, first-run reconciliation must read **the most recent
worklog file that still contains open items** — found by walking
`<workspace>/worklog/*.md` from today's date backward, in date order, and
opening each file until one is found containing at least one entry whose
`Left` is not "nothing" — not simply the file for the previous calendar day.
If no such file exists (every prior day was fully closed out, or no prior
worklog exists at all), there is nothing to reconcile and the run proceeds
straight to the consuming skill's own domain work.

## Open items are tracked in the worklog only

An item's open/closed status is recorded solely in its worklog entry's
`Left` field — never inferred from, or represented in, any state belonging
to whatever system supplied the item. If handling an item causes a side
effect in that upstream system — for example, marking it fetched, viewed,
or delivered — that side effect typically happens the same way regardless
of the outcome (acted on, escalated, or blocked all trigger it alike). That
means the upstream system's own state cannot be used later to tell "still
needs attention" apart from "fully handled": once that side effect has
happened, the upstream system may give no further signal that the item
still needs attention.

Because of this, a still-open item is carried forward as an open item
through the worklog **only** — its `Left` field staying anything other than
"nothing" is what marks it open. Never infer that an item still needs
attention from any upstream system's own state, and never rely on toggling
that state back as a way to mark something open; the worklog entry is the
sole record.

That applies equally to a blocked action that was meant to close an item.
Once an item has been handled, the upstream system's own state may already
reflect that handling, but the open item itself still lives only in the
worklog entry. The entry must not be rewritten as a successful close just
because the intended action was to close it.

## How an open item closes

This skill defines no closing conditions of its own: what actually resolves
a given open item is domain policy the consuming skill owns entirely (for
example, a specific reply arriving, or a specific block being lifted). What
this skill owns is the mechanics of carrying an open item forward, unclosed,
until whatever the consuming skill's own condition is has been met:

- Until an open item's own closing condition is met, at each day's
  first-run reconciliation every entry still open in the most recent
  worklog file with open items is carried forward: append a corresponding
  entry to today's file noting it is still open (`Left` unchanged from the
  source item, `Next` restating whatever will close it, per the consuming
  skill's own policy — for a blocked action, this is also the point at
  which the consuming skill retries it, since no other point in the
  workflow revisits it).
- Because that carried-forward entry lands in *today's* file, today's file
  becomes the new "most recent worklog file with open items," so the next
  day's first-run reconciliation finds it directly rather than needing to
  look further back.
- There is no automatic expiry. An item stays open, carried forward this
  way day after day, until the consuming skill's own condition genuinely
  closes it.
