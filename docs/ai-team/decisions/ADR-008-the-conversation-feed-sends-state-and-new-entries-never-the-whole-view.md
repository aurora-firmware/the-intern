---
id: ADR-008
title: The conversation feed sends state and new entries, never the whole view
status: accepted
created: '2026-11-06'
---

# ADR-008: The conversation feed sends state and new entries, never the whole view

## Context

Each delta of a conversation's feed re-sends the conversation's whole active view. S-006 REQ-019 requires what the
service sends a page for a new activity entry to be bounded by what the entry adds, and AC-019.3 measures it on the feed
connection.

Measured on `watchConversation` with the fake model, for one short input and its reply:

| Conversation | Snapshot | Each of the 3 frames | `view.live` | `view.inbox` | `ops` |
|---|---|---|---|---|---|
| 20 entries | 5.3 KB | 5.5 to 6.7 KB | 2 to 62 B | 12 B | 53 to 880 B |
| 1,902 active entries | 1.56 MB | 1.56 MB | 2 to 66 B | 12 B | 53 to 911 B |

So the entries are the whole cost. `src/feed/observation_feed.ts` keeps up to 1,000 such deltas per slow subscriber, and
`toConversationView` maps every entry for every frame and subscriber even if a client reads none of them.

`ops` are small, but they aren't a usable delta. They hold raw `EntryRecord`s, which show an `intern.steer` or
`intern.report` by the model's message and not by its own data as ADR-004 decision 1 requires. They also carry document
writes no client reads, such as `pi.usage`, and their format belongs to chord.

A snapshot matters too. ADR-007 opens a new stream whenever a job invokes a new agent, and S-006 REQ-014 subscribes
again after each `lagging` end. With whole views in the snapshots, each of those resends every followed conversation,
which would break REQ-019 for the first entry of a new agent.

The readers need little:

- `bob chat` reads only `snapshot.live` and `delta.view.live`, and reads its entries with `conversations.entries`.
- `bob jobs follow` takes a delta only as the signal to read `conversations.entries`.
- With `--json`, both print the feed's values unchanged, so their output follows whatever the feed sends. S-005
  REQ-003 makes `--json` output a contract, and defines it as the service's answer unchanged. S-005 Interfaces defines a
  following command's lines as each feed snapshot or delta. S-003 gives a delta's data as "the delta, as JSON", and no
  spec marks its fields as a contract. The S-004 delta on this branch reaches `bob follow --json` the same way.
- Only tests read entries from a snapshot or delta: `test/service/conversation_feed.test.ts`,
  `test/service/listeners_feed.test.ts` and `test/service/instance_feed.test.ts`. The first also asserts on `ops`.
- `test/service/host_observation.test.ts` reads `view.entries` from the host's frames.

S-002's feed interface says the conversation scope carries its live view and entries. S-001 AC-016.4 asks for a snapshot
and then each change, with seat changes and report and steer entries by their own data. Neither says a snapshot holds
the entries, or that a delta repeats them.

Sources: S-006 REQ-005, REQ-014, REQ-019, AC-019.3; S-002 REQ-014, REQ-015, AC-014.1; S-001 REQ-007, AC-016.4; S-003
REQ-006, AC-006.1, AC-006.4, AC-011.1; S-005 REQ-003, REQ-015; ADR-004 decision 1; ADR-007;
`src/host/host_observation.ts`; `src/feed/observation_feed.ts`; `src/cli/chat_terminal.ts`;
`src/cli/follow_commands.ts`; pi-durable 1.4.0 `dist/harness/view.d.ts`.

## Decision

A conversation's snapshot states where it stands, and each delta states what changed. Stored history is read only
through `conversations.entries`.

1. **The snapshot is `{ newestEntryId, live, inbox, busy }`.** `newestEntryId` is the id of the conversation's newest
   entry, or `null` when it has none. A client compares it with what it already shows (ADR-007 decision 4).
2. **A delta is `{ seq, view: { live, inbox, busy }, entries }`.** `entries` holds only the entries this commit
   added, in order, often none. Each entry reads as `conversations.entries` shows it: by its own data, and an assistant
   entry with the seat that produced it. `view` keeps the path `bob chat` reads. `ops` leaves the delta.
3. **New entries come from ids, not from `ops`.** Entry ids only grow. `watchConversation` keeps the newest id it has
   passed on, takes every entry of the frame's `view.entries` with a higher id, in id order, and maps only those. It
   reads the whole view, because a compaction puts its entry before the kept entries, whose ids are lower, so a new
   entry isn't always at the end. At attachment the newest id is the highest id in the view, for the same reason. A
   reset or a compaction replaces the active window, and its own entry reaches clients as a new entry. Clients treat a
   conversation's entries as an append-only list, as `conversations.entries` does (S-002 AC-012.4).
4. **The seat on a delta's entries.** The subscription takes the seat from the latest seat record in the view at
   attachment and otherwise from the `intern.conversation` document, then moves on with each new seat record.
5. **The instance feed doesn't change.** Its deltas are already small.
6. **`scope=conversations` carries the same values** (S-003 REQ-006, AC-006.4), each wrapped with its conversation id.

## Consequences

### Positive

- A delta's size follows from the entries it adds, and from the partial answer being written, whatever the length of the
  conversation. AC-019.3 holds by construction.
- A delta maps only the entries it adds, and a slow subscriber's 1,000 pending deltas stay small. The daemon still
  compares the id of each entry of the active view once per frame and subscriber, so that one comparison grows with the
  active view. It sends nothing more, so REQ-019 and AC-019.3 aren't affected.
- A snapshot costs the same for any conversation, so reopening a stream and recovering from `lagging` cost little.
- `bob chat`'s and `bob jobs follow`'s text output doesn't change, and neither needs a code change.

### Negative

- `bob chat --json` and `bob jobs follow --json` print the new values, so the fields of those lines change, though
  each line is still the feed's value unchanged (S-005 REQ-003). `docs/manual/commands.md` names no field of them, so it
  stays right. A script that parsed `view.entries` or `ops` from those lines has to change. The product is unreleased,
  at version `0.0.0`.
- The tests named in Context change: entries are asserted on `delta.entries`, and history through
  `conversations.entries`.
- A client that wants history makes a second call after subscribing. Every client already did.
- A streamed partial answer is resent whole in `view.live` with each delta, so a long answer costs more than its length.
  This isn't new, and it's bounded by the answer being written.

### Neutral

- `watchConversation`'s frames change with the feed. Nothing else in the daemon reads them.
- The S-002 and S-001 statements stay true as written, because entries still reach a subscriber through its deltas.

## Alternatives Considered

### Alternative A: Send `ops` alone

**Description:** Let `ops` be the delta, and have clients apply them.
**Rejected because:** Clients would parse chord's format and pi-durable's raw records, against the narrow host (ADR-001
decision 2), and would see entries by the model's message, against ADR-004 decision 1.

### Alternative B: Keep whole views in the snapshot and shrink only the delta

**Description:** A snapshot keeps `entries`, as a client could use it for the history.
**Rejected because:** Every new agent then resends each followed conversation's whole view to every browser (ADR-007),
and every client already reads `conversations.entries`. This is the cost REQ-019 rules out.

### Alternative C: A new delta format for `scope=conversations` only

**Description:** Keep the conversation scope as it is, and give only the stream for pages small values.
**Rejected because:** S-003 AC-006.4 requires the same deltas that the conversation feeds give, and two shapes would
mean two code paths for one fact.

### Alternative D: A `since` parameter on the feed

**Description:** A client states what it has, and the feed starts from there.
**Rejected because:** S-002 REQ-014 rules out replay: a subscriber that reconnects starts from a fresh snapshot.

## Amendments

| Date | Change | Reason |
|---|---|---|
| 2026-11-07 | Decision 3: new entries are every entry of the view with a higher id, in id order, not a walk back from the end, and the newest id at attachment is the highest in the view. Consequences, Positive: a delta maps only what it adds, and the id comparison still reads the active view once per frame and subscriber. | B-024: after a compaction the view holds the compaction entry before kept entries with lower ids, so the walk back found nothing and the delta left the entry out. The fix in `src/host/host_observation.ts` (`createEntryTracker`) is right, and the decision text was stale. Found by the spec-truth reconciliation of S-006. |
