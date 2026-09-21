# Worklog — Email-Triage Specifics

This skill delegates the diary mechanics — where the worklog lives, how
today's file is created, and the per-item entry format — to the
`bob worklog` command, with the canonical `worklog` skill for when a run
journals and reads that day's entries back. `bob worklog append` writes
exactly the entry it is given into today's file, stamped with the current
time, and suppresses only an exact-match repeat of that item-identifier's
most recent entry already in today's file; it never reads or writes any
other day's file, and it never decides on its own whether an item is still
outstanding. Load the `worklog` skill for those mechanics; do not
re-derive or restate them here. This file covers only what is specific to
email triage: the item-identifier convention, and how this skill uses
`bob task` (the `tasks` skill) to track anything a run could not finish.

## Item identifier

Each worklog entry's `<item-identifier>` (per the `worklog` skill's entry
format) is this message's `<subject> (from <sender>)`, plus a
discriminator derived from that message's `Message-ID` header — fetch it
with `himalaya message read -H Message-ID <id>` and carry it alongside the
human-readable label. The `<subject> (from <sender>)` label alone is not
unique: two different messages can share the same subject and sender, and
without the `Message-ID` discriminator their entries would collide under
the `worklog` skill's own same-day duplicate-suppression check, silently
dropping one message's entry. With the discriminator, two distinct
messages never share an item-identifier, and one message's
item-identifier — subject, sender, and `Message-ID` together — stays the
same every time that message is referenced, the same day or on a later
one. Use the same full identifier, discriminator included, when naming
the message inside a `bob task` filed for it, so a reader can tell at a
glance which board entry and which diary entries describe the same
message.

The identifier is built from sender-controlled values, so it must never be
typed as a literal quoted argument in the `bob worklog append --item` or
`bob task new` call that carries it — load it into a shell variable first,
per `references/escalation.md`'s "Message content requirement" shell-safety
discipline.

## Open items live on the task board, never in mailbox flag state or in the worklog

Classifying a message requires reading it, and reading a message sets its
`\Seen` flag as a side effect regardless of what the classification decides
to do — acting, escalating, or hitting a block from the action-authorization
gate all mark the message `Seen` the same way. That means the mailbox itself
cannot be used to tell "still needs attention" apart from "fully handled":
once read, a message never reappears as unseen on a later tick no matter how
the run left it.

The worklog cannot fill that role either: `bob worklog` records only what a
run explicitly appended on the day it ran, and never carries anything into
another day's file. Because of this, an escalated or blocked message is
tracked as an open item exclusively through a `bob task` filed for it —
status `blocked` for an action the action-authorization gate refused,
`todo` for an escalation still awaiting a manager's reply (see `SKILL.md`
step 3). Never infer that a message still needs attention from its
`Seen`/unseen state, and never rely on toggling `Seen` back off as a way to
mark something open; the filed task is the sole record of what is still
outstanding, and the worklog is the record of what each run did about it.

That applies equally to a blocked escalation send. Once the message has been
read, it may already be `Seen`, but the open blocked-escalation item still
lives only in the `bob task` filed for it. That task must not be closed, and
the message's worklog entry must not be rewritten, as if the intended
escalation had actually gone out.

## How an open item closes, for email triage

Neither the `worklog` skill nor `bob worklog` owns any closing condition of
its own, and `bob task` does not decide on a run's behalf when an item it
holds is resolved — a consuming skill supplies that domain judgment and
moves the task itself. For email triage, an open item has exactly two
causes, and each closes differently:

- **Escalation (`todo`).** Closes when the manager's reply arrives — see
  `references/escalation.md`'s "No synchronous reply is expected" section.
  It arrives as ordinary unseen mail and re-enters triage like any other
  message on some later run (`SKILL.md` step 2); handling it (`SKILL.md`
  step 3) is what resolves the item.
- **Blocked by the action-authorization gate (`blocked`).** Closes once an
  admitting allow rule is added to bob's action ruleset and the retried
  action succeeds. `SKILL.md` step 1 is the point at which a still-blocked
  action is retried on every run.

Either way, the run that resolves the item moves its task to `done` via
`bob task status` and names that task's identifier in the worklog entry it
writes for the message that closed it (`SKILL.md` step 1 for a successful
retry, step 4 for a manager's reply) — the worklog records that the item
closed and how; the task board is what stopped tracking it as outstanding.
For the escalation case, that closing entry is filed under the reply
message's own item-identifier, not the originally escalated message's:
the reply is a distinct message with its own `Message-ID` discriminator
(see "Item identifier" above), so the two never share an identifier even
when their subjects and senders look alike. A retry that is still
refused, or an escalation still unanswered, leaves its task open, to be
listed and retried again the next time `SKILL.md` step 1 runs. There is
no automatic expiry: an item stays open only for as long as its task
does.
