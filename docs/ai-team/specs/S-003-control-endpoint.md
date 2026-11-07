---
id: S-003
title: Control endpoint
version: '0.6'
status: approved  # draft | review | approved | superseded
created: '2026-11-01'
author: planner
---

# Control endpoint

## Purpose

This spec covers the listeners of S-000's **Intern service** component, which the spec map calls the control
endpoint. S-002 gives the daemon a transport-free catalogue of read and control operations and an observation feed, but
nothing outside the daemon process can reach them yet, so neither the `bob` commands nor the web interface can be
built. This spec fixes two listeners that speak one HTTP protocol (a local socket on the machine, always on, and a
network listener for the team's network, off until configured), the routes that carry the catalogue and the feed, the
serving of the web interface files (part of making the service reachable for the web interface, S-000), and the
TypeScript client library that the `bob` commands and the web interface use. When it is done, every catalogue
operation answers through both listeners as it answers in-process, within the protocol's limits (Success Criteria).

## Definitions

This spec uses the Definitions of S-001 and S-002 (listener, client, caller, service operation, observation feed) and
the shared vocabulary of `docs/system_overview.html`. It adds these terms:

| Term | Meaning in this spec |
|---|---|
| Local socket | The listener on a Unix domain socket in the instance's runtime directory. The `bob` commands on the machine use it. |
| Network listener | The listener on a TCP address and port of the machine. The web interface in a team member's browser uses it. |
| HTTP front | The request handling both listeners share: operation routes, the feed route, validation and error mapping. |
| Way in | As in the shared vocabulary: how a team member reached The Intern. For calls through a listener, it names the listener (REQ-007). |
| Client library | The TypeScript library that calls the daemon through a listener, from Node or from a browser. |
| Web interface files | The static files of the web interface (pages, scripts, styles). They ship with the package; the Web interface spec owns their content. |

## Users and Journeys

| Actor | Goal |
|---|---|
| Team member on the machine | Runs `bob` commands that call the daemon over the local socket. |
| Team member on the team's network | Opens the web interface in a browser, follows work live and calls control operations. |
| Other programs (downstream systems) | Scripts and tools on the machine or on the team's network call the same routes, with the same contract as The Intern's own clients. |
| Later specs (downstream systems) | The Command line and Web interface specs build on the client library; Jobs, schedules and triggers and other specs add operations that become reachable with no listener change. |
| Developer | Runs both listeners in tests on the fake model, with a temporary socket and a free loopback port, and no outside network. |

Journeys, in priority order:

1. **A `bob` command calls the daemon on the machine.** It reaches the local socket, calls an operation and gets the
   same result or error as an in-process call; the action is attributed to a team member with the way in
   `command line`. Delivered by REQ-001, REQ-003, REQ-004, REQ-005, REQ-007, REQ-009.
2. **A team member uses the web interface from another computer on the LAN.** A team member configures the network
   listener's address and port, the browser loads the web interface from it, subscribes to the feed and calls control
   operations, attributed with the way in `web interface`. Delivered by REQ-002, REQ-003, REQ-006, REQ-007, REQ-008,
   REQ-009, REQ-015.
3. **A later spec adds an operation.** It is reachable on both listeners and through the client library without a
   listener change. Delivered by REQ-003, REQ-009.
4. **Listeners start and stop with the daemon.** A misconfigured network listener stops startup; shutdown ends every
   call and stream within the daemon's stop bound. Delivered by REQ-001, REQ-002, REQ-010.
5. **Watching never slows work.** A slow or vanished client is dropped without delaying an agent run. Delivered by
   REQ-011, REQ-012.

## Exclusions

What this specification explicitly does NOT cover:

- **Security of the listeners in v1.** No listener authenticates callers, checks the `Origin`, `Host` or `Referer`
  headers, sends CORS headers or encrypts traffic (no TLS). Whoever reaches a listener can use everything it exposes
  (ADR-002), and the team limits who reaches the network listener with its network setup. Product owner ruling on
  2026-11-01: the first version focuses on working and being reachable from the LAN; security, including browser and
  cross-site concerns, is a later decision.
- **A version check between client and daemon.** Neither side compares versions, and a mismatch isn't detected.
- **Changing listener settings while the daemon runs.** They are read at startup; a change takes effect at the next
  restart (S-002 REQ-021).
- **The content of the web interface and of the `bob` commands.** The Web interface and Command line specs own them.
  This spec serves the web interface files and gives both a client library.
- **New service operations.** This spec adds none. The listeners carry whatever the catalogue holds. The export route
  (REQ-016) serves the copy S-004 REQ-016 defines.
- **A stable public API.** The routes are the contract of The Intern's own clients. Other programs may use them, but
  they get no compatibility promise across versions.
- **Windows, Linux arm64 and Intel macOS.** These remain unsupported (S-000).

## Alternatives Considered

- **Resource-style routes mapped by hand** (for example a read of one conversation at `/conversations/<id>` and a
  submit at `/conversations/<id>/submit`). Rejected: friendlier to curl and outsiders, but every new operation needs a
  hand-designed route, and the route table becomes a second catalogue to keep in step with S-002 and every later spec.
- **TCP only, with no Unix socket**, the command line using the network listener on loopback. Rejected: it gives up
  the owner-only runtime directory as the gate on the machine, and the command line wouldn't work while the network
  listener is off, which is the default.
- **WebSocket for the feed.** Rejected: the feed is one-way, Server-Sent Events carry it over plain HTTP in Node and
  in browsers, and a WebSocket server needs more machinery for no gain.
- **A line protocol (NDJSON) on the socket and HTTP only on the network.** Rejected: two protocols to keep in step.
  The feature review had already chosen HTTP over the socket (`docs/research/feature-review.md`, open decision 3).
- **The network listener on by default** (on loopback or on every interface). Rejected: with no authentication,
  exposing The Intern on a network has to be a deliberate setting.
- **A read-only network listener.** Rejected: S-000 has team members create jobs, answer, stop and redirect agents and
  configure The Intern from the web interface.
- **The client stating its own way in, or a job's origin.** Rejected: the listener stamps the way in, and the service
  builds a job's origin from the caller (S-002 AC-012.5), so a client or a bug can't record a wrong one.
- **Logging a network listener bind failure and running without it.** Rejected: it hides a misconfiguration; the
  daemon fails closed instead.
- **Browser and cross-site protections** (an `Origin` or `Host` check, rules recorded in an ADR). Deferred by the
  product owner: no security work in v1 (Exclusions).
- **Rebinding the network listener when its settings change at runtime.** Rejected: a rare change, and a restart is
  cheap under the supervisor.
- **A random free port for team members.** Rejected: the web interface needs an address known in advance. Team members
  always configure a fixed port; only tests use a free port, through a test-only switch.

## Interfaces

### Exposed: the HTTP protocol

Both listeners serve these routes (REQ-003 to REQ-006). Any other method or path gets `404` with `not_found`.

**Contract:**

| Route | Request | Success | Failure |
|---|---|---|---|
| `POST /operations/<name>` | `Content-Type: application/json` (parameters such as `charset` allowed), also when the body is empty; body: the operation's input as JSON, or empty for no input | `200`, body `{"result": <result>}` | Status from the table below, body `{"error": {"code": "<code>", "message": "<message>"}}` |
| `GET /feed?scope=instance` | none | `200`, `Content-Type: text/event-stream`, events below | Status and error body as for operations, before any event |
| `GET /feed?scope=conversation&id=<conversation id>` | none | as above | as above |
| `GET /feed?scope=conversations&id=<conversation id>&id=<conversation id>` | none | as above, one stream for all the named conversations, each event naming its conversation (REQ-006) | as above |
| `GET /ui/…` (network listener only) | none | The web interface file | `404` for a missing file |
| `GET /` (network listener only) | none | Redirect to `/ui/` | — |
| `GET /export` (network listener only) | none | `200`, a file attachment holding the whole database (REQ-016) | Status and error body as for operations, before any byte of the file; after that, the connection closes without completing the response |

`feed.subscribe` is served only at `GET /feed`, its query standing in for the operation's input. Called at
`POST /operations/feed.subscribe`, it is refused with `invalid_input` and a message naming `GET /feed`. It is the
only streaming operation; a later spec that adds another names its route by amending this spec. `scope=conversations`
is no scope of `feed.subscribe`: the listener makes one subscription per conversation and writes them to one stream.

**Contract** (error outcome to HTTP status; the codes are S-002's):

| Code | Status |
|---|---|
| `invalid_input` | 400 |
| `not_found` | 404 |
| `busy` | 409 |
| `conflict` | 409 |
| `unavailable` | 503 |
| `internal` | 500 |

Clients branch on `code`, never on the status.

**Contract** (feed events, Server-Sent Events):

| Event name | `id` | `data` |
|---|---|---|
| `snapshot` | none | The feed's snapshot for the scope, as JSON |
| `delta` | The delta's sequence number | The delta, as JSON |
| `end` | none | `{"reason": "lagging" \| "stopped"}`; the stream closes after it |

**Contract** (`scope=conversations`): one `snapshot` event per named conversation, then `delta` events. The `data` of
each is `{"conversationId": "<id>", "event": <the snapshot or delta>}`, and a delta's `id` is its sequence number. Order
holds within a conversation; the stream promises no order between conversations. One `end` event ends the whole stream.

A client that closes the connection is unsubscribed; no `end` event can reach it. A new request starts a new
subscription with a fresh snapshot; the listener ignores `Last-Event-ID` (S-002 REQ-014).

**Contract** (way-in values recorded by S-001 attribution, REQ-007): `command line` for the local socket and
`web interface` for the network listener. Later ways in (Email) add their own values.

### Exposed: the client library

A TypeScript library, usable in Node and in the browser (REQ-009):

- connect to the local socket (Node) or to a base URL (Node or browser); in Node the default socket is the one the
  daemon uses, resolved from the runtime directory as S-002 REQ-006 resolves it, and can be overridden
- call an operation by name with an input; the call returns the result, or fails with the same code and message an
  in-process call gives
- subscribe to a scope, or to several conversations over one connection, with each event naming its conversation; the
  subscription yields the snapshot, then the deltas in order, and ends with the reason; it never starts a new
  subscription on its own after an `end` or a closed connection
- fail with a distinct "unreachable" error, naming the socket path or URL, when no daemon answers or the connection
  closes before a call's answer arrives; it is not one of S-002's error codes

The library's function names and types are not contract; the tasks fix them.

### Consumed

- S-002's catalogue: listing operations and invoking one by name with an input and a caller (S-002 REQ-012, REQ-013,
  REQ-017), with a job's origin built from the caller (S-002 AC-012.5).
- S-002's observation feed: subscribing to a scope and its end reasons (S-002 REQ-014, REQ-015).
- S-004's `jobs.export`, which makes the copy the export route sends (S-004 REQ-016; ADR-001 decision 2).
- S-002's startup step 8, shutdown order, readiness and stop bound, and the runtime directory (S-002 REQ-002,
  REQ-003, REQ-005, REQ-006).
- The `[network]` section of the configuration file (Configuration Requirements; S-002 REQ-021, REQ-022).
- The web interface files shipped in the package (Web interface spec).

## Workflow

The listeners' life inside the daemon's startup and shutdown, an operation call and a feed subscription, with
their failure paths:

```
Startup (S-002 REQ-002 step 8; socket first)
  local socket: check path length → replace leftover socket file → listen, owner-only        REQ-001
  [network] set? → bind address and port; failure → daemon exits 1 naming address, reason    REQ-002
  no [network] → nothing listens on TCP                                                      REQ-002
  until ready: daemon.status answers "starting", every other call 503 unavailable           REQ-001
  → daemon reports ready

Operation call
  POST /operations/<name>
    → not application/json (empty body too), malformed JSON, body over 10 MiB → 400          REQ-004
    → unknown name → 404 not_found; a streaming operation → 400 naming GET /feed             REQ-003
    → caller = team member, way in fixed by the listener                                     REQ-007
    → catalogue.invoke(name, input, caller)                                                  REQ-003
    → 200 {result} or status from the code with {error}                                      REQ-005

Feed
  GET /feed?scope=…
    → invalid scope 400; unknown conversation 404                                            REQ-006
    → snapshot → delta … → end(reason)                                                       REQ-006
    → client stops reading → end(lagging), run unaffected                                    REQ-011
    → client disconnects → unsubscribed                                                      REQ-006
  GET /feed?scope=conversations&id=…&id=…
    → no id 400; an unknown id 404, before any event                                         REQ-006
    → a snapshot per conversation → deltas naming their conversation → one end for all       REQ-006

Export
  GET /export (network listener) → consistent copy as a file, work goes on → log, temporary copy removed   REQ-016
    → a download already running → 409 busy; too little free space → 409 conflict            REQ-016
  Next start after a kill → a copy left behind removed                                       REQ-016

Shutdown (S-002 REQ-005)
  "stopping" → new calls 503 unavailable → running calls and downloads cut (503 or closed connection)
  → streams end(stopped) → listeners close → socket file removed → database closes           REQ-010
```

## Behavioral Requirements

### REQ-001 — The local socket

The daemon SHALL always run the local socket listener, on the socket file `bob.sock` in the instance's runtime
directory (S-002 REQ-006), accessible only to the service account. It opens in startup step 8 (S-002 REQ-002), before
the network listener and after the daemon holds single ownership, so a socket file left by
an earlier daemon is replaced. If the socket path is longer than the platform allows, startup stops with an error
naming the path. Until the daemon is ready, both listeners answer `daemon.status` ("starting") and refuse every other
call and feed request with `503 unavailable` (S-002 REQ-003).

#### AC-001.1 — Started with the daemon

- **Given:** a valid instance
- **When:** the daemon becomes ready
- **Then:** `bob.sock` exists in the runtime directory, is accessible only to the service account, and answers
  `POST /operations/daemon.status` with status `ready`

**Verification:** test — a service test starting the daemon on the fake model with a temporary runtime directory.

#### AC-001.2 — A leftover socket file is replaced

- **Given:** a runtime directory holding a `bob.sock` left by a killed daemon
- **When:** a daemon starts on the instance
- **Then:** it becomes ready and answers on the socket

**Verification:** test — a service test that creates the leftover file, then starts the daemon.

#### AC-001.3 — A socket path that is too long

- **Given:** a runtime directory whose socket path exceeds the platform limit
- **When:** the daemon starts
- **Then:** it exits non-zero with an error naming step 8 and the socket path, and stops the components already
  started (S-002 AC-002.2)

**Verification:** test — a service test with a deeply nested runtime directory.

#### AC-001.4 — Calls before ready

- **Given:** a daemon whose listeners are open and whose last start step is held
- **When:** a client calls `daemon.status`, another operation and `GET /feed` over each listener
- **Then:** status answers "starting", the other call and the feed request get `503 unavailable`, and after the step
  is released the same calls succeed

**Verification:** test — a service test with the last start step held (as S-002 AC-003.1).

### REQ-002 — The network listener

The network listener SHALL run only when the configuration file has a `[network]` section; it then opens in startup
step 8, after the local socket, and listens on the configured address and port. When it can't listen (the port
is in use, the address is unknown or not on the machine), startup stops with an error naming the address, the port
and the reason, and the components already started are stopped (S-002 REQ-002). Its settings are read at startup
only.

#### AC-002.1 — Off without configuration

- **Given:** a configuration file without a `[network]` section
- **When:** the daemon becomes ready
- **Then:** the daemon listens on no TCP port, and the local socket answers

**Verification:** test — a service test checking the daemon's open listening sockets.

#### AC-002.2 — On with configuration

- **Given:** `[network]` with address `127.0.0.1` and a port, given by the test-only free-port switch
- **When:** the daemon becomes ready
- **Then:** the network listener answers `POST /operations/daemon.status` on that address and port, and its start log
  line names them

**Verification:** test — a service test on loopback.

#### AC-002.3 — A bind failure stops startup

- **Given:** `[network]` naming a port already in use, and in a second case an address not on the machine
- **When:** the daemon starts
- **Then:** it exits 1 naming the address, the port and the reason; the local socket file doesn't remain; nothing
  answers on either listener

**Verification:** test — a service test that holds the port with another socket first.

### REQ-003 — Operations through the listeners

Each listener SHALL expose every operation of S-002's catalogue, read and control, at `POST /operations/<name>`, and
answer it with the result the service layer returns for the same input. The routes are derived from the catalogue, so
an operation added to the catalogue is reachable with no listener change. An unknown name gets `not_found`. An
operation whose result is a stream (`feed.subscribe`) is served only as a stream (REQ-006), and refused at the
operation route with `invalid_input` naming its stream route.

#### AC-003.1 — Same result as in-process

- **Given:** a ready daemon with both listeners
- **When:** each catalogue operation except `feed.subscribe` is called with a valid input in-process, over the local
  socket and over the network listener
- **Then:** the three results are equal apart from values that differ between calls by nature (ids, times) and the
  recorded way in (`in-process`, `command line`, `web interface`) and observed caller details, and read operations
  leave state unchanged

**Verification:** test — one service test that enumerates the catalogue and calls every operation through both
listeners.

#### AC-003.2 — An operation added later

- **Given:** a test operation registered in the catalogue (as `test.createConversation` is, S-002)
- **When:** it is called through both listeners
- **Then:** it answers on both, with no change to listener code

**Verification:** test — a service test using the test operations of `test/support/test_operations.ts`.

#### AC-003.3 — Unknown routes and the streaming operation

- **Given:** a ready daemon
- **When:** `POST /operations/no.such`, `GET /operations/daemon.status`, `GET /nothing` and
  `POST /operations/feed.subscribe` are called
- **Then:** the first three get `404` with `not_found` and a message naming the operation or path; the last gets
  `400` with `invalid_input` and a message naming `GET /feed`

**Verification:** test — a service test.

### REQ-004 — Request validation

The HTTP front SHALL refuse an operation call with `invalid_input`, without calling the operation, when it doesn't
declare the `application/json` media type (also when its body is empty), its body isn't valid JSON, or its body is
larger than 10 MiB. A body larger than 10 MiB is refused without reading the rest of it. An empty body means the
operation is called with no input. The request never carries the caller: the input is the operation's input only.

#### AC-004.1 — Refused requests

- **Given:** a ready daemon
- **When:** an operation is called with `Content-Type: text/plain`, with a form body, with an empty body and no
  content type, with malformed JSON, and with a body of 10 MiB plus one byte
- **Then:** each gets `400` with `invalid_input`, the operation isn't run and nothing changes

**Verification:** test — a service test.

#### AC-004.2 — Accepted requests at the boundaries

- **Given:** a ready daemon
- **When:** `conversations.submit` is called with a JSON body of exactly 10 MiB, and `daemon.status` with an empty
  body declared `application/json; charset=utf-8`
- **Then:** both are accepted and answer as they would in-process

**Verification:** test — a service test.

### REQ-005 — Error outcomes

Every error outcome of an operation SHALL reach the client as the HTTP status of the Interfaces table and a body
carrying S-002's code and the operation's message unchanged.

#### AC-005.1 — Each code and its status

- **Given:** a ready daemon
- **When:** calls are made that end in each outcome: invalid input, an unknown conversation, a reject-if-busy submit
  to a busy conversation, a conflicting create, a call while the daemon is stopping, and a failing run (through
  `test.failStorage`)
- **Then:** they get `400 invalid_input`, `404 not_found`, `409 busy`, `409 conflict`, `503 unavailable` and
  `500 internal`, each with the message the in-process call gives

**Verification:** test — a service test.

### REQ-006 — The feed over Server-Sent Events

`GET /feed` SHALL subscribe to the observation feed for the scope named in its query, and stream the snapshot, the
deltas with their sequence numbers as event ids, and a final `end` event with the reason, as the Interfaces table
gives them. An invalid scope is refused with `invalid_input` and an unknown conversation with `not_found`, before any
event. When the client closes the connection, the subscription is ended as `unsubscribed`.

`GET /feed?scope=conversations` SHALL give one stream for several conversations, composed from one `feed.subscribe`
subscription per named conversation, with each event naming its conversation. A repeated id counts once. A request with
no id is refused `invalid_input`, and one with an unknown id `not_found`, before any event. When one subscription ends
with `lagging` or `stopped`, the listener SHALL end the others and send one `end` with that reason. When the client
closes the connection, each subscription is ended as `unsubscribed`.

#### AC-006.1 — Snapshot, then deltas

- **Given:** a conversation with a run
- **When:** a client opens the conversation feed, then opens it again
- **Then:** each stream starts with a `snapshot` event, then `delta` events with increasing ids in commit order; the
  second stream starts from a fresh snapshot with no replay

**Verification:** test — a service test over both listeners.

#### AC-006.2 — Instance scope

- **Given:** several conversations
- **When:** a client opens the instance feed
- **Then:** the snapshot and deltas are those of S-002 AC-014.2

**Verification:** test — a service test.

#### AC-006.3 — Refused and closed subscriptions

- **Given:** a ready daemon
- **When:** a client opens `/feed` with no scope, with `scope=conversation` and an unknown id, and opens a valid
  stream and closes it
- **Then:** the first gets `400 invalid_input`, the second `404 not_found`, and the closed stream's subscription ends
  as `unsubscribed` and holds no resources

**Verification:** test — a service test.

#### AC-006.4 — One stream for several conversations

- **Given:** three conversations with runs
- **When:** a client opens `GET /feed?scope=conversations` naming the three, over each listener
- **Then:** the stream starts with one `snapshot` per conversation, then the deltas of all three on the one connection,
  each naming its conversation and in commit order within it, the same deltas that three conversation feeds give

**Verification:** test — a service test over both listeners.

#### AC-006.5 — Refusals and the end of a stream for several conversations

- **Given:** a ready daemon
- **When:** a client opens `scope=conversations` with no id, with an unknown id among known ones, with known ids while
  one subscription lags, and with a repeated id, and closes another such stream
- **Then:** the first gets `400 invalid_input`, the second `404 not_found` and no event, the third one `end` with
  `lagging` and a closed stream, the fourth one `snapshot` for the repeated id, and the closed stream's subscriptions
  all end as `unsubscribed`

**Verification:** test — a service test.

### REQ-007 — The way in

Each listener SHALL call every operation and subscription with the caller "team member", with the way in fixed by the
listener: `command line` on the local socket and `web interface` on the network listener. The way in names the
listener, so any program calling through it is recorded with that value. With the way in, each listener SHALL pass
the caller details it observes: the network listener the remote address and port of the TCP peer, never taken from
a header such as `X-Forwarded-For`, and the local socket none beyond the way in. Nothing in the request can change the
caller or these details, and a job created through a listener (`jobs.create`) records a request with that way in and
those details as its origin (S-002 AC-012.5; S-004 REQ-003).

#### AC-007.1 — Attribution per listener

- **Given:** a conversation
- **When:** its seat is changed once over the local socket and once over the network listener, and input is submitted
  over each
- **Then:** the seat records and the submitted messages name a team member with the way in `command line` and
  `web interface` respectively (S-001 REQ-007)

**Verification:** test — a service test reading the conversation's entries.

#### AC-007.2 — The request can't claim another caller or origin

- **Given:** a ready daemon
- **When:** a call over the local socket sends an input or header claiming the way in `web interface` or an agent
  actor, and a `jobs.create` call over it names a schedule origin
- **Then:** the recorded actor is still a team member with the way in `command line`, and the `jobs.create` call is
  refused `invalid_input`, creating no job and using no number; without an origin it creates `C-n` with way in
  `command line`

**Verification:** test — a service test.

#### AC-007.3 — The remote address is the TCP peer's

- **Given:** a ready daemon
- **When:** a `jobs.create` call over the network listener carries an `X-Forwarded-For` header naming another address
- **Then:** the job's origin records the remote address and port of the TCP connection, not the header's value

**Verification:** test — a service test on a loopback port.

### REQ-008 — The web interface files

The network listener SHALL serve the web interface files under `/ui/`, and redirect `/` to `/ui/`. The local socket
doesn't serve them. A missing file gets `404`.

#### AC-008.1 — Files served from the network listener

- **Given:** the network listener running, with web interface files in the package
- **When:** a client requests `/`, `/ui/`, a file under `/ui/`, and a missing file
- **Then:** `/` redirects to `/ui/`, the files are returned with their content types, and the missing file gets `404`;
  the same paths on the local socket get `404`

**Verification:** test — a service test.

### REQ-009 — The client library

The client library SHALL let a program in Node (over the local socket or a URL) or in a browser (over a URL) call any
operation by name and subscribe to any feed scope. A failed call MUST fail with the same code and message as the
in-process call. A subscription yields the snapshot, then the deltas in order, ends with the reason, and never starts
a new subscription on its own. It SHALL also subscribe to several conversations over one connection (REQ-006), and
each event names its conversation. When no daemon answers, or the connection closes before a call's answer arrives, the
call fails with an "unreachable" error naming the socket path or URL. In Node, the default socket is the daemon's,
resolved as S-002 REQ-006 resolves the runtime directory, and can be overridden. The `bob` commands and the web
interface call the daemon only through this library, except for the browser's own download of `GET /export` (REQ-016).

#### AC-009.1 — Calls and subscriptions over both listeners

- **Given:** a ready daemon with both listeners
- **When:** the library calls `daemon.status`, an operation that fails with `not_found`, and subscribes to the
  instance feed, once over the socket and once over the URL
- **Then:** it returns the status, fails with `not_found` and the in-process message, and yields a snapshot then
  deltas, ending with `stopped` when the daemon stops and starting no new subscription

**Verification:** test — a service test of the library in Node over both listeners.

#### AC-009.2 — No daemon, or a daemon that goes away

- **Given:** no daemon on the instance, and in a second case a daemon stopped while a call waits in
  `submissions.wait`
- **When:** the library calls an operation over the default socket
- **Then:** the call fails with "unreachable" naming the socket path, or, for the waiting call, with `unavailable` or
  "unreachable"

**Verification:** test — a unit test for the first case, a service test for the second.

#### AC-009.3 — The browser transport

- **Given:** the library's browser transport
- **When:** a reviewer checks it
- **Then:** it uses only the browser's own HTTP and event-stream support, the same request and event format as the
  Node transport, and closes the stream after an `end` event instead of letting the browser reconnect

**Verification:** inspection — the client library's browser transport and its shared format code.

#### AC-009.4 — Several conversations through the library

- **Given:** a ready daemon with both listeners and two conversations with runs
- **When:** the library subscribes to both over one connection, once over the socket and once over the URL
- **Then:** it opens one request, yields each conversation's snapshot and deltas in order with its conversation id, and
  ends with `stopped` when the daemon stops, starting no new subscription

**Verification:** test — a service test of the library in Node over both listeners.

### REQ-010 — Listeners at shutdown

When the daemon reports "stopping" (S-002 REQ-005), the listeners SHALL answer new calls `503 unavailable`, end every
open feed stream with `end` and the reason `stopped`, and end every call still running, such as a
`submissions.wait`, with `503 unavailable` or by closing its connection, without waiting for it to finish. A running
download of `GET /export` ends as REQ-016 states. They close
before the database closes and within the daemon's 10-second stop bound. The local socket file is removed.

#### AC-010.1 — Shutdown with open streams and a waiting call

- **Given:** a ready daemon with a client streaming the instance feed over each listener and a call waiting in
  `submissions.wait` with the 5-minute maximum
- **When:** the daemon receives SIGTERM
- **Then:** each stream receives `end` with `stopped`; the waiting call ends at once with `503 unavailable` or a closed
  connection; a new call gets `503 unavailable` or a refused connection; the socket file is gone after exit, and the
  daemon exits 0 within the stop bound

**Verification:** test — a service test.

### REQ-015 — The network settings survive settings writes

The configuration file's `[network]` section SHALL be a known section of the file, and a settings operation (S-002
REQ-022) MUST leave it exactly as written.

#### AC-015.1 — A role change keeps `[network]`

- **Given:** a configuration file with a `[network]` section
- **When:** a role is changed through `roles.change`, and the daemon restarts
- **Then:** the file still holds the `[network]` section with the same address and port, and the network listener
  starts on them

**Verification:** test — a service test.

### REQ-016 — The export route

The network listener SHALL answer `GET /export` with a consistent copy of the instance's whole database, the same copy
S-004 REQ-016 defines, as a file attachment whose suggested name holds the instance and the date. Work in progress SHALL
go on during the download. The configuration file isn't in it. The daemon SHALL log each download with the way in, the
remote address and port (REQ-007). A failure before the first byte SHALL use the operations' error body (REQ-005), and
a failure after it SHALL close the connection without completing the response, so that a client can tell the file is
partial. The local socket SHALL answer this path `404`, and `bob export` stays the way in for a machine's own files.

Any temporary copy on the daemon's machine SHALL be accessible only to the service account (ADR-002 decision 6). The
daemon SHALL remove it when the download ends, whether it finished, failed or the client left. When the daemon stops
during a download, the connection SHALL close without completing the response and no temporary copy SHALL remain, within
the daemon's stop bound (REQ-010). A temporary copy that a killed daemon left SHALL be removed at the next start, with
or without a `[network]` section.

One download SHALL run at a time, and a request made while one runs SHALL get `409 busy`. A copy the database is too
busy to make gets `409 busy` as well, as `jobs.export` refuses it. When the free space where the temporary copy goes is
under the database's size plus a margin, the route SHALL refuse the request with `409 conflict` and a message naming the
space needed, and SHALL make no copy. The margin is a built-in constant that Feature Architecture fixes.

#### AC-016.1 — A copy while working

- **Given:** a daemon with jobs running on the fake model
- **When:** a client requests `GET /export` over the network listener
- **Then:** the response is a file attachment that opens as a database holding every job, worklog entry, history entry
  and conversation committed before the export began; the jobs go on; the log names the way in and the client's address
  and port; and no temporary copy remains

**Verification:** test — a service test on a loopback port. The test requests again on `409 busy`, because `jobs.export`
answers `busy` when the database stays in a transaction while running jobs write to it.

#### AC-016.2 — A client that leaves, and a failure

- **Given:** a ready daemon
- **When:** a client disconnects part way through a download, and in a second run the copy can't be made
- **Then:** the first leaves no temporary copy and the jobs go on; the second answers with the error body, with no file,
  and leaves no temporary copy

**Verification:** test — a service test.

#### AC-016.3 — Not on the local socket, and not while stopping

- **Given:** a daemon with both listeners
- **When:** a client requests `GET /export` over the local socket, and over the network listener during startup and
  during shutdown
- **Then:** the local socket answers `404`, and the network listener answers `503 unavailable` during startup and
  shutdown

**Verification:** test — a service test.

#### AC-016.4 — The temporary copy is owner-only

- **Given:** a download held part way, with a client that has stopped reading
- **When:** the test reads the modes of what the download made in the daemon's directories
- **Then:** each file is accessible only to the service account, and each folder too

**Verification:** test — a service test on a loopback port.

#### AC-016.5 — A download running at shutdown

- **Given:** a download held part way
- **When:** the daemon receives SIGTERM
- **Then:** the connection closes without completing the response, no temporary copy remains, and the daemon exits 0
  within the stop bound

**Verification:** test — a service test on a loopback port.

#### AC-016.6 — A copy left by a killed daemon

- **Given:** a daemon killed during a download, so its temporary copy remains, once with `[network]` set and once with
  the section removed before the restart
- **When:** a daemon starts on the instance
- **Then:** in both cases, once it reports ready, the temporary copy is gone

**Verification:** test — a service test that kills the daemon during a held download.

#### AC-016.7 — One download at a time

- **Given:** a download held part way
- **When:** a second client requests `GET /export`, and requests it again after the first download ends
- **Then:** its first attempt gets `409 busy` with the error body and the running download goes on; its second attempt
  gets the file

**Verification:** test — a service test on a loopback port.

#### AC-016.8 — Too little free space

- **Given:** a daemon whose free space reads under the database's size plus the margin, as the test arranges
- **When:** a client requests `GET /export`
- **Then:** it gets `409 conflict` with a message naming the space needed, and no temporary copy is made

**Verification:** test — a service test on a loopback port.

## Quality Requirements

### REQ-011 — Clients don't affect work

A client that stops reading a feed stream MUST be ended with `lagging` once more than 1000 deltas are undelivered
(S-002 REQ-015), counting deltas the listener has accepted but not yet written to the connection. For a stream of
several conversations, the count covers the whole connection. Neither a slow or
stalled connection nor any number of open connections delays an agent run, holds a worker thread or loses a
committed change.

#### AC-011.1 — A stalled HTTP reader

- **Given:** a conversation feed open over a listener whose client stops reading
- **When:** a run produces more than 1000 deltas
- **Then:** the stream is ended with `lagging`, the run finishes in the same time bound as with no subscriber, and its
  entries are the same

**Verification:** test — a service test with a client that pauses its socket.

### REQ-012 — No call cut short while running

While the daemon runs, the listeners' request and idle timeouts MUST be longer than the longest operation,
`submissions.wait` with its 5-minute maximum (S-002 REQ-012), and MUST NOT end an open feed stream that is still being
read. Shutdown follows REQ-010.

#### AC-012.1 — A full-length wait

- **Given:** a submission that doesn't settle
- **When:** a client calls `submissions.wait` with the 5-minute maximum over each listener
- **Then:** the call returns the current state at the wait's end rather than a timeout from the listener

**Verification:** test — a service test that reads both listeners' configured request and idle timeouts and checks
they exceed 5 minutes, and keeps a feed stream open past Node's default idle timeout.

### REQ-013 — Listeners use only the service layer

Listeners and the client library SHALL stay on the service layer as ADR-001 decision 2 states (S-002 REQ-016).

#### AC-013.1 — Imports

- **Given:** the listener and client library code
- **When:** a reviewer checks its imports
- **Then:** its imports follow ADR-001 decision 2

**Verification:** inspection — the import lists of the listener and client library modules.

### REQ-014 — No access checks, stated in the manual

No listener SHALL authenticate callers, refuse a call because of its `Origin`, `Host` or `Referer` header, or send
CORS headers (Exclusions). The user manual MUST state, where it describes `[network]`, that the network listener has
no authentication and no encryption, and that anyone who reaches its address can use The Intern with the service
account's access (ADR-002).

#### AC-014.1 — Calls answer whatever their headers

- **Given:** a ready daemon with both listeners
- **When:** operations are called with no credentials and with arbitrary `Origin` and `Host` headers
- **Then:** each answers as without those headers, and no response carries a CORS header

**Verification:** test — a service test.

#### AC-014.2 — The manual says so

- **Given:** the user manual
- **When:** a reviewer reads its `[network]` section
- **Then:** it states that there is no authentication and no encryption, and that anyone who reaches the address can
  use The Intern

**Verification:** inspection — `docs/manual/`.

## Configuration Requirements

- **Network listener.**
  - **What:** whether the network listener runs, and on which address and port (REQ-002).
  - **Where:** the `[network]` section of the configuration file, with the keys `address` and `port` (**Contract**:
    the section and key names). Hand-edited; settings operations keep it as written (REQ-015).
  - **Constraints:** `address` is an IP address or a host name of the machine (for example `0.0.0.0` for every
    interface on the LAN); `port` is an integer from 1 to 65535. Unknown keys in the section are refused (S-002
    REQ-021).
  - **Missing:** without the section, the network listener doesn't run. A section without `address` or `port`, or
    with an invalid value, stops startup naming the file, the key and the reason (S-002 REQ-021).
- **Free port (test only).**
  - **What:** lets tests run network listeners side by side without choosing ports (REQ-002).
  - **Where:** a test-only switch, like S-002's fake-model switch. It is not in the user manual and not in the
    configuration file.
  - **Constraints:** never enabled by default. The listener asks the operating system for a free port and logs it.
  - **Missing:** the configured port.
- **Local socket.**
  - **What:** where the local socket lives (REQ-001).
  - **Where:** `bob.sock` in the runtime directory, set by S-002 REQ-006 and its `--runtime-dir` flag; no setting of
    its own.
  - **Constraints:** owner-only; path within the platform's socket path limit.
  - **Missing:** always present.
- **Client library socket override.**
  - **What:** lets a client use another instance's socket, for development instances and tests (REQ-009).
  - **Where:** an option of the library; the Command line spec decides how `bob` exposes it.
  - **Missing:** the daemon's default socket.

Built-in constants, not configurable: the 10 MiB body limit (REQ-004), the 1000-delta lag bound (S-002 REQ-015) and the
export route's free-space margin (REQ-016).

## Assumptions and Dependencies

- **S-002** provides the catalogue with read and control marks, invocation by name with a caller, the observation
  feed with its end reasons, startup step 8, the shutdown order, readiness, the stop bound and the
  runtime directory. This spec relies on S-002 v0.7's amendments, made on the same planning branch: listeners refuse
  calls until ready (REQ-003), a job's origin is built from the caller (AC-012.5), and the configuration file keeps
  sections later specs add (REQ-021, REQ-022). T-094 closed the code's deviations from them.
- **S-001** records the team member's way in on seat records and messages (S-001 REQ-007); this spec supplies its
  value.
- **ADR-001** keeps pi-durable behind the host; **ADR-002** settles that no listener authenticates and that reach
  decides who is a team member. Both are accepted.
- **Node 24's built-in HTTP support** serves HTTP on a Unix socket and on TCP, and supports Server-Sent Events by
  streaming a response; browsers support `fetch` and event streams. The listeners add no dependency for this. ADR-006
  adds the dependencies for serving and drawing the web interface files.
- **Platform socket path limits** (about 104 bytes on macOS, 108 on Linux). The default runtime directories fit; long
  overridden paths may not (REQ-001).
- **S-006, the Web interface spec,** delivers the web interface files, and `/ui/` serves them from the package.
- **Assumption, confirmed by the product owner on 2026-11-01:** the team limits who reaches the network listener with
  its network setup, and security of the listeners is a later decision.

## Success Criteria

1. Every acceptance scenario of REQ-001 to REQ-016 passes in `npm test` on the fake model, with a temporary instance,
   a temporary socket and free loopback ports only.
2. One test calls every operation of the catalogue except `feed.subscribe` through both listeners and gets the same
   result as in-process (REQ-003); the feed's tests cover `feed.subscribe` (REQ-006). Measured by `npm test`.
3. With no `[network]` section, a ready daemon has no listening TCP socket (REQ-002). Measured by `npm test`.
4. Live check: `npm run test:live` starts the daemon over the service account's pi login, and the client library over
   the local socket submits a prompt to the lead conversation of a test job and follows the answer on the conversation
   feed until the run finishes (REQ-001, REQ-006, REQ-009).
5. Demonstration: with `[network]` set to the machine's LAN address and a fixed port, a browser on another computer of
   the LAN loads `/ui/` and a client there calls `daemon.status` (REQ-002, REQ-003, REQ-008).
6. The user manual documents `[network]` with the statement of REQ-014, and `npm run docs:build` succeeds.

## Implementation Order

| Phase | What | Depends On |
|---|---|---|
| 1 | Close the deviations from S-002 v0.7 (job origin from the caller, sections kept on settings writes, refusals before ready) | S-002 v0.7 |
| 2 | HTTP front and the local socket: operation routes from the catalogue, validation, error mapping, the way in, startup and shutdown | Phase 1 |
| 3 | The feed over Server-Sent Events, with the lag bound and shutdown ends | Phase 2 |
| 4 | The network listener: `[network]` settings, bind failures, the web interface files and the manual | Phases 2 and 3 |
| 5 | The client library for Node and the browser, the live check and the LAN demonstration | Phases 2 to 4 |
| 6 | One stream for several conversations, in the listeners and the client library | Phases 3 and 5 |
| 7 | The export route: the copy, its log line, owner-only temporary copies and their removal, one download at a time and the free-space refusal | Phases 4 and 5, S-004 `jobs.export` |

The Command line spec needs phase 5. The Web interface spec needs phases 5 to 7.

## Open Questions

None affect the specified behaviour.

## Amendment Log

| Date | What changed | Why | Affected tasks |
|------|-------------|-----|----------------|
| 2026-11-02 | v0.2. REQ-007: each listener passes the caller details it observes with the way in: the network listener the TCP peer's remote address and port, never a header such as `X-Forwarded-For`, and the local socket none beyond the way in (no OS account); a job created through a listener records them (new AC-007.3). AC-007.2: the refused origin claim is a `jobs.create` call, which creates no job and uses no number, and without the origin creates `C-n`. AC-003.1: observed caller details may differ between the three results. Design Principles, "Listeners are transports only": the caller is fixed by the listener and the connection. | S-004 architecture consistency review; product owner decisions 2026-11-02 (the OS account dropped). Driving ADR: ADR-001, amended 2026-11-02 for the job store. | None yet; the code changes (observed caller details, `jobs.create` in place of `jobs.startLead` in the tests) come in the S-004 breakdown |
| 2026-11-05 | Same version, format only; no requirement changed. Restructured to the ai-team 0.19.0 spec layout: `## Architecture` is gone and `## Alternatives Considered` is a top-level section holding solution alternatives only. The design principles are dropped: each is a requirement, its rationale or an implementation constraint already recorded elsewhere. The runtime-dependency principle moved to `docs/development/tech_stack.md`. All alternatives stay. | ai-team 0.20.0 upgrade; specs say what, the architecture documents and ADRs say how | T-185 |
| 2026-11-05 | v0.3. No behaviour changes (CR-001): implementation words leave the requirement text, and each REQ keeps its guarantee. Changed: REQ-001, AC-001.4, REQ-002, REQ-010 (start hooks, the harness), REQ-013, AC-013.1, with the copies in Consumed, Workflow and Assumptions. REQ-013 and AC-013.1 point to ADR-001 decision 2. No identifier added or retired. | CR-001, approved by the product owner. | T-202 (inspects AC-013.1); spec text otherwise |
| 2026-11-05 | v0.4. No behaviour changes. Assumptions, S-002: T-094 closed the code's deviations from the S-002 v0.7 amendments, in place of the statement that a task would investigate them. | spec-truth reconciliation: a stale assumption (D4). | None; spec text only |
| 2026-11-05 | spec-truth reconciliation — PASS | Work in 8e1eaa08..HEAD confirmed against v0.4; one stale assumption corrected; no requirement drift found; its task logs not read | none |
| 2026-11-06 | v0.5. Added the route `GET /export` to the Routes contract, with REQ-016, AC-016.1 to AC-016.8 and its Workflow lines; the Exclusion on new service operations names it. It answers on the network listener only and sends the copy S-004 REQ-016 defines. Its temporary copy is owner-only, goes when the download ends, at shutdown within the stop bound, and at the next start after a kill; one download runs at a time, a second gets `409 busy`, and too little free space gets `409 conflict`; AC-016.1's test allows for `busy` from `jobs.export`. REQ-009: the browser's download of `GET /export` is the one call outside the client library. Added one stream for several conversations, `GET /feed?scope=conversations`, composed by the listener from several `feed.subscribe` subscriptions with events naming their conversation (Interfaces, Workflow, REQ-006, new AC-006.4 and AC-006.5, REQ-009, new AC-009.4, REQ-010, REQ-011). S-002's feed isn't amended. Success Criteria 1 runs to REQ-016, and Implementation Order gains phases 6 and 7. No identifier retired. | S-006's export download: the product owner chose a browser download, and no route could return a file. S-006 architecture consistency review, findings F4, F6 and F7, product owner decision of 2026-11-06: plain HTTP allows a browser 6 connections per host across its tabs, and a stream per invoked conversation would use them up. Approved with S-006 at Gate 1. | Created with S-006's breakdown |
| 2026-11-07 | v0.6. No behaviour changes. Assumptions: ADR-006 added dependencies for the web interface files, so "No dependency is added" holds only for the listeners; S-006 has delivered the files that the placeholder wording awaited. AC-008.1's Verification drops the same wording. No identifier added or retired. | Spec-truth reconciliation of S-006, finding F13: stale text. | None; spec text only |
| 2026-11-07 | spec-truth reconciliation — FAIL | Export route and shared stream confirmed against v0.5; stale assumptions only | none |
