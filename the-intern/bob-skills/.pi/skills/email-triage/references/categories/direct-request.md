# `direct-request` Workflow

What a confident `direct-request` match does, once `references/categories/README.md`'s
matching signals and confidence rubric have already decided this message belongs to this
category — this file does not re-derive that decision, only what happens once it's made.

Unlike the file-without-reply categories, a confident `direct-request` match gets a reply:
the sender asked a specific, answerable question or made a specific ask, and this is one of
the two starter categories (with `meeting-scheduling`) where this skill's read-and-act
scope means composing and sending real mail back to the sender, not just filing the
message.

## Draft and send a reply

Draft a reply using the `himalaya` skill's reply operation (Operation Index → "Reply to a
message"), then send it. This file does not restate that operation's command shape or
flags — see the `himalaya` skill for the exact syntax.

The reply must directly answer the concrete question or request the message made, using
only information the run actually has: the message itself, and anything already known
without needing to invent or guess at a detail the run cannot verify. Do not pad the reply
with anything beyond what answers the ask, and do not leave the ask unaddressed.

## If the answer needs information this run doesn't have

A confident `direct-request` classification is a judgment about which category the message
matches, not a guarantee that this run can actually answer it. If answering the request
would require information the run does not have access to — a fact only the owner knows, a
decision only the owner can make, anything not contained in the message or otherwise
available to the run — do not guess or fabricate an answer. Escalate the message per
`references/escalation.md` instead, exactly as that reference already defines: this file
does not restate its email content, blocked-send handling, or missing-`manager_address`
handling.

## Worklog entry

Append one entry with `bob worklog append` (see `references/worklog.md`). Name the reply
that was sent — enough of its content (the question answered, the gist of the answer) that a
human reading the worklog knows what was told to the sender without re-opening the mailbox.
Record the message as fully handled: nothing is left outstanding and nothing further happens
for this message, the same "fully handled" outcome the file-without-reply categories record,
just reached by replying instead of filing.

## If the reply is blocked

If drafting or sending the reply is blocked, follow the block-handling rule
`references/escalation.md` already establishes: record the block as an open worklog item
and do not treat the message as handled. Do not substitute some other action — a blocked
reply is a hard stop for this message, not a reason to file it, forward it, or do anything
else instead.
