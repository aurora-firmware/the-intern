# Category Taxonomy

This is the taxonomy index `email-triage`'s per-message classification step
(`SKILL.md` step 3.1) consults: the starter category names, the signals that
indicate a match for each, and the confidence rubric that decides between
acting autonomously and escalating. Per-category *action* detail — the
concrete himalaya steps a confident match triggers — lives in each
category's own workflow file at `references/categories/<category>.md`, not
here; this file is the index that routes to those workflow files, not a
restatement of them.

S-010 states this taxonomy is an initial, adjustable sketch, not committed
final policy for every kind of email a user might receive (S-010
Exclusions: "Exhaustive per-category business logic"). Expect the category
list, signals, and rubric below to be revised as real mail is triaged
against them — see "Adding a category" at the end of this file for how to
extend the list without touching any other skill.

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
- Urgency or threat language pushing immediate action ("act now", "your
  account will be suspended", "verify immediately").
- Unsolicited sales pitch, prize/lottery framing, or a request to click a
  link or open an attachment with no prior context establishing why.
- Generic, mass-market phrasing with no reference to any shared context
  with the recipient.

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
