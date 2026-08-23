# `newsletter-bulk` Workflow

What a confident `newsletter-bulk` match does, once `references/categories/README.md`'s
matching signals and confidence rubric have already decided this message belongs to this
category — this file does not re-derive that decision, only what happens once it's made.

## File the message, do not reply

File the message by moving it out of `INBOX` into a `Newsletters` folder, using the
`himalaya` skill's move operation (Operation Index → "Move a message"). This file does not
restate that operation's command shape or flags — see the `himalaya` skill for the exact
syntax. `Newsletters` is a starter default, the same kind of adjustable-sketch starting
point `references/categories/README.md` describes for the taxonomy itself; rename it to
match the deployed account's own folder layout if needed.

Do not compose, generate, or send a reply, and do not forward the message. A confident
`newsletter-bulk` match is filed, never answered — recurring bulk sends do not get a
response from this skill.

## Worklog entry

Append one entry to today's worklog file in the format `references/worklog.md` defines
(creating `worklog/` and today's file first if either is missing, per that reference; this
file does not restate the entry format itself). Record the filing as fully handled:
nothing is left outstanding and nothing further happens for this message.

## If the move is blocked

If the move is blocked, follow the block-handling rule `references/escalation.md` already
establishes: record the block as an open worklog item and do not treat the message as
handled. Do not substitute some other action — a blocked filing is a hard stop for this
message, not a reason to try replying, forwarding, or anything else instead.
