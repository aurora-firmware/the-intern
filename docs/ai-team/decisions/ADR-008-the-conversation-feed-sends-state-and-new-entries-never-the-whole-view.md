---
id: ADR-008
title: The conversation feed sends state and new entries, never the whole view
status: accepted
created: '2026-11-06'
---

# ADR-008: The conversation feed sends state and new entries, never the whole view

## Context

Each delta of a conversation's feed re-sent the conversation's whole active view, and so did each snapshot. Measured
with the fake model, a delta for one short reply grew from about 6 KB at 20 entries to 1.56 MB at 1,902, while the
live state stayed under 100 bytes. S-006 REQ-019 bounds what a page receives for a new entry by what the entry adds,
and ADR-007 reopens streams often, so whole views would break it. The raw `ops` are small, but they show ADR-004's
kinds by the model's message, carry writes no client reads, and use chord's format. No reader needs the whole view:
`bob chat` and `bob jobs follow` read stored history through `conversations.entries`, and no spec makes a snapshot hold
entries.

## Decision

A conversation's snapshot states where it stands and each delta states what changed. Stored history is read only
through `conversations.entries`.

1. **The snapshot is `{ newestEntryId, live, inbox, busy }`.** `newestEntryId` is the newest entry's id, or `null`, for
   a client to compare with what it shows (ADR-007 decision 4).
2. **A delta is `{ seq, view: { live, inbox, busy }, entries }`.** `entries` holds only the entries this commit added,
   in order, each as `conversations.entries` shows it: by its own data, and an assistant entry with its seat. `ops`
   leaves the delta.
3. **New entries come from ids, not from `ops`.** Entry ids only grow. `watchConversation` keeps the highest id it has
   passed on and maps only the view's entries above it, in id order; at attachment that is the highest id in the view.
   A compaction puts its entry before kept entries, so the whole view is scanned. Clients treat entries as an
   append-only list (S-002 AC-012.4).
4. **The seat on a delta's entries** comes from the latest seat record in the view at attachment, else the
   `intern.conversation` document, and moves with each new seat record.
5. **The instance feed doesn't change.**
6. **`scope=conversations` carries the same values,** each wrapped with its conversation id (S-003 REQ-006, AC-006.4).

## Consequences

- A delta's size follows from what it adds and the partial answer being written, so S-006 AC-019.3 holds by
  construction, and a snapshot costs the same for any conversation.
- The daemon still compares each entry id of the active view once per frame and subscriber, which sends nothing more.
- `bob chat` and `bob jobs follow` text output doesn't change. Their `--json` lines change fields but remain the feed's
  values unchanged (S-005 REQ-003); a script that read `view.entries` or `ops` must change.
- A streamed partial answer is still resent whole in `view.live` with each delta.

## Alternatives Considered

- **`ops` alone as the delta:** rejected because clients would parse chord's and pi-durable's raw records, against
  ADR-001 decision 2 and ADR-004 decision 1.
- **Whole views in the snapshot only:** rejected because every new agent would resend each followed view to every
  browser (ADR-007).
- **A small format for `scope=conversations` only:** rejected because S-003 AC-006.4 requires the same deltas, and two
  shapes mean two code paths.
- **A `since` parameter on the feed:** rejected because S-002 REQ-014 rules out replay.
