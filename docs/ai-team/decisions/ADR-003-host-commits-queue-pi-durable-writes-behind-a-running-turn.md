---
id: ADR-003
title: Host commits queue pi-durable writes behind a running turn
status: accepted
created: '2026-10-31'
---

# ADR-003: Host commits queue pi-durable writes behind a running turn

## Context

Some host commits write a pi-durable entry that changes what the model sees together with the-intern's own writes. The
first is a reset with a seat change: `resetWithSeat` in `src/host/seating.ts` writes the seat, its seat record and the
`ResetEntry` in one commit (S-001 REQ-004, REQ-011, REQ-017). pi-durable's submission admission queues such a write in
the `pi.inbox` while a run is busy, so it lands after the running turn, but it runs in its own commit and can't be
called inside a host `Tx`. Appending directly on a busy conversation left the running turn's answer in the context the
reset was meant to clear (T-068).

## Decision

A host commit that writes an entry with `model`, `head` or `edits` follows pi-durable's busy rule itself, inside the
same commit as the-intern's own writes.

1. **Read the run state first.** At the start of the commit, read `tx.doc(LiveDoc, conversationId)`; the conversation
   is busy when `run` is set.
2. **Idle: append.** Append the entry with `tx.appendEntry`.
3. **Busy: queue.** Create a queued `write` submission with `tx.createSubmission` and push
   `{ id, mode: "write", entry }` onto the conversation's `InboxDoc` items, as submission admission does. The running run places it at its next
   boundary.
4. **One commit.** The-intern's own writes stay in that commit, so they and the entry are durable together or not at
   all.

On a busy conversation, the new seat applies from the next model turn and the reset lands after the running turn's
last answer, as `conversations.reset` does; a crash leaves it queued until the run resumes. The job abort's closed-mark
commit removes queued items from the same inbox (S-001 REQ-026). Request-id idempotency and `whenBusy` stay with
`Conversation.submit` and aren't copied. The queue and its placement stay pi-durable's, so this keeps ADR-001
decision 4; a parked conversation's `held` list is a fact under that decision, not such a queue.

## Consequences

- Both reset operations land at the turn boundary, and the seat, its record and the reset are never half-applied.
- No refusal is added: a seat can still change at any time.
- The host depends on the `pi.inbox` item shape and the meaning of `LiveDoc.run`, so each pi-durable upgrade rechecks
  this record.
- The seat record can precede an answer the old seat produced, so attribution comes from the seat of the run that
  produced a message (S-001 REQ-007).
- When pi-durable offers submission admission inside a `Tx`, the host switches to it and this record is superseded.

## Alternatives Considered

- **Refuse a reset with a seat change while a turn runs:** rejected because S-001 REQ-004 allows a seat change at any
  time.
- **Append directly whatever the run state:** rejected because the cleared context would start with the old context's
  answer (S-001 REQ-011).
- **`Conversation.reset`, then the seat in a second commit:** rejected because a crash between the commits leaves a
  reset without its seat change (S-001 REQ-017).
