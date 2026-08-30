# `self-escalation` Workflow

What a confident `self-escalation` match does, once `references/categories/README.md`'s
matching signals and confidence rubric have already decided this message belongs to this
category — this file does not re-derive that decision, only what happens once it's made.

## File the message, do not reply

File the message by moving it out of `INBOX` into an `Escalations` folder, using the
`himalaya` skill's move operation (Operation Index → "Move a message"). This file does not
restate that operation's command shape or flags — see the `himalaya` skill for the exact
syntax. `Escalations` is a starter default, the same kind of adjustable-sketch starting
point `references/categories/README.md` describes for the taxonomy itself; rename it to
match the deployed account's own folder layout if needed.

Do not compose, generate, or send a reply, and do not forward the message. A
`self-escalation` match is this skill's own earlier output arriving back as unseen mail,
not a message from another sender asking something — there is nothing here to answer.

## Never escalate this message

This category is terminal: filing the message is the entire response, and escalating it is
never the right outcome, however the confident match above was reached. A confident
`self-escalation` match is this skill's own escalation mail, sent by
`references/escalation.md`'s missing-configuration fallback and addressed to the mail
account's own address because `manager_address` was missing or malformed when the original
message was classified. That mail lands back in the same mailbox as ordinary unseen mail and
re-enters triage on a later run — which is exactly what puts it in front of this
classification step at all.

Escalating a `self-escalation` match would send another self-addressed escalation email,
which would itself arrive back as unseen mail and match this same category again on some
later run — an escalation that never terminates. Filing the message, and only filing it, is
what breaks that cycle. Do not send an escalation for a `self-escalation` match under any
circumstance, including when the filing itself is blocked (see "If the move is blocked"
below).

## Worklog entry

Append one entry with `bob worklog append` (see `references/worklog.md`). Record the filing
as fully handled: nothing is left outstanding and nothing further happens for this message.

## If the move is blocked

If the move is blocked by the action-authorization gate, follow the block-handling rule
`references/escalation.md` already establishes: record the block as an open worklog item and
do not treat the message as handled. Do not substitute some other action — in particular, a
blocked filing is never a reason to send an escalation for this message instead; escalating
a `self-escalation` match is exactly the outcome this category exists to prevent.
