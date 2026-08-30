---
name: worklog
description: >
  Domain-free diary discipline that gives an independent, possibly-scheduled
  run continuity purely from files in its own working directory — no
  service-side session, queue, or other external state may be relied on to
  remember what a previous run did. It says WHEN a run records and reads that
  continuity: call `bob worklog list` once at the start of a run, then
  `bob worklog append` once for each item handled. It also teaches the
  item-identifier convention those calls use. It does not define the entry
  format, decide where today's file is created, detect whether a run is the
  day's first, or carry still-open items forward — the `bob worklog` command
  owns all of that and reconciles automatically on every call. This skill
  owns no domain policy either: it does not decide what counts as an item,
  how items are discovered, what action is taken on one, or what condition
  closes one — a consuming skill supplies all of that and calls into this
  discipline only to know when to journal. Load this skill whenever a task
  needs run-to-run continuity recorded to a per-day file, regardless of what
  kind of work is being tracked.
---

# Worklog

This skill says when a run records continuity and when it reads continuity
back, and it teaches the item-identifier convention the entries use. It does
not own the entry format, the location of today's file, detection of the
day's first run, or the carry-forward of still-open items — the `bob worklog`
command owns all of that. A consuming skill decides what an "item" is, how
items are found, what to do with each one, and when an open item is genuinely
resolved; this skill only tells that work when to journal so it survives
across independent runs.

Every run that uses this discipline follows the same shape:

- **At the start of the run**, call `bob worklog list`. The command
  reconciles today's file automatically before it returns — it carries every
  still-open item forward from the most recent prior day on its own — and its
  output reports today's carried-forward set for the run to act on.
- **Do whatever domain work the consuming skill defines.**
- **For each item handled**, call `bob worklog append` once, before moving on
  to the next item, so a run interrupted partway still leaves a complete
  record for every item it did finish.

The entry shape and the reconciliation rules are summarised for reference in
`references/entry-format.md` and `references/reconciliation.md`, but
`bob worklog` is the definition of both — this skill never restates them as
rules a run must carry out by hand.

---

## Tool usage

Every tool call this skill makes is subject to the host system's own
action-authorization gate, the same as any other tool call a session makes.
This skill's runtime surface is narrow and uniform: **`bash`**, to run
`bob worklog list` at the start of a run and `bob worklog append` once per
item handled. It never reads a prior worklog file itself, never creates the
worklog directory or today's file itself, and never looks up the time or the
date itself — `bob worklog` does all of that internally. One allow-rule set,
prefix-anchored on `bob worklog list` and `bob worklog append`, admits the
whole surface.

If one of these `bash` calls is denied by the action-authorization gate,
that is a deployment gap in the admitting allow rule, not a per-item
condition — there is no lower-level record left to write for that run. Treat
it as a run-ending problem for this run.

---

## Location

`bob worklog` resolves the worklog to exactly:

```
<cwd>/worklog/<YYYY-MM-DD>.md
```

`<cwd>` is the working directory the command is invoked in, and nothing
else. There is no search upward through parent directories for an existing
`worklog/`, and no flag, environment variable, or configuration key that
points the command at a different location. A run that needs its own diary
must be invoked in its own working directory: two runs invoked in different
directories never share a worklog, and a run invoked in the wrong directory
gets an error from `bob worklog list` — which never invents a missing
`worklog/` — rather than a silently empty or foreign diary. `<YYYY-MM-DD>`
is the calendar day the run executes in, from the command's own clock.

---

## Recording an entry for each item a run handles

Whatever the outcome of the consuming skill's own domain work on an item —
acted on, escalated, blocked, or any other outcome that skill defines — call
`bob worklog append` once for that item, giving it the item-identifier and
the three fields every entry carries (`Done`, `Left`, `Next`). Do this
before moving on to the next item, so a run interrupted partway still leaves
a complete record for every item it did finish handling. The command creates
`worklog/` and today's file if either is still missing and stamps the entry
with its own clock; the run supplies only the identifier and the three field
values. `references/entry-format.md` describes what those fields mean.

The **item-identifier** is the one part of the entry this skill's convention
governs: a short, human-readable label for the item, chosen by the consuming
skill, that is enough on its own to identify which item an entry is about
when the file is scanned later. The same item keeps the same identifier
every day it stays open, so the command can recognise it across days when it
carries the item forward.

A completed run leaves no item without exactly one worklog entry recording
its outcome — never silently skipped.

---

## How an open item closes

This skill defines no closing conditions of its own: what actually resolves
an open item is domain policy the consuming skill owns entirely (for
example, a specific reply arriving, or a specific block being lifted).
`bob worklog` carries an open item forward, unclosed, day after day, until a
later appended entry for that item-identifier records it as resolved — there
is no automatic expiry. The consuming skill's policy decides when that
resolving entry is written; see `references/reconciliation.md` for how the
carry-forward is presented to each run.
