# Worklog Entry Format

This is a reference description of what a worklog entry looks like. It is
**not** the definition, and it is not a recipe to run by hand. The
`bob worklog` command writes every entry, and that command is the sole
definition of the format. What follows is here only so a reader can
recognise an entry when scanning a file directly; if this description ever
disagrees with what `bob worklog` actually writes, the command is right.

A run never creates the worklog directory, never creates the day's file,
and never composes an entry with a shell redirect. For each item it
handles, it calls:

```
bob worklog append --item <item-identifier> --done <...> --left <...> --next <...>
```

and the command creates whatever is missing, stamps the entry with the real
local time from its own clock, and appends it. Run `bob worklog append
--help` for the exact, current flag syntax rather than trusting this page to
have kept up with it.

## What an entry looks like

Each entry `bob worklog append` writes is a header line, a blank line, then
three bullets:

```
## <HH:MM> — <item-identifier>

- Done: <what was done for this item this run>
- Left: <what is still outstanding, or "nothing" if fully resolved>
- Next: <what happens next, and on what trigger>
```

- **`<HH:MM>`** — the local time the entry was recorded, supplied by the
  command from its own clock. A run never types this value and never
  estimates it.
- **`<item-identifier>`** — the short, human-readable label the calling run
  passes for the item. It should be enough on its own to identify which
  item the entry describes when the file is scanned later, and it stays the
  same every time the item recurs, the same day or on a later one, so the
  same-day duplicate check can recognise a repeat and a reader can tell
  which entries belong to the same item.
- **Done** — the concrete action taken this run: whatever outcome the
  consuming skill's own domain workflow reached, including an action that
  was attempted and blocked by the action-authorization gate. When the
  blocked call was itself the action that would have closed the item,
  `Done` must say that attempt was blocked — not that the closing action
  succeeded.
- **Left** — what remains open, if anything, at the time this entry was
  written. "Nothing" for a fully-handled item; otherwise a short description
  of the open condition (for example, "awaiting a reply", or "blocked by
  the action-authorization gate — no admitting allow rule"). `bob worklog`
  does not act on this value itself — it does not classify the item as open
  or closed and does not track it across entries or across days; a
  consuming skill that needs to know whether an item is still outstanding
  keeps that record itself.
- **Next** — what will resolve the item and how it will be noticed (for
  example, "closes when the expected reply arrives", or "closes once an
  allow rule admits this call").
