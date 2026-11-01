---
id: ADR-003
title: Host commits queue pi-durable writes behind a running turn
status: accepted
created: '2026-10-31'
---

# ADR-003: Host commits queue pi-durable writes behind a running turn

## Context

Some host operations commit pi-durable entries that change what the model sees in the same commit as the-intern's
own writes. The first is a team member's reset with a seat change (S-001 R-4, R-11, R-17; task T-068):
`resetWithSeat` in `src/host/seating.ts` writes the seat, its seat record and pi-durable's `ResetEntry` in one host
commit, so the new seat never exists without its record and its reset.

pi-durable's own `Conversation.reset` and `Conversation.submit` go through pi-durable submission admission
(`admitSubmission`), which runs in its own commit. It is not the daemon's admission of runs to worker threads
(S-002 R-10). When the conversation is busy, submission admission doesn't append the entry. It queues the write in
the conversation's `pi.inbox` document, and the running run places it at its next boundary, so a reset lands after
the running turn's last answer. A host commit can't call submission admission, so T-068 appended the `ResetEntry`
directly. A held-turn probe (T-068 Work Log, session 2) showed the result on a busy conversation: the running turn's
answer is written after the reset and stays in the context the reset was meant to clear, which breaks R-11.

pi-durable 1.4.0 has no submission admission call that runs inside a `Tx`. It does export everything its busy path
needs: `LiveDoc` (whose `run` field is set exactly while a run is active), `InboxDoc` with its `InboxItem` type,
`Tx.doc` and `Tx.createSubmission`. A queued write survives `Conversation.abort()`, which withdraws only queued
inputs, and it survives a restart because the inbox is a durable document.

Later operations may meet the same problem. A report delivered into a running invoking conversation (S-001 R-8a)
doesn't: it is an input with no writes of the-intern's own in its commit, so it goes through `Conversation.submit`,
placed as an `intern.report` entry (ADR-004).

Sources: S-001 R-4, R-8a, R-11, R-17; S-002 R-10, R-12, R-13; ADR-001 decision 4;
`docs/research/pi-durable-knowledge.md` (durable inbox); pi-durable 1.4.0 `dist/harness/submissions.js`
(`admitSubmission`), `dist/harness/inbox.js` and `dist/harness/generation.js`.

## Decision

A host commit that writes a pi-durable entry with `model`, `head` or `edits` (an entry that changes what the model
sees) follows the busy rule of pi-durable submission admission, inside the same commit as the-intern's own writes.

1. **Read the run state first.** At the start of the commit, before any table write, read
   `tx.doc(LiveDoc, conversationId)`. The conversation is busy when `run` is set.
2. **Idle: append.** When the conversation is idle, append the entry directly with `tx.appendEntry`, as now.
3. **Busy: queue.** When it is busy, create a `write` submission with `status: "queued"` through
   `tx.createSubmission`, and push `{ id, mode: "write", entry }` onto `tx.doc(InboxDoc, conversationId).items`, as
   submission admission does. The running run places it at its next boundary.
4. **One commit.** The-intern's own writes (for a reset with a seat: the seat, its seat record and the agent change)
   stay in that same commit, so they and the appended or queued entry are durable together or not at all.

For a reset with a seat change on a busy conversation, the seat and its record are written at once and apply from
the next model turn (S-001 R-4). The reset lands at the running run's next boundary, after its last answer. When
that boundary follows a tool round, pi-durable ends the run there and settles its inputs `unanswered` with reason
`reset`, as it does for `conversations.reset` on a busy conversation. The next turn runs with the new seat in the
cleared context (R-11). A crash after the commit leaves the queued reset in the inbox, and it lands when the run
resumes or at the next boundary (R-17: "completes on resume").

This record covers only the busy path of submission admission. Request-ID idempotency, `whenBusy` modes and the
idle boundary for queued items stay with `Conversation.submit` and aren't copied.

This keeps ADR-001 decision 4: the queue, its durability and the placement at the boundary stay pi-durable's. The
host only puts an item on pi-durable's own queue in the commit that owns the change, and writes no queue or intake
table of its own. The `held` list of a parked conversation isn't such a queue: it is a fact the-intern owns under the
bounded exception in ADR-001 decision 4, and its messages reach the conversation through `Conversation.submit` when it
continues.

## Consequences

### Positive

- `conversations.reset` and a reset that names a seat behave the same way on a busy conversation: both land at the
  turn boundary.
- The seat, its record and the reset stay in one commit, so R-17's "never half-applied" holds without splitting the
  operation.
- No new refusal is added: a team member can still reset and change the seat of any conversation at any time.

### Negative

- The host copies part of pi-durable submission admission and depends on the `pi.inbox` item shape and on the
  meaning of `LiveDoc.run`. Each pi-durable upgrade rechecks `admitSubmission` against this record, together with
  the README compatibility section.
- The seat record is written before the running turn's last answer, so the transcript shows the record before an
  answer the old seat produced. R-7 attribution therefore comes from the seat of the run that produced the message,
  not from the latest seat record. A plain seat change on a busy conversation (`changeSeat`) already behaves this
  way.

### Neutral

- When pi-durable adds a submission admission call that runs inside a `Tx`, the host code switches to it, and this
  record is superseded.

## Alternatives Considered

### Alternative A: Refuse a reset with a seat change while a turn runs

**Description:** Read `LiveDoc` and refuse the operation with `conflict` while the conversation is busy.
**Rejected because:** No approved spec states this refusal, and S-001 R-4 lets a team member change the seat "at
any time". Adding it would need a spec amendment, and the two reset operations would then behave differently.

### Alternative B: Let the running turn's answer into the new context

**Description:** Keep the direct append whatever the run state is.
**Rejected because:** The cleared context then starts with an orphaned answer from the old context, which breaks
R-11.

### Alternative C: Submit the reset through `Conversation.reset`, then change the seat

**Description:** Use pi-durable submission admission in its own commit and write the seat in a second commit.
**Rejected because:** It is two commits. A crash between them leaves a reset without its seat change, which R-17
forbids.

## Amendments

| Date | Change | Reason |
|---|---|---|
| 2026-11-01 | Added a pointer in the Decision: the `held` list of a parked conversation is a fact the-intern owns under ADR-001 decision 4's bounded exception, not a queue in front of pi-durable. No decision changes. | Spec-truth reconciliation of S-001, finding F6, and the ADR-001 amendment of the same date. |
| 2026-11-01 | Context: a report delivered into a running invoking conversation goes through `Conversation.submit` as an `intern.report` entry (ADR-004), not through this record's busy path. No decision changes. | Architecture consistency review of ADR-004. |
