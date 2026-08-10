# Worklog — Email-Triage Specifics

This skill delegates the diary mechanics — where the worklog lives, how to
create it, the per-item entry format, how to tell whether a run is the
day's first executed run, and how first-run reconciliation carries forward
open items — to the canonical `worklog` skill. Load that skill's
`references/entry-format.md` and `references/reconciliation.md` for those
mechanics; do not re-derive or restate them here. This file covers only
what is specific to email triage.

## Item identifier

Each worklog entry's `<item-identifier>` (per the `worklog` skill's entry
format) is this message's `<subject> (from <sender>)`.

## Open items live in the worklog only, never in mailbox flag state

Classifying a message requires reading it, and reading a message sets its
`\Seen` flag as a side effect regardless of what the classification decides
to do — acting, escalating, or hitting a block from the action-authorization
gate all mark the message `Seen` the same way. That means the mailbox itself
cannot be used to tell "still needs attention" apart from "fully handled":
once read, a message never reappears as unseen on a later tick no matter how
the run left it.

Because of this, an escalated or blocked message is carried forward as an
open item through the worklog **only** — its `Left` field staying anything
other than "nothing" is what marks it open. Never infer that a message
still needs attention from its `Seen`/unseen state, and never rely on
toggling `Seen` back off as a way to mark something open; the worklog entry
is the sole record.

That applies equally to a blocked escalation send. Once the message has been
read, it may already be `Seen`, but the open blocked-escalation item still
lives only in the worklog entry. The entry must not be rewritten as a
successful escalation just because the intended action was to escalate.

## How an open item closes, for email triage

The `worklog` skill owns no closing conditions of its own — only the
carry-forward mechanics (see its `references/reconciliation.md` "How an
open item closes" section). For email triage, an open item has exactly two
causes, and each closes differently:

- **Escalation.** Closes when the manager's reply arrives — see
  `references/escalation.md`'s "No synchronous reply is expected" section.
  It arrives as ordinary unseen mail and re-enters triage like any other
  message; nothing about the original entry auto-resolves it.
- **Denied by the action-authorization gate.** Closes once an admitting
  allow rule is added to bob's action ruleset. This skill's own loop step 1
  is the point at which a carried-forward blocked action is retried.

There is no automatic expiry. An item stays open, carried forward day after
day by the `worklog` skill's reconciliation mechanics, until whichever
condition above genuinely closes it.
