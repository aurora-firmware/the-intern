# Worklog Reconciliation

## Reconciliation is automatic

A run never reconciles the worklog by hand. `bob worklog list` and
`bob worklog append` both reconcile today's file themselves, before doing
anything else, on every single call. A run gets its continuity simply by
calling `bob worklog list` at the start of the run; there is no separate
reconciliation step to remember and nothing to get wrong.

What the command does on each call:

- **It finds the nearest prior worklog file that exists** — the most recent
  dated file before today, whatever that file contains. A file that shows
  every item closed still counts as the source: the command reads it, finds
  nothing open to carry, and stops there rather than reaching further back
  to an older file. The nearest existing file is the only reconciliation
  source it consults.
- **It carries each still-open item forward once.** For every
  item-identifier whose most recent entry in that source file is still open,
  it adds one carried-forward entry to today's file — unless today's file
  already has an entry for that item, in which case it does nothing for it.
- **It is idempotent.** Because the carry-forward is decided by whether
  today's file already holds an entry for the item, calling the command
  again later the same day is safe: the second and later calls find the
  entry already present and add nothing.
- **It reports today's carried-forward set.** Every call returns the full
  set of still-open items now sitting in today's file as carried-forward
  entries — regardless of which call that day actually wrote them. A run
  reads that set from whichever call it makes first and treats it as the
  list of items still needing attention.

Do not assume the nearest prior file is yesterday's. Whole days can pass
with no run and no file at all — the host was down across a scheduled tick,
the run's working directory was missing when it should have fired, or no
worker was free. The command handles this by keying on the nearest file
that exists, not on the calendar.

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

Because of this, a still-open item is carried forward through the worklog
**only** — its `Left` field staying anything other than "nothing" is what
marks it open. Never infer that an item still needs attention from any
upstream system's own state, and never rely on toggling that state back as
a way to mark something open; the worklog entry is the sole record.

That applies equally to a blocked action that was meant to close an item.
Once an item has been handled, the upstream system's own state may already
reflect that handling, but the open item itself still lives only in the
worklog entry. The entry must not be rewritten as a successful close just
because the intended action was to close it.

## How an open item closes

This skill defines no closing conditions of its own: what actually resolves
a given open item is domain policy the consuming skill owns entirely (for
example, a specific reply arriving, or a specific block being lifted). Until
that condition is met, `bob worklog` carries the item forward every day:
each day, the first call that finds it still open copies it into that day's
file, with `Left` unchanged and `Next` still restating whatever will close
it. For a blocked action the consuming skill means to retry, the
carried-forward entry the command reports is the run's cue to retry it — no
other point in the workflow revisits it.

Because that carried-forward entry lands in today's file, the next day's
reconciliation finds it there directly, as the nearest existing file. There
is no automatic expiry: an item stays open, carried forward day after day,
until the consuming skill's own condition is met and a run records it closed
by appending an entry whose `Left` is "nothing".
