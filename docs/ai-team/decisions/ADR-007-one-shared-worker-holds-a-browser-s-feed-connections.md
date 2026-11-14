---
id: ADR-007
title: One shared worker holds a browser's feed connections
status: accepted
created: '2026-11-06'
---

# ADR-007: One shared worker holds a browser's feed connections

## Context

The web interface runs over plain HTTP (S-003), where a browser opens about 6 connections to one host across all its
tabs. A Job page reads the instance feed and a stream for its conversations (S-006 REQ-005), so 3 tabs would hold every
connection; probes showed the next call hanging in Chrome and Edge, and S-006 AC-005.4 forbids it. A stream's
conversation ids are fixed at request (S-003 REQ-006), so following a newly invoked conversation means a new stream.

Probes on that origin also showed that a module `SharedWorker` is shared by tabs in all four browsers, that aborting its
`fetch` frees the connection, that no secure-context API (`navigator.locks`, `crypto.randomUUID`,
`navigator.serviceWorker`) exists, and that Playwright sees none of a shared worker's requests.

## Decision

Each browser profile holds at most two feed streams, both in one shared worker, whatever number of tabs is open. Tabs
make their own calls and hold no stream.

1. **One worker, two streams.** `web/ui/feed_worker.ts` runs as a module `SharedWorker` holding the instance feed and
   one `scope=conversations` stream naming the union of what its tabs follow, and passes each event to the tabs that
   asked. Pages use no long-waiting call, so 4 connections stay for calls, 3 during an export download.
2. **A change of set reopens the one stream.** The worker waits 100 ms to gather changes, then aborts the stream and
   opens one for the new union, never holding two.
3. **A newly invoked conversation.** A Job page learns of it from `conversation_created`, checks with
   `conversations.get` that it belongs to the job, asks the worker to follow it, then reads its entries. Entries are
   matched by id, so one that arrives both ways shows once.
4. **Catching up after any new stream.** A tab compares the snapshot's newest entry id (ADR-008) with its own, and reads
   `conversations.entries` newest first until it meets an entry it has. This covers a reopen, a `lagging` end and a
   restart (S-006 REQ-014).
5. **What the client library gains.** A subscription names several conversations over one connection (S-003 REQ-009)
   and takes an `AbortSignal`. Feed requests use `cache: "no-store"`.
6. **Connection state lives in the worker.** It subscribes again at once after `lagging` and after 1 second after
   `stopped`, `unavailable` or an unreachable service, and tells every tab when the connection is lost or a snapshot
   arrives, for the banner (S-006 REQ-014). It calls `daemon.status` every 10 seconds, bounded at 5, and a tab's
   failed call makes it check at once. The logic is a pure module, `web/ui/feed_hub.ts`, tested in `test/unit`.
7. **Tabs leaving.** A tab tells the worker on `pagehide` that it follows nothing and asks again on `pageshow`. A
   crashed tab's conversations stay in the union until the worker ends.
8. **No secure-context API.** Pages and the worker use none. Request ids come from `crypto.getRandomValues`, and text a
   tab keeps across a reload goes in `sessionStorage`. Browser tests use the non-loopback name `intern.test`, so such
   a use fails a test.
9. **After an upgrade.** The worker URL carries the version from `daemon.status`. A tab that finds a different
   version on reconnecting saves its typed text and reloads, so old and new pages never share a worker.
10. **Testing what a worker does.** Tests that must see or change the worker's requests run the browser through
    `test/support/web_proxy.ts`, a forward proxy (S-006 AC-017.1, AC-019.3, AC-014.2, AC-014.3). AC-005.4 runs without
    it, because a proxy lifts the connection limit it tests.

## Consequences

- Two streams with any number of tabs, so S-006 AC-005.4 holds by construction, and tabs agree on connection state.
- The S-003 routes don't change.
- A shared worker is more code than a stream per tab, and its errors reach tests only through its tabs' logs.
- Each reopen leaves a gap of milliseconds, which decision 4 fills.
- Node's 16 KiB header limit allows about 1,700 followed ids.
- Each browser profile has its own worker and its own limit. Safari isn't a target, and nothing here blocks it.

## Alternatives Considered

- **Streams in each tab:** rejected because 3 tabs use every connection, which AC-005.4 forbids.
- **A second stream for added conversations, or a route that adds ids to a stream:** rejected because the first costs a
  connection and the second changes S-003 REQ-006, both to avoid snapshots ADR-008 makes small.
- **One tab elected to hold the streams:** rejected because it needs an election and a handover, and a hidden leader's
  timers slow down.
- **A service worker, or HTTP/2:** rejected because both need a secure connection, which S-003 and S-006 exclude.
