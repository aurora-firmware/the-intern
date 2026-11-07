---
id: ADR-007
title: One shared worker holds a browser's feed connections
status: accepted
created: '2026-11-06'
---

# ADR-007: One shared worker holds a browser's feed connections

## Context

The web interface runs over plain HTTP (S-003, S-000), and browsers open a limited number of connections to one host
across all their tabs. A Job page reads the instance feed and one stream for its conversations (S-006 REQ-005). If each
tab held its own, 3 tabs would hold 6 streams.

S-003 REQ-006 fixes a stream's conversation ids at request, so a stream can't take a newly invoked conversation. A
client has to open a new request, which starts from a fresh snapshot of each conversation it names.

Probes made for this decision, over plain HTTP with a non-loopback name, so the page isn't a secure context:

- With 6 streams open from 3 tabs, the next call hangs in Chrome 156 and 157 and Edge 157 (`HANG` after 4 s). Firefox
  159 (Playwright's build) answered a call with 7 streams open, so AC-005.4 tests the limit only on Chrome, and on
  Edge where it is installed (S-006 REQ-021).
- A module `SharedWorker` starts, and 3 tabs share it with one stream at the server, in all four browsers. In Chrome 156
  and Firefox 159, each tab's calls were answered in 4 to 27 ms while the worker's stream ran, and a reloaded tab
  connected again to the same worker.
- Aborting a worker's `fetch` frees its connection in Chrome and Firefox, so swapping a stream holds the count steady.
- On that origin `navigator.locks`, `crypto.randomUUID`, `showSaveFilePicker` and `navigator.serviceWorker` are all
  undefined in all four browsers, and `crypto.getRandomValues` is present. `localhost` hides this, because it counts as
  a secure context.
- Playwright sees none of a shared worker's requests: `context.on("request")` and `context.route` saw 0 of them. A
  forward proxy set at launch sees them all, in Chrome and Firefox.

Sources: S-006 REQ-005, AC-005.4, REQ-013, REQ-014, REQ-017, AC-017.1, AC-019.3 and Assumptions and Dependencies; S-003
REQ-006, REQ-009 and AC-009.3; S-005 REQ-015; ADR-001 decision 2; ADR-002; ADR-006; ADR-008.

## Decision

Each browser profile holds at most two feed streams to the service, both in one shared worker, whatever number of tabs
is open. The tabs make their own calls and hold no stream.

1. **One worker, two streams.** `web/ui/feed_worker.ts` runs as a module `SharedWorker`. It holds the instance feed and
   one `GET /feed?scope=conversations` stream naming the union of the conversations its tabs follow, and it passes each
   event to the tabs that asked for it. That leaves 4 connections for calls and page loads. Pages use no long-waiting
   call: S-006 Interfaces gives them `submissions.get`, not `submissions.wait`. An export download takes one more
   connection for its length, which leaves 3.
2. **A change of set reopens the one stream.** When the union changes, the worker waits 100 ms to gather other
   changes, aborts the stream and opens a new one naming the new union. It never holds two at once. ADR-008 keeps a
   snapshot small whatever the length of a conversation, so a reopen costs little. No conversation stays followed after
   its last tab lets go of it, once the next change reopens the stream.
3. **A newly invoked conversation.** The instance feed's `conversation_created` delta names it. A Job page asks
   `conversations.get`, and when the conversation belongs to its job it reads its entries and asks the worker to follow
   it. Following comes first, and entries are compared by id, so an entry that arrives by both ways shows once.
4. **Catching up after any new stream.** ADR-008's snapshot names the newest entry id. A tab compares it with the newest
   entry it shows, and when they differ it reads `conversations.entries` newest first until it reaches an entry it
   already has. This one path covers a reopen, a `lagging` end and a restart (S-006 REQ-014).
5. **What the client library gains.** It subscribes to several conversations over one connection (S-003 REQ-009), and a
   subscription takes an `AbortSignal`, because a generator's `return()` can't end a read that's waiting on a quiet
   stream. The browser transport's feed requests set `cache: "no-store"`, so the browser's HTTP cache can never hold one
   behind another.
6. **Connection state lives in the worker.** The worker's feed loop subscribes again at once after `lagging`, and
   after 1 second after `stopped`, `unavailable` or an unreachable service. It tells every tab when the connection is
   lost and when a snapshot has arrived, and the tabs show or remove the banner from that (S-006 REQ-014). A connection
   can die with no signal, so it also calls `daemon.status` every 10 seconds with a 5-second bound, and treats a failure
   or a `stopping` phase as a lost connection. A tab whose call gets `unavailable` or fails as unreachable tells the
   worker, which checks at once. The feed logic is a pure module, `web/ui/feed_hub.ts`, with its ports and client passed
   in, so `test/unit` tests it without a browser.
7. **Tabs leaving.** A tab tells the worker on `pagehide` that it follows nothing, and asks again on `pageshow`.
   Timers and locks don't decide this: a hidden tab's timers slow to once a minute, and `navigator.locks` doesn't exist
   on plain HTTP. A crashed tab leaves its followed conversations in the union until the worker ends with the last tab,
   and costs only a few more entries.
8. **No secure-context API.** Pages and the worker use none, because the service is plain HTTP. Request ids come from
   `crypto.getRandomValues`, and text a tab must keep across a reload goes in `sessionStorage`. The browser tests open
   the pages at a non-loopback name, `intern.test`, mapped to the daemon's loopback address, so such a use fails a test.
9. **After an upgrade.** The tab loads the worker as `./feed_worker.ts?v=<intern version>`, with the version from
   `daemon.status`. On reconnecting, a tab that finds a different version saves its typed text in `sessionStorage` and
   reloads, so old and new pages never share a worker.
10. **Testing what a worker does.** Because Playwright can't see the worker's requests, tests that must see or
    change them run the browser through a small forward proxy, `test/support/web_proxy.ts`. It records requests with a
    `Referer` for S-006 AC-017.1, since the browser's own background requests carry none. It counts the bytes of the
    feed for AC-019.3, and it forces a feed's end or an `unavailable` answer for AC-014.2 and AC-014.3. AC-005.4 runs
    without the proxy, because browsers allow far more connections to a proxy, which would hide the limit it tests.

## Consequences

### Positive

- The stream count stays at 2 with any number of tabs and jobs, so S-006 AC-005.4 holds by construction.
- Tabs share one connection state and one feed, so their banners and deltas agree.
- No change to the S-003 routes or their contract.
- The worker's logic is testable without a browser.

### Negative

- A shared worker is more code than a stream per tab: a small message protocol, a union of ids and a reopen.
- The worker's errors aren't visible to Playwright, so the worker reports its failures to its tabs, which log them.
- Each reopen makes a gap in the live stream of a few milliseconds, which step 4 fills. A partial answer pauses for that
  moment.
- Very many followed conversations make a long request line. Node's default limit of 16 KiB of headers holds about 1,700
  ids, far beyond a few tabs of a small team.

### Neutral

- A separate browser profile or browser is a separate worker with its own two streams, and it has its own connection
  limit too.
- Safari isn't a target (S-006 REQ-021). It has shared workers, so nothing here blocks it.

## Alternatives Considered

### Alternative A: Streams in each tab

**Description:** Each tab holds its own instance feed and conversation stream.
**Rejected because:** 3 tabs use all 6 connections, and the probes show the next call hanging. This is what AC-005.4 is
there to prevent.

### Alternative B: A second stream for added conversations

**Description:** Keep the first stream, and open a second one for conversations added since.
**Rejected because:** It takes one more connection and needs its own reopen rule, and it exists only to avoid resending
snapshots. ADR-008 makes those small.

### Alternative C: A route that adds ids to an open stream

**Description:** Let a client name more conversations on a stream it already holds.
**Rejected because:** It changes the contract of S-003 REQ-006, and needs a stream identity and a new route for
something a reopen already gives.

### Alternative D: One tab elected to hold the stream, with `BroadcastChannel`

**Description:** Tabs elect a leader, which holds the streams and broadcasts events.
**Rejected because:** It needs an election and a handover when the leader's tab closes, and a hidden leader's timers
slow down. A shared worker gives the same result with neither.

### Alternative E: A service worker

**Description:** Hold the streams in a service worker.
**Rejected because:** `navigator.serviceWorker` is undefined on plain HTTP, and the service has no encryption (S-006
Exclusions).

### Alternative F: HTTP/2

**Description:** Serve the listeners over HTTP/2, where one connection carries many streams.
**Rejected because:** Browsers use HTTP/2 only over TLS, and S-003 excludes encryption.

## Amendments

| Date | Change | Reason |
|---|---|---|
| 2026-11-07 | Context: AC-005.4 tests the limit on Chrome, and on Edge where it is installed. The decision and the dated probes stay. | S-006 v0.4 REQ-021 makes Edge good to have. Chrome is required, so the limit is still tested on every CI run with Edge missing. |
