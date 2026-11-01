---
id: ADR-004
title: Inputs sent on someone's behalf are placed as their own entry kind
status: accepted
created: '2026-11-01'
---

# ADR-004: Inputs sent on someone's behalf are placed as their own entry kind

## Context

The-intern puts input into a conversation on behalf of someone other than the conversation's job source in two
cases:

- **Steers and follow-ups.** A team member or an agent steers a conversation, or queues a follow-up (S-001 R-10a).
  The transcript must record who steered.
- **Reports.** An invoked agent's report arrives in the invoking conversation as new input (S-001 R-8a). The report
  is never lost or delivered twice (S-001 R-17).

A team member reads the transcript with its attribution (S-001 R-7, R-16), so the transcript has to show who sent
each such input. The record of the sender and the message must also never be split by a crash (S-001 R-17).

pi-durable 1.4.0 has three ways to write such a record:

- **In the-intern's own commit.** Not possible for input: pi-durable submission admission (`admitSubmission`) isn't
  exported and doesn't run inside a host `Tx` (ADR-003).
- **A separate `write` submission before the input.** T-075 first built this form. A crash between the two
  submissions leaves a record for a message that never arrives, which breaks S-001 R-17.
- **The input's own entry.** A pi-durable `input` submission takes `entry?: InputEntry`, "the entry an input is
  placed as, instead of `pi.user`". The model message is still the input's user message. The kind must not start
  with `pi.`. The record and the message are then one entry, placed in the submission's own commit.

The Architect ruled for the third form on T-075 (finding F2, 2026-11-01). `steerConversation` in
`src/host/steering.ts` now submits one input placed as an `intern.steer` entry. Three places don't follow it yet:

- Report delivery (`deliver` in `src/host/reports.ts`) submits the report through `submitInput`, as plain `pi.user`.
- `continueParked` in `src/host/invocation.ts` delivers held messages as plain `pi.user`.
- A report held for a parked conversation (`holdReport` in `src/host/reports.ts`) writes no record.

Sources: S-001 R-7, R-8a, R-10a, R-16 and R-17; ADR-001 decision 4; ADR-003; T-075 (Review Verdict, Architect ruling
on F2); pi-durable 1.4.0 `dist/harness/types.d.ts` (`InputEntry`, `SubmissionDraft`).

## Decision

Every input the-intern submits on someone's behalf is one pi-durable `input` submission placed as a the-intern entry
kind through pi-durable `InputEntry`. The entry's data names the sender and carries the text.

1. **One entry, one commit.** The input's `entry` option is `{ kind, data }`. The data holds the actor, as S-001
   R-7 names actors, and `content`, the text of the message. The model sees the input's user message as before. A
   transcript read shows the text from `content`.
2. **The kinds.**
   - `intern.steer`, with data `{ actor, mode, content }`: a steer or follow-up from a team member or an agent
     (S-001 R-10a). `mode` is `steer` or `followUp`.
   - `intern.report`, with data `{ actor, content }`: an invoked agent's report (S-001 R-8a). The actor is the agent
     whose report it is, with its conversation id and role.
3. **Request ids stay as they are.** The input's request id is its exactly-once key: the caller's request id for a
   steer, and `report:<invokedId>:<entryId>` for a report. A repeat is admitted once and placed once, which is what
   the redelivery in ADR-001 decision 4 relies on.
4. **Held messages keep their kind.** When a parked conversation continues, each held message is placed as its own
   kind: a held steer as `intern.steer`, a held report as `intern.report`. The held message keeps what that needs.
   The `intern.steer` record that the hold commit writes for a held steer stays. Its data is `{ actor, mode }`, with
   no `content`: it shows that a message waits for the parked conversation. Only the delivered entry carries the
   text, so a transcript read shows the text once.
5. **Other inputs stay `pi.user`.** A conversation's first input stays plain `pi.user`, because the conversation's
   origin already records its source: a job's first input (S-001 R-12) and the job prompt of an invoked
   conversation (S-001 R-8). An input submitted with `whenBusy: "reject"` also stays plain `pi.user`. Any other
   input sent on someone's behalf, such as the answer to a blocked job's question (S-001 R-14), gets its kind by
   amending this record.

## Consequences

### Positive

- The sender's record and the message are one entry, so no crash leaves one without the other (S-001 R-17).
- The transcript shows who sent each steer, follow-up and report (S-001 R-7, R-10a, R-16), and the model sees the
  same user message as before.
- Redelivery stays exactly-once: the request id, not the entry kind, decides admission.

### Negative

- Code that reads input entries has to accept the-intern's kinds as well as `pi.user`. T-075 changed three test
  helpers for this. Monitoring, the conversation read operations and the user manual's account of a transcript
  follow each new kind.
- The host depends on pi-durable's `InputEntry` and on the rule that a kind doesn't start with `pi.`. Each pi-durable
  upgrade rechecks them, together with the README compatibility section.
- Report delivery and held-message delivery don't follow this decision yet. Until they do, a report and a delivered
  held message show as `pi.user` with no sender.

### Neutral

- When pi-durable offers submission admission inside a `Tx`, the kinds and their data stay the same; only the
  commit they are placed in may change.

## Alternatives Considered

### Alternative A: A `write` record, then the input

**Description:** Submit a display-only `write` entry that names the sender, then the input as `pi.user`, with paired
request ids.
**Rejected because:** It is two commits. A crash between them leaves a record for a message that never arrives,
which S-001 R-17 forbids. T-075 built and removed this form.

### Alternative B: The record in the-intern's own commit

**Description:** Write the record together with the-intern's own writes, and queue the input as ADR-003 does for a
reset.
**Rejected because:** pi-durable submission admission isn't public, and ADR-003 copies only its busy path. It leaves
out request-id idempotency, which every redelivery needs (ADR-001 decision 4).

### Alternative C: Plain `pi.user`, with the sender kept elsewhere

**Description:** Place every input as `pi.user` and keep the sender in a the-intern document.
**Rejected because:** The transcript wouldn't record who steered (S-001 R-10a), and the sender would live apart from
the message it describes.
