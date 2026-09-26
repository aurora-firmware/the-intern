# `newsletter-bulk` Workflow

What a confident `newsletter-bulk` match does, once `references/categories/README.md`'s
matching signals and confidence rubric have already decided this message belongs to this
category — this file does not re-derive that decision, only what happens once it's made.

## File the message, do not reply

File the message by moving it out of `INBOX` into a `Newsletters` folder, using the
`himalaya` skill's move operation (Operation Index → "Move a message"). This file does not
restate that operation's command shape or flags — see the `himalaya` skill for the exact
syntax. `Newsletters` is a starter default, the same kind of adjustable-sketch starting
point `references/categories/README.md` describes for the taxonomy itself.

**Namespaced-account pitfall (Observed).** A bare folder name fails outright on any
account whose folders live under a namespace prefix (for example `INBOX.`) rather than
sitting at the top level, the same way `automated-notification.md`'s own pitfall note
describes:

```text
$ himalaya message move Newsletters 225
unexpected NO response: Client tried to access nonexistent namespace. (Mailbox name should probably be prefixed with: INBOX.)
```

Resolve the real folder name first — `himalaya folder list` (`himalaya` skill, Moving and
Copying) — rather than assuming the bare default works. No verified namespaced
replacement for `Newsletters` has been confirmed on any account hit by this yet; if the
resolved name still doesn't work either, treat the move as blocked (below) rather than
guessing at another name.

Do not compose, generate, or send a reply, and do not forward the message. A confident
`newsletter-bulk` match is filed, never answered — recurring bulk sends do not get a
response from this skill.

## Worklog entry

Append one entry with `bob worklog append` (see `references/worklog.md`). Record the filing
as fully handled: nothing is left outstanding and nothing further happens for this message.

## If the move is blocked

If the move is blocked, follow the block-handling rule `references/escalation.md` already
establishes: file a `blocked` `bob task` for it and do not treat the message as handled. Do
not substitute some other action — a blocked filing is a hard stop for this message, not a
reason to try replying, forwarding, or anything else instead.
