# `automated-notification` Workflow

What a confident `automated-notification` match does, once `references/categories/README.md`'s
matching signals and confidence rubric have already decided this message belongs to this
category — this file does not re-derive that decision, only what happens once it's made.

## File the message, do not reply

File the message the same way `references/categories/newsletter-bulk.md` files a
`newsletter-bulk` match: move it out of `INBOX` into a `Notifications` folder, using the
`himalaya` skill's move operation (Operation Index → "Move a message"). This file does not
restate that operation's command shape or flags — see the `himalaya` skill for the exact
syntax. `Notifications` is a starter default, the same kind of adjustable-sketch starting
point `references/categories/README.md` describes for the taxonomy itself.

**Namespaced-account pitfall (Observed).** A bare folder name fails outright on any
account whose folders live under a namespace prefix (for example `INBOX.`) rather than
sitting at the top level:

```text
$ himalaya message move Notifications 211
unexpected NO response: Client tried to access nonexistent namespace. (Mailbox name should probably be prefixed with: INBOX.)
```

Resolve the real folder name first — `himalaya folder list` (`himalaya` skill, Moving and
Copying) — rather than assuming the bare default works. For the account used when this
pitfall was observed, the real folder turned out to be `INBOX.Notifications`; that is this
account's own folder layout, not a general default — a different account may need a
different prefix, or none at all.

Do not compose, generate, or send a reply, and do not forward the message. An automated
notification states a fact or a status — it does not ask a question this skill answers.

## Flagging a failure that needs attention

Some automated notifications report a fact worth a human's attention rather than a routine
confirmation — a failed build, a declined payment, a service alert reporting an outage or
error, as opposed to a routine receipt or shipping confirmation. When the notification
being filed reports this kind of failure, record that in the worklog entry (below) so a
human reviewing the day's worklog notices it — this skill does not itself investigate or
act on the failure; that stays out of this skill's per-category business logic.

This is a note for the operator's own attention, not an open item under
`references/worklog.md`'s worklog/task-board model: unlike that model's two defined
open-item causes — an escalation awaiting a manager's reply, or an action the
action-authorization gate blocked — no `bob task` is filed for it, so nothing tracks it as
outstanding once this entry is appended. The message itself is still fully handled by filing
it — the flag exists only so the failure does not go unnoticed once the message leaves
`INBOX`.

## Worklog entry

Append one entry with `bob worklog append` (see `references/worklog.md`). For a routine
notification, record the filing as fully handled: nothing is left outstanding and nothing
further happens for this message. For a notification that reports a failure needing
attention (previous section), name that failure in the entry as the reason for a follow-up,
distinct from the entry's own "nothing left" filing outcome.

## If the move is blocked

If the move is blocked, follow the block-handling rule `references/escalation.md` already
establishes: file a `blocked` `bob task` for it and do not treat the message as handled. Do
not substitute some other action — a blocked filing is a hard stop for this message, not a
reason to try replying, forwarding, or anything else instead.
