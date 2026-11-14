---
id: ADR-004
title: Inputs sent on someone's behalf are placed as their own entry kind
status: accepted
created: '2026-11-01'
---

# ADR-004: Inputs sent on someone's behalf are placed as their own entry kind

## Context

The-intern puts input into a conversation on someone else's behalf: steers and follow-ups (S-001 REQ-020) and invoked
agents' reports (S-001 REQ-019). The transcript must show who sent each one (S-001 REQ-007, REQ-016), and no crash may
split the sender's record from the message (S-001 REQ-017). A separate `write` record before the input, as T-075 first
built it, leaves a record without its message after a crash. pi-durable's `input` submission takes an `entry`
(`InputEntry`) to place the input as, so the record and the message can be one entry in one commit. The Architect ruled
for that form on T-075 (finding F2, 2026-11-01).

## Decision

Every input the-intern submits on someone's behalf is one pi-durable `input` submission placed as a the-intern entry
kind, whose data names the sender and carries the text.

1. **One entry, one commit.** The entry is `{ kind, data }`, with the actor (S-001 REQ-007) and `content` in its data,
   and the model still sees the input's user message. A transcript read (`conversations.entries`) and the conversation
   feed show the entry's own data; a context read (`conversations.context`) shows the user message the model sees.
2. **The kinds.**
   - `intern.steer`, data `{ actor, mode, content }`, `mode` being `steer` or `followUp`: a steer or follow-up from a
     team member, an agent (the front desk's agent included, S-001 REQ-022, REQ-023) or the daemon.
   - `intern.report`, data `{ actor, content }`: an invoked agent's report, with that agent's conversation id and role
     as its actor (S-001 REQ-019).
3. **Request ids are the exactly-once key.** A steer keeps the caller's request id and a report carries
   `report:<invokedId>:<entryId>`; an "aborted" report is an `intern.report` with the id ADR-001 decision 4 fixes. A
   job's inputs carry `resume:<jobId>:<n>` for `jobs.resume` and `reminder:<jobId>:<n>` for the reminder, where `n`
   counts the job's blocks and resumes. A front-desk steering input carries `steer:<frontDeskId>:<toolCallId>` (S-001
   REQ-022). A repeat is placed once, which ADR-001 decision 4's redelivery relies on.
4. **Held messages keep their kind.** A held steer is delivered as `intern.steer` and a held report as `intern.report`,
   with its sender. The hold commit's own `intern.steer` record has no `content`, so the text shows once.
5. **Other inputs stay `pi.user`.** A conversation's first input and an input submitted with `whenBusy: "reject"` stay
   `pi.user`, except a reject input to the front desk or one held for a parked conversation, which becomes an
   `intern.steer` follow-up (S-001 REQ-020). These are `intern.steer` follow-ups in a lead conversation: the text or
   default note of `jobs.resume`, with the team member as actor (S-004 REQ-006), and the reminder of S-004 REQ-008,
   with the daemon as actor. A team member's input to a Blocked lead, and every input a team member sends the front
   desk, is an `intern.steer` with its sender and way in (S-001 REQ-023); no agent's input reaches the front desk. Any
   other input sent on someone's behalf gets its kind by amending this record.

## Consequences

- The sender and the message are one entry, so no crash splits them, and the transcript shows who sent each input.
- Admission stays exactly-once, because the request id, not the kind, decides it.
- Readers of input entries accept the-intern's kinds as well as `pi.user`, and each read chooses between the entry's
  data and the model's message (`toHostEntry` in `src/host/harness_host.ts`, `readContext`).
- The host depends on `InputEntry` and on kinds not starting with `pi.`, which each pi-durable upgrade rechecks.

## Alternatives Considered

- **A `write` record, then the input:** rejected because a crash between the two commits leaves a record without its
  message (S-001 REQ-017).
- **The record in the-intern's own commit:** rejected because submission admission can't run there, and ADR-003's copy
  of its busy path has no request-id idempotency.
- **Plain `pi.user`, with the sender kept elsewhere:** rejected because the transcript wouldn't show who steered
  (S-001 REQ-020).
