# Manager Escalation

## Configuration

The escalation address is skill-local configuration, not bob's TOML config
(S-010 Configuration Requirements; ADR-008 §5 — actions use their own
configuration), read from:

```
<workspace>/config/email-triage.toml
```

`<workspace>` is the job's own working directory (the scheduled entry's
per-entry `--cwd`) — the same directory the daily worklog lives in.

This file requires exactly one key:

```toml
manager_address = "someone@example.com"
```

- `manager_address` (required) — a single well-formed email address that
  receives every escalation this skill sends.

This repository ships only the documented template,
`config/email-triage.example.toml`, with no real address filled in. The real
`config/email-triage.toml` exists only in the owner-only deployed workspace
copy of this package (`../../../../README.md`'s "This package is the
repository source of truth only") — it is never committed, and provisioning
the real address is out of scope for this reference (S-010 Exclusions).

## When to escalate

Escalate a message when its classification is not confident — whichever
category taxonomy is in use, "not confident" means no category workflow
matches the message with enough certainty to act on it unattended (S-010
Design Principles: autonomy is gated on classification confidence for the
specific message, not on the action's reversibility or a static allowlist).

Escalating a message means: send exactly one escalation email to
`manager_address`, then take no further action on that message in that run.
Do not also act per some category workflow "just in case" — escalation and
autonomous action are mutually exclusive outcomes for a given message on a
given run.

The escalation email must describe:

- **What the message is** — enough of the original message (sender,
  subject, and a summary or the relevant excerpt) that the manager can
  understand it without needing to open the mailbox themselves.
- **Why it's uncertain** — the specific reason classification did not reach
  confidence (e.g. which categories were considered and why none matched
  cleanly).
- **The question being asked** — a concrete question the manager's reply is
  expected to answer, not just "please advise."

Sending the escalation email is a `himalaya` `bash` call like any other this
package makes, so it is gated by S-004's action gate exactly the same way —
see "If the escalation send is blocked" below.

## If the escalation send is blocked (S-004)

Every `bash` call this package makes — including the escalation send — is
gated by bob's existing S-004 default-deny action gate; an admitting allow
rule is a deployment prerequisite, not something this reference or spec
grants (S-010 Design Principles: "every action this package takes remains
subject to S-004").

If S-004 blocks the escalation send:

- record the block as an open item in the day's worklog entry for that
  message (`references/worklog.md` defines the entry format and how a
  worklog-tracked open item closes — refer to it, do not restate it here);
- do **not** fall back to acting on the message autonomously because the
  escalation didn't go through. A blocked escalation is a hard stop for that
  message, not a license to proceed some other way.
