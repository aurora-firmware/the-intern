# Worklog Same-Day Duplicate Suppression

## The only thing `append` does automatically

`bob worklog append` performs exactly one automatic check before it writes:
it compares the incoming entry's `Done`, `Left`, and `Next` values against
that item-identifier's most recent entry already in today's file. If all
three match exactly, nothing is written — the entry already there records
that state, so a second, identical copy would add nothing. If any one of
the three differs, or today's file has no entry yet for that
item-identifier, the incoming entry is appended as a new entry, however
similar it is to an earlier one and however late in the day it arrives.
This is the only automatic behaviour `append` performs; nothing else about
the call happens without the run explicitly asking for it.

## Scoped to today's file, and nothing else

The comparison above reads only the file being appended to — today's file,
in the working directory the command was invoked in — and never any other
day's file. `append` never opens yesterday's file, or any other prior day's
file, to decide what to write today. `bob worklog list` behaves the same
way: it reads back exactly the one day's file an invocation names (today's
by default, or an earlier day named explicitly with `--date
<YYYY-MM-DD>`) and nothing else, and performs no write of any kind. Neither
subcommand ever touches a file for a day other than the one the invocation
names. That means today's file holds exactly what was explicitly appended
to it today — never an entry copied in from an earlier day, and never an
entry a caller did not itself ask to write.

## Calling the same append twice the same day is safe

Because the check above compares against what is already in today's file,
calling `append` again later the same day, with the same item-identifier
and the same `Done`/`Left`/`Next` values, finds the entry already present
and writes nothing a second time. A caller that is unsure whether an
earlier call already recorded a given outcome can simply call `append`
again with the same values rather than checking first — the check runs
before every `append`, on every call, with nothing to remember to do first.

## Only the most recent entry for an item is consulted

If today's file already holds more than one entry for the same
item-identifier, the incoming entry is compared only against the
chronologically last one — an earlier entry from earlier today that happens
to match is not consulted. A differing `Done`, `Left`, or `Next` — even if
only one of the three changed since the item's last entry — is written as
its own new entry.

## What is not automatic

Nothing beyond the check described above happens on a run's behalf. If a
run needs to know what an earlier day's file recorded, it must ask for that
day explicitly, with `bob worklog list --date <YYYY-MM-DD>` — that read
never happens by itself, and reading a day this way never writes anything
back into it or into today's file. `bob worklog` does not classify any
entry as open or closed, does not track an item's status across days, and
does not decide anything on a run's behalf beyond the one same-day check
described above. Whether an item raised on an earlier day still needs
attention is a question the consuming skill answers for itself, using
whatever record it keeps for that purpose.
