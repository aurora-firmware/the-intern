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
`src/host/steering.ts` submits one input placed as an `intern.steer` entry. T-087, T-088 and T-089 brought the
other deliveries in line:

- Report delivery (`deliver` in `src/host/reports.ts`) places a report as an `intern.report` entry (T-087).
- `continueParked` in `src/host/invocation.ts` delivers each held message as its own kind, `intern.steer` or
  `intern.report` (T-088).
- A report held for a parked conversation (`holdReport` in `src/host/reports.ts`) keeps its kind and its sender, the
  invoked agent's conversation id and role, so its delivery names the sender (T-089).

Sources: S-001 R-7, R-8a, R-10a, R-16 and R-17; ADR-001 decision 4; ADR-003; T-075 (Review Verdict, Architect ruling
on F2); T-087, T-088 and T-089; pi-durable 1.4.0 `dist/harness/types.d.ts` (`InputEntry`, `SubmissionDraft`).

## Decision

Every input the-intern submits on someone's behalf is one pi-durable `input` submission placed as a the-intern entry
kind through pi-durable `InputEntry`. The entry's data names the sender and carries the text.

1. **One entry, one commit.** The input's `entry` option is `{ kind, data }`. The data holds the actor, as S-001
   R-7 names actors, and `content`, the text of the message. The model sees the input's user message as before. A
   transcript read (`conversations.entries`) and the conversation feed show the entry's own data, so they name the
   sender and show the text from `content`. A context read (`conversations.context`) shows what the model sees, as
   S-001 defines the context, so it shows the input's user message (product owner decision, 2026-11-01).
2. **The kinds.**
   - `intern.steer`, with data `{ actor, mode, content }`: a steer or follow-up from a team member or an agent
     (S-001 R-10a). `mode` is `steer` or `followUp`.
   - `intern.report`, with data `{ actor, content }`: an invoked agent's report (S-001 R-8a). The actor is the agent
     whose report it is, with its conversation id and role.
3. **Request ids stay as they are.** The input's request id is its exactly-once key: the caller's request id for a
   steer, and `report:<invokedId>:<entryId>` for a report. An "aborted" report (S-001 R-8a) is an `intern.report`
   too, with the id ADR-001 decision 4 fixes for it. A repeat is admitted once and placed once, which is what the
   redelivery in ADR-001 decision 4 relies on.
4. **Held messages keep their kind.** When a parked conversation continues, each held message is placed as its own
   kind: a held steer as `intern.steer`, a held report as `intern.report`. The held message keeps what that needs.
   The `intern.steer` record that the hold commit writes for a held steer stays. Its data is `{ actor, mode }`, with
   no `content`: it shows that a message waits for the parked conversation. Only the delivered entry carries the
   text, so a transcript read shows the text once.
5. **Other inputs stay `pi.user`.** A conversation's first input stays plain `pi.user`, because the conversation's
   origin already records its source: a job's first input (S-001 R-12) and the job prompt of an invoked
   conversation (S-001 R-8). An input submitted with `whenBusy: "reject"` also stays plain `pi.user`. A reject input
   held for a parked conversation is held as a follow-up and delivered as `intern.steer` (S-001 R-10a). Any other
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
- An input entry carries the model's user message as well as its own data, so each read has to choose which it
  shows. `toHostEntry` in `src/host/harness_host.ts` shows an `intern.` entry by its own data, for
  `conversations.entries` (T-090) and the conversation feed (T-091). `readContext` keeps the model's message.

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

## Amendments

| Date | Change | Reason |
|---|---|---|
| 2026-11-01 | Decision 5: a reject input held for a parked conversation is held as a follow-up and delivered as `intern.steer`. Decision 3: an "aborted" report is an `intern.report` with the request id ADR-001 decision 4 fixes. No decision changes. | S-001 v0.3 R-10a (a reject input to a parked conversation is held like any other message, T-086) and R-8a (the "aborted" report, T-085), with the ADR-001 amendment of the same date. |
| 2026-11-01 | Context and Negative: report delivery, held-message delivery and held reports now follow the decision (T-087, T-088, T-089). Negative: the transcript read still shows these entries as plain user messages, until follow-up N1. No decision changes. | S-001 spec-truth reconciliation, finding A1. |
| 2026-11-01 | Decision 1: a transcript read and the conversation feed show the entry's own data; a context read shows the model's user message. Negative: the transcript read and the conversation feed now follow decision 1 (T-090, T-091); the earlier text named the instance feed, but entries are in the conversation feed. No decision changes. | S-001 spec-truth reconciliation, closing finding N1; product owner decision of 2026-11-01 that `conversations.context` shows what the model sees. |
