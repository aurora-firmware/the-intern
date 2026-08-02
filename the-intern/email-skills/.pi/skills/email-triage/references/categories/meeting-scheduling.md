# `meeting-scheduling` Workflow

What a confident `meeting-scheduling` match does, once `references/categories/README.md`'s
matching signals and confidence rubric have already decided this message belongs to this
category — this file does not re-derive that decision, only what happens once it's made.

Like `direct-request`, and unlike the file-without-reply categories, a confident
`meeting-scheduling` match gets a reply: this is one of the two starter categories where
S-010's read-and-act scope means composing and sending real mail back to the sender.

## What this workflow can and cannot decide

This package has no calendar, no owner-availability source, and no scheduling tool of any
kind — the `himalaya` skill's Operation Index covers mailbox operations only, nothing that
reads or reasons about a calendar. That is a hard limit on what "proposing or confirming a
time" can mean here: this workflow can act on a message's own stated time without inventing
or judging anything about the owner's availability, but it can never decide whether a time
works for the owner, because there is nothing in this package that could tell it. Which of
the two sections below applies depends on which the message is actually asking for.

Some messages sit ambiguously between the two — for example one that states a time but
frames it as contingent on the owner's silence ("I'll pencil in Thursday at 3pm — let me
know if that's a problem"): it states a time (surface shape of the first section below) but
functionally asks the owner to decide whether to object (substance of the second). When a
message does not clearly and unambiguously fall into one section or the other, treat it as
needing the owner's decision: follow the second section below and escalate rather than
replying. This is the same conservative default `references/categories/README.md`'s
confidence rubric already states for classification itself — when in doubt between acting
and escalating, escalate — applied here to the choice between this workflow's two branches.

## Confirm or acknowledge a stated time, and reply

Some `meeting-scheduling` messages don't ask the owner to decide anything: the sender states
or confirms a specific date/time and the message only needs acknowledging — a meeting or
call being confirmed as already arranged, a reschedule or cancellation the sender is simply
reporting, or a request to confirm the message itself was received. None of these require
knowing the owner's availability; they only require restating back what the message already
said.

For these, draft a reply using the `himalaya` skill's reply operation (Operation Index →
"Reply to a message"), then send it. This file does not restate that operation's command
shape or flags — see the `himalaya` skill for the exact syntax. The reply must reference the
specific date/time or change the message already stated and acknowledge it — never introduce
a time value that wasn't already in the message, and never assert that the owner is
available or unavailable for it.

## If the request needs the owner's availability

Some `meeting-scheduling` messages do ask the owner to decide something that depends on
availability: choosing among proposed times, stating free/busy times, or confirming or
declining attendance at a proposed time where confirming means committing the owner's
calendar. This is exactly the confidence-gate case that applies inside an already-confident
classification: acting would require information — the owner's availability — that this run
has no way to determine, and only the owner can supply it. Do not guess, do not pick a time
on the owner's behalf, and do not fabricate an answer. Escalate the message per
`references/escalation.md` instead, exactly as that reference already defines: this file
does not restate its email content, blocked-send handling, or missing-`manager_address`
handling.

## Worklog entry

Append one entry to today's worklog file in the format `references/worklog.md` defines
(creating `worklog/` and today's file first if either is missing, per that reference; this
file does not restate the entry format itself). When a reply was sent (previous section),
name it — enough of its content that a human reading the worklog knows what was
acknowledged or confirmed — and record the message as fully handled: nothing is left
outstanding and nothing further happens for this message. A later message from the same
sender proposing or confirming a new time is a new unseen message that re-enters triage on
its own, on some later run, the same way an escalation's reply does — not something this
entry stays open waiting for. When the message was escalated instead, this workflow adds
nothing to `references/escalation.md`'s and `references/worklog.md`'s already-defined
open-item handling.

## If the reply is blocked (S-004)

If drafting or sending the reply is blocked, follow the block-handling rule
`references/escalation.md` already establishes: record the block as an open worklog item
and do not treat the message as handled. Do not substitute some other action — a blocked
reply is a hard stop for this message, not a reason to escalate instead or do anything else
in its place.
