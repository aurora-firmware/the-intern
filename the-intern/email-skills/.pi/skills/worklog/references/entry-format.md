# Worklog Entry Format

The worklog is the diary that gives independent runs continuity. It lives
entirely in the run's own working directory — no external session, queue,
or other service-side state may be relied on to remember what happened on a
previous run.

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
NOW=$(date +%H:%M)
TODAY=$(date +%F)
mkdir -p worklog
cat >> worklog/$TODAY.md <<'EOF'
## $NOW — <item-identifier>

- Done: <what was done for this item this run>
- Left: <what is still outstanding, or "nothing" if fully resolved>
- Next: <what happens next, and on what trigger>

EOF
```

Keep the redirect target exactly `worklog/$TODAY.md`: cwd-relative and
unquoted immediately after `>>`. A deployed action-authorization rule for
this append step may match the literal substring `>> worklog/`, so
rewriting the redirect as `>> "worklog/$TODAY.md"` or as an absolute
workspace path changes the command text enough to miss such a rule even
though the append is otherwise legitimate. This unquoted form is still safe
here because `TODAY` comes from `date +%F`, which yields only the calendar
date characters used in the worklog filename. `NOW` must come from this
same kind of `date` lookup (`date +%H:%M`) — never a guessed, estimated, or
placeholder value — for the same reason `TODAY` does: it is the only source
of the actual current time available to the run.

Keep the heredoc delimiter quoted (`<<'EOF'`): the body typically contains
text derived from whatever the item itself is — content the consuming
skill does not fully control — so quoting the delimiter keeps any `$()`,
backticks, backslashes, or variable references in that text inert rather
than allowing the shell to expand them. Because the delimiter is quoted,
the shell will **not** expand `$NOW` inside the heredoc body — it stays
literal `$NOW` text if left as shown. `$NOW` in the header line above marks
where the just-computed time value belongs: before running the command,
replace `$NOW` with the literal `HH:MM` result of the `NOW=$(date +%H:%M)`
lookup shown above it, the same way `<item-identifier>` and the `Done`/
`Left`/`Next` text get replaced with their real values before the command
runs. Never run the command with the literal text `$NOW` still in place,
and never substitute a guessed or estimated time in its place — the
substituted value must be the result of that `date` lookup.

## Per-item entry format

Append one entry to today's file for every item a run handles — whatever
the outcome. Each entry records exactly three things about that item:

```
## <HH:MM> — <item-identifier>

- Done: <what was done for this item this run>
- Left: <what is still outstanding, or "nothing" if fully resolved>
- Next: <what happens next, and on what trigger>
```

- **`<item-identifier>`** — a short, human-readable label for the item this
  entry is about. The consuming skill chooses this label; it should be
  enough on its own to identify which item the entry describes when
  scanning the file later.
- **Done** — the concrete action taken this run: whatever outcome the
  consuming skill's own domain workflow reached, including an action that
  was attempted and blocked by the action-authorization gate. When the
  blocked call was itself the action that would have closed the item, `Done`
  must say that attempt was blocked — not that the closing action succeeded.
- **Left** — what remains open, if anything. "Nothing" for a fully-handled
  item; otherwise a short description of the open condition (for example,
  "awaiting a reply", or "blocked by the action-authorization gate — no
  admitting allow rule").
- **Next** — what will resolve the item and how it will be noticed (for
  example, "closes when the expected reply arrives", or "closes once an
  allow rule admits this call — re-check at the next first-run
  reconciliation").
