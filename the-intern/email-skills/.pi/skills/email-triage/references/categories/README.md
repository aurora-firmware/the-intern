# Category Taxonomy

This is the taxonomy index `email-triage`'s per-message classification step
(`SKILL.md` step 3.1) consults: the starter category names, the signals that
indicate a match for each, and the confidence rubric that decides between
acting autonomously and escalating. Per-category *action* detail — the
concrete himalaya steps a confident match triggers — lives in each
category's own workflow file at `references/categories/<category>.md`, not
here; this file is the index that routes to those workflow files, not a
restatement of them.

This taxonomy is an initial, adjustable sketch, not committed final policy
for every kind of email a user might receive — exhaustive per-category
business logic is deliberately out of scope. Expect the category list,
signals, and rubric below to be revised as real mail is triaged against
them.

## Starter categories and their matching signals

Five starter categories exist. Each entry below lists the signals that
indicate a message matches that category — the concrete, observable
properties of the message (sender, subject, headers, body shape) to check
for, not a restatement of what to *do* once matched (that belongs to the
category's own workflow file).

### `newsletter-bulk`

Recurring bulk mail sent to many recipients at once — digests, roundups,
marketing sends — rather than addressed to the recipient individually.

Signals:
- A `List-Unsubscribe` header, or an "unsubscribe" link/footer in the body.
- Sender address uses a broadcast-style local part (`news@`, `newsletter@`,
  `updates@`, `noreply@`) rather than a named individual.
- Subject reads as a recurring send ("weekly digest", "roundup", "this
  week in …", an edition or issue number).
- The message is not addressed to the recipient personally — no greeting
  naming them, or the `To`/`Cc` shape suggests a mailing list rather than a
  1:1 or small-group send.

### `automated-notification`

System-generated, transactional notices that report a fact rather than ask
a question — receipts, statements, service alerts, build/job status,
password-reset confirmations.

Signals:
- Sender address uses a system-style local part (`billing@`, `alerts@`,
  `notifications@`, `noreply@`, a CI/service hostname) rather than a named
  individual.
- Subject or body is templated/transactional in shape: "invoice",
  "receipt", "statement", "confirmation", "alert", "reminder", "build
  failed", "your order has shipped".
- No personal greeting and no open-ended question — the message states a
  fact or a status, it does not request a substantive reply.

### `suspected-spam`

Unsolicited mail unrelated to any known sender or ongoing business, or mail
carrying phishing-style pressure or deception.

Signals:
- Sender domain is unrecognized and unrelated to any known contact or
  vendor, or the display name does not match the underlying address
  (spoofing-style mismatch).
- Urgency or threat language pushing immediate action ("act now", "action
  required", "your account will be suspended", "verify immediately").
- Unsolicited sales pitch, prize/lottery framing, or a request to click a
  link or open an attachment with no prior context establishing why.
- Generic, mass-market phrasing with no reference to any shared context
  with the recipient.
- A billing/invoice-style message from a generic or unfamiliar sender
  (`billing@`, `accounts@`) that pairs urgency wording with no specific,
  independently verifiable detail (no account number, no invoice number,
  no prior relationship) — a common phishing pattern that mimics
  `automated-notification`'s surface shape.

### `direct-request`

A specific, answerable question or request from a named individual,
addressed to the recipient personally.

Signals:
- Sender is a named individual (a person's name, not a role or system
  address), and the message is addressed to the recipient specifically —
  not a blast.
- The body contains a concrete ask: a specific question, a document or
  piece of information requested, a decision requested.
- The message references shared context (a project, a prior conversation,
  a specific deliverable) rather than reading as generic outreach.

### `meeting-scheduling`

A request to schedule, reschedule, confirm, or cancel a meeting or call.

Signals:
- Subject or body mentions scheduling terms: "meeting", "call", "sync",
  "schedule", "reschedule", "invite", "calendar", "available", "availability".
- Proposed or requested date(s)/time(s), or a request for the recipient's
  availability.
- A calendar invite attachment (`.ics`) or a request to confirm attendance
  at a previously proposed time.

## Confidence rubric

The gate below decides autonomous action versus escalation for one message.
It is always confidence in *this message's* classification — never the
matched category's action reversibility, and never a sender allowlist —
the same rule `SKILL.md` and `references/escalation.md` state.

**Confident (act autonomously).** All of the following hold:
- The message matches most of one category's signals above, clearly enough
  that a second, independent read of the same message would reach the same
  category.
- No signal from a *different* category is also present strongly enough to
  put that other category in contention — a single stray signal from
  another category (for example a newsletter that happens to contain a
  question in passing) does not by itself break confidence, but two or
  more categories each having a strong signal match does.
- Nothing about the sender, subject, or body contradicts the matched
  category (for example, a message with heavy urgency/pressure language
  is never confidently `direct-request` even if it is addressed
  personally — that pressure language is itself a `suspected-spam` signal
  in contention).

**Not confident (escalate).** Any of the following holds:
- **Ambiguous match.** Two or more categories each have a strong signal
  match for the same message, with no single category clearly dominant.
  An ambiguous match between two categories is, by definition, not
  confident — this is the rule the confidence gate exists to enforce, not
  an edge case of it. Worked example: a message from `billing@` with the
  subject "Action required on your invoice" carries `automated-notification`
  signals (system-style sender, transactional subject) and `suspected-spam`
  signals (urgency wording, no specific/verifiable invoice detail) at once
  — straddling both categories rather than clearly matching one, so it is
  not confident and escalates rather than being filed as either.
- **Weak or no match.** The message does not clearly satisfy most of any
  one category's signals.
- **Contradicting signals.** The message matches a category's surface
  signals but also carries a signal that undercuts trusting that match
  (see the `direct-request`-with-pressure-language example above).

This rubric is deliberately conservative: when in doubt between acting and
escalating, escalate. A missed escalation costs a manager a few minutes of
review; an incorrect autonomous action on a misclassified message does not
have that same cheap undo.

## No confident match

If no category matches confidently, escalate the message per
`references/escalation.md` — do not fall back to choosing the closest category
and acting on it anyway. "Closest" is not "confident": the confidence rubric
above, not proximity to any one category, is what gates autonomous action,
so a message that fails the confident-match test above always escalates
rather than being forced into whichever category scored highest.

## The skill's own escalation mail

Unlike the five categories above, this last category is not adjustable business-logic
sketch. It exists because `references/escalation.md`'s missing-configuration fallback
addresses an escalation to the mail account's own address, so that escalation mail can
arrive back in this same mailbox as unseen mail and re-enter this same classification step.

### `self-escalation`

The skill's own earlier escalation mail, sent by `references/escalation.md`'s
missing-configuration fallback and arrived back in the mailbox as unseen mail.

Signals:
- The message is self-addressed: both its `From:` and its `To:` name the mail account's own
  configured address — the same address `himalaya template write`'s `From:` header reports
  (see the `himalaya` skill's command reference, "Finding the Account's Own Address").
  Ordinary escalation mail is addressed to a separately configured `manager_address`, so a
  message the account sent to itself is a decisive, exact match — no other category's mail
  is self-addressed this way.
- Subject begins with the literal prefix `Escalation: ` — the fixed prefix `SKILL.md`'s
  escalation-composition step puts in front of the original subject.
- Body states that the escalation configuration file was missing or malformed and names the
  workspace's `config/` directory — the content `references/escalation.md`'s
  missing-configuration fallback adds to every escalation it sends this way.
