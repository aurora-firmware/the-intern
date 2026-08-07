# `suspected-spam` Workflow

What a confident `suspected-spam` match does, once `references/categories/README.md`'s
matching signals and confidence rubric have already decided this message belongs to this
category — this file does not re-derive that decision, only what happens once it's made.

## File the message, non-destructively

File the message by moving it out of `INBOX` into a `Spam` folder, using the `himalaya`
skill's move operation (Operation Index → "Move a message"), never its delete operation.
This file does not restate that operation's command shape or flags — see the `himalaya`
skill for the exact syntax. `Spam` is a starter default, the same kind of adjustable-sketch
starting point `references/categories/README.md` describes for the taxonomy itself; rename
it to match the deployed account's own folder layout if needed, or point it at an existing
account-provided junk folder.

Moving, not deleting, keeps this workflow non-destructive by default: the message stays
recoverable in the `Spam` folder for the operator to review or purge later at their own
discretion, rather than this skill silently removing something a low-confidence-adjacent
classification got wrong. A starter taxonomy sketch is not the place an operator should
inherit a destructive default from.

## Do not engage with the message

A confident `suspected-spam` match gets no other interaction:

- Do not reply to the sender.
- Do not forward the message.
- Do not follow, open, or otherwise act on any link or attachment the message contains.

These are exactly the behaviors suspected-spam mail is designed to elicit
(`references/categories/README.md`'s signals: urgency/threat language, unsolicited pitches,
a link or attachment with no established context) — filing the message is the entire
response.

## Worklog entry

Append one entry to today's worklog file in the format `references/worklog.md` defines
(creating `worklog/` and today's file first if either is missing, per that reference; this
file does not restate the entry format itself). Record the filing as fully handled: nothing
is left outstanding and nothing further happens for this message.

## If the move is blocked

If the move is blocked, follow the block-handling rule `references/escalation.md` already
establishes: record the block as an open worklog item and do not treat the message as
handled. Do not substitute some other action — in particular, a blocked filing is never a
reason to reply, follow a link, or otherwise engage with the message instead.
