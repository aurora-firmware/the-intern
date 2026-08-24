---
name: worklog
description: >
  Domain-free diary discipline that gives an independent, possibly-scheduled
  run continuity purely from files in its own working directory — no
  service-side session, queue, or other external state may be relied on to
  remember what a previous run did. Defines where the diary lives, how to
  create what is missing, the per-item entry format, how to tell whether a
  run is the day's first executed run, how first-run reconciliation carries
  forward still-open items, and the mechanics of carrying an open item
  forward until it closes. This skill owns no domain policy: it does not
  decide what counts as an item, how items are discovered, what action is
  taken on one, or what condition closes one — a consuming skill supplies
  all of that and calls into this discipline only for the diary mechanics.
  Load this skill whenever a task needs run-to-run continuity recorded to a
  per-day file, regardless of what kind of work is being tracked.
---

# Worklog

This is the diary-mechanics skill: it owns where the diary lives, how to
create it, its entry format, and how one run picks up where a previous run
left off — not what work is being tracked or what closes an open item. A
consuming skill decides what an "item" is, how items are found, what to do
with each one, and when an open item is genuinely resolved; this skill only
gives that work continuity across independent runs.

Every run that uses this discipline follows the same shape: determine
whether this is today's first executed run and reconcile if so, do whatever
domain work the consuming skill defines, and record one worklog entry per
item handled. The full mechanics for each part live in
`references/entry-format.md` and `references/reconciliation.md` rather than
being restated here.

---

## Tool usage

Every tool call this skill makes is subject to the host system's own
action-authorization gate, the same as any other tool call a session makes.
This skill's own runtime surface is narrow and uniform, so one allow-rule
set can admit all of it:

- **`read`** — prior worklog file contents only, read during first-run
  reconciliation (see `references/reconciliation.md`).
- **`bash`** — checking whether the worklog directory or today's file
  exists, creating either when missing, and appending each per-item entry
  (see `references/entry-format.md`).

If any of these calls is denied by the action-authorization gate, that is a
deployment gap in the admitting allow rule, not a per-item condition —
there is no lower-level record left to write for that run. Treat it as a
run-ending problem for this run.

---

## Location

One file per calendar day, at:

```
<workspace>/worklog/<YYYY-MM-DD>.md
```

`<workspace>` is the run's own working directory. `<YYYY-MM-DD>` is today's
date in the local calendar day the run executes in.

---

## Determining whether this is the day's first executed run

Check whether today's worklog file, `worklog/<YYYY-MM-DD>.md`, already
exists. Its absence is the signal that no run has written to today's file
yet — reuse that existing file's presence as "is this the day's first
executed run" rather than keeping a second, skill-owned last-run marker
file.

- **File does not exist yet:** this is the day's first executed run. Before
  doing any of the consuming skill's own domain work, follow
  `references/reconciliation.md`'s "First-run reconciliation" section to
  find the most recent worklog file with open items and carry every
  still-open entry forward into today's file.
- **File already exists:** some run has already written to today's file
  (whether or not that run needed reconciliation) — skip reconciliation.
  (If an earlier run today reconciled nothing and had no items to record,
  today's file may still be absent; the next run repeats this same check,
  which is harmless — reconciliation is idempotent when there is nothing
  open to carry forward.)

---

## Recording an entry for each item a run handles

Whatever the outcome of the consuming skill's own domain work on an item —
acted on, escalated, blocked, or any other outcome that skill defines —
append one entry to today's worklog file for it, creating
`worklog/` and today's file first if either is still missing. Do this
before moving on to the next item, so a run interrupted partway still
leaves a complete record for every item it did finish handling.
`references/entry-format.md` defines the exact file-creation and
append-command shape, and the three fields (`Done`/`Left`/`Next`) every
entry must carry — do not restate or re-derive them here.

A completed run leaves no item without exactly one worklog entry recording
its outcome — never silently skipped.

---

## How an open item closes

This skill defines no closing conditions of its own: what actually resolves
an open item is domain policy the consuming skill owns entirely (for
example, a specific reply arriving, or a specific block being lifted). What
this skill owns is the mechanics of carrying an open item forward, unclosed,
until whatever the consuming skill's own condition is has been met — see
`references/reconciliation.md`'s "How an open item closes" section for the
full carry-forward mechanics. There is no automatic expiry: an item stays
open, carried forward day after day, until the consuming skill's own
condition genuinely closes it.
