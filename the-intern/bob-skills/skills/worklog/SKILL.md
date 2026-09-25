---
name: worklog
description: >
  Domain-free diary discipline that gives an independent, possibly-scheduled
  run a way to record what it did on a given day, using nothing but files in
  its own working directory — no service-side session, queue, or other
  external state may be relied on to remember what a previous run did. Says
  WHEN to call `bob worklog append`/`bob worklog list`, and the
  item-identifier convention those calls use; the entry format, file
  location, and duplicate-check logic belong to the `bob worklog` command
  itself, and all domain policy (what counts as an item, when it's
  resolved) belongs to the consuming skill. Load this skill whenever a task
  needs a per-day record of what it did, regardless of what kind of work is
  being tracked.
---

# Worklog

This skill says when a run records its own continuity, and it teaches the
item-identifier convention the entries use. It does not own the entry
format, the location of a day's file, or the same-day duplicate check that
`append` performs before it writes — the `bob worklog` command owns all of
that. A consuming skill decides what an "item" is, how items are found,
what to do with each one, when an open item is genuinely resolved, and
whether it needs to track anything as still outstanding from one day to the
next; this skill only tells that work when to journal so it survives across
independent runs.

Every run that uses this discipline follows the same shape:

- **Do whatever domain work the consuming skill defines.**
- **For each item handled**, call `bob worklog append` once, before moving
  on to the next item, so a run interrupted partway still leaves a complete
  record for every item it did finish.

A day's file holds exactly what was appended to it on that day, nothing
more: `bob worklog` never reads or writes any file for a day other than the
one an invocation names, whether the invocation is `append` or `list`. If a
run needs to know what a previous day recorded — or what today's file
already holds — it asks for that explicitly by calling `bob worklog list`
(today's file by default, or an earlier day named explicitly with `--date
<YYYY-MM-DD>`). That read never happens on a run's behalf: this skill does
not call `list` for a run, and `append` itself only ever looks at today's
file, to check whether the entry it is about to write would be an exact
repeat of that item's most recent entry so far today.

The entry shape and the same-day duplicate-suppression check are each
summarised for reference under `references/` — see `entry-format.md` for
the entry shape, and the file beside it for the duplicate check — but `bob
worklog` is the definition of both; this skill never restates them as rules
a run must carry out by hand.

---

## Tool usage

Every tool call this skill makes is subject to the host system's own
action-authorization gate, the same as any other tool call a session makes.
This skill's runtime surface is narrow and uniform: **`bash`**, to run
`bob worklog append` once per item handled, and `bob worklog list` whenever
a run explicitly needs to read a day's entries back. It never reads a
worklog file itself, never creates the worklog directory or a day's file
itself, and never looks up the time or the date itself — `bob worklog` does
all of that internally. One allow-rule set, prefix-anchored on
`bob worklog list` and `bob worklog append`, admits the whole surface.

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
`bob worklog append` once for that item, passing `--item <item-identifier>`
and `--done <...>`. Do this before moving on to the next item, so a run
interrupted partway still leaves a complete record for every item it did
finish handling. The command creates `worklog/` and today's file if either
is still missing, checks whether the entry would be an exact repeat of that
item-identifier's most recent entry already in today's file, and — when it
is not — stamps the entry with its own clock and writes it; the run
supplies only the identifier and the `Done` value, and can tell from the
response whether the call wrote a new entry or found today's file already
recording the same thing. `references/entry-format.md` describes what that
field means.

The **item-identifier** is the one part of the entry this skill's convention
governs: a short, human-readable label for the item, chosen by the consuming
skill, that is enough on its own to identify which item an entry is about
when the file is scanned later. Distinct items must get distinct
identifiers, and the same item keeps the same identifier every time it
recurs, the same day or on a later one: that consistency is what lets the
same-day check recognise a repeat, and what lets a run that later reads back
an earlier day with `list --date` tell which entries belong to which item,
without conflating two different items that happen to share a label.

A completed run leaves no item without exactly one worklog entry recording
its outcome — never silently skipped, and never silently suppressed unless
it is truly identical to what the item's most recent entry already says.

---

## Tracking whether an item is still open

This skill defines no closing conditions of its own: what actually resolves
an open item is domain policy the consuming skill owns entirely (for
example, a specific reply arriving, or a specific block being lifted).
`bob worklog` takes no part in that decision — it never classifies an entry
as open or closed, never tracks an item's status from one day to the next,
and never writes anything into today's file that a run did not explicitly
append itself today. Whether an item raised on an earlier day still needs
attention is a question the consuming skill answers with whatever record it
keeps for that purpose; if it needs to see what an earlier day's worklog
said about an item, it reads that day explicitly with `bob worklog list
--date <YYYY-MM-DD>` — the worklog is a record of what a run did, not a
tracker that resurfaces unfinished work on the consuming skill's behalf.
