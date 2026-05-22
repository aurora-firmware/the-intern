---
title: JS extension for pi-agent event forwarding
version: '0.1'
status: approved  # draft | review | approved | superseded
created: '2026-05-19'
author: planner
id: S-003
---

# JS extension for pi-agent event forwarding

## Purpose

S-001 Component 3 names the JS extension as a thin membrane inside every
pi-agent process that forwards runtime events to Monitoring and hosts the
blocking `tool_call` hook. Today the supervisor (S-001 Phase 2, delivered by
T-031 through T-036) spawns `pi` without an extension wired in: no events
leave the agent process, and `extension.sock` only ever sees zero
connections. Phase 3 closes that gap for the **event-forwarding** half of
Component 3 only — the blocking `tool_call` hook and agent skills are
deferred to Phase 4.

When this spec is delivered, an operator who installs the shipped bob
extension into their `pi` setup will see every documented pi event from
each `bob serve`-managed session arrive on `extension.sock`, tagged with
the supervisor's session id, and recorded as a structured `tracing` log
line on the bob service side. An operator who does **not** install the
bob extension sees `bob serve` run unchanged: prompts still reach pi over
`runRpcMode()`, tool calls still execute, and no observability is added.

Throughout this spec, **"bob service"** means the Rust binary `bob`
(the workspace under `the-intern/service/`) and **"bob extension"** means
the JS extension shipped as `the-intern/extensions/bob.ts`. They share
a name deliberately — the extension exists only to talk to the service —
but they are two distinct artifacts with different runtimes, lifecycles,
and install paths.

## Exclusions

What this specification explicitly does NOT cover:

- **Blocking `tool_call` hook.** Authorization decisions, the `Authz` frame
  family already declared in `extension-ipc/src/framing.rs`, and any
  bidirectional verdict flow are S-001 Phase 4 work and out of scope here.
- **Agent skills (S-001 Component 3, third bullet).** Providing pi-agent
  with skills is bundled with Phase 4 alongside the authorization hook.
- **Monitoring subsystem.** The append-only audit log, the inbound report
  interface, and any admin-RPC subscription for events (`events.tail` or
  similar) are S-001 Phase 5 work. Phase 3 sinks events to `tracing` only.
- **Attachment tracking and `sessions.list` enrichment.** Bob does not
  expose whether a given session has the extension loaded. Operators infer
  it from the presence (or absence) of `tracing` event lines for that
  session.
- **`extension.sock` schema changes.** The existing
  `InboundFrame::Event { session, payload }` / `OutboundFrame::*` schema
  is preserved verbatim. No new frame variants are added in Phase 3.
- **Extension delivery and packaging.** The extension is published only as
  source under `the-intern/extensions/`. Phase 3 does not publish to npm,
  does not produce a build artifact, does not invoke pi's `pi install`,
  and does not vendor the pi-agent extension typings.
- **Bob-side discovery of the extension.** Bob does **not** pass
  `--extension`/`-e` to `pi`. The extension is installed into the
  operator's pi extension search path independently (see Configuration
  Requirements). No bob service configuration key for extension discovery
  is added.
- **Backfilling or replaying events.** Events are forwarded only while
  the extension is connected. Lost-connection windows are dropped silently
  (after a single warning), not buffered.

## Architecture

### Design Principles

- **The bob service runs without the bob extension.** Every Rust-side
  component must function when no bob extension is installed in the
  operator's pi. Phase 3 introduces no hard runtime dependency on the
  extension being present.
- **One-way data flow in Phase 3.** Events travel pi → extension →
  service. No service → extension messaging is added in this phase; the
  `OutboundFrame` family is touched only insofar as Phase 4 will use it
  later.
- **Wire schema is frozen.** Each forwarded event is encoded as an existing
  `InboundFrame::Event { session, payload }`. Event-specific shape lives
  inside `payload`, not as a new frame variant.
- **The bob service owns the session id.** The supervisor allocates the
  session id and passes it to the pi-agent child process via the
  environment. The bob extension does not generate, mint, or guess
  session ids.
- **Quiet degradation, loud once.** Every failure mode in the bob
  extension (missing env vars, unreachable socket, write error mid-session)
  results in a single warning log line and a silent no-op for the
  remainder of the session. No retries, no exponential backoff, no error
  propagation that would crash pi or the bob service.
- **TypeScript, no build step.** Pi loads the extension via jiti, so the
  shipped source is `.ts` directly. No bundling or compilation pipeline is
  introduced in `the-intern/extensions/`.

### System Diagram

```
+---------------------------- bob serve (Rust) -----------------------------+
|                                                                          |
|   +-- pi-agent-supervisor actor --------------------------------------+   |
|   |   spawn(session_id) ->                                            |   |
|   |       Command::new("pi")                                          |   |
|   |           .arg("--mode rpc")                                      |   |
|   |           .env("BOB_SESSION_ID", session_id)                      |   |
|   |           .env("BOB_EXTENSION_SOCK_PATH", extension_sock_path)    |   |
|   +-------------------------------------------------------------------+   |
|                                                                          |
|   +-- extension-ipc actor (owns extension.sock) ----------------------+   |
|   |   accepts UDS connections (perms + SO_PEERCRED)                   |   |
|   |   parses InboundFrame::Event { session, payload }                 |   |
|   |   routes via multiplex.rs to MonitoringHandle::record_event       |   |
|   |   MonitoringHandle impl: TracingMonitoringHandle  <--- NEW        |   |
|   +-------------------------------------------------------------------+   |
+--------------------------------+-----------------------------------------+
                                 |  extension.sock (UDS, NDJSON)
                                 v
+---------------------------- pi-agent process ----------------------------+
|   pi --mode rpc (one per session)                                        |
|   loads extensions via pi's own discovery                                |
|     ~/.pi/agent/extensions/*.ts  OR  .pi/extensions/*.ts                 |
|                                                                          |
|   +-- bob.ts (THE NEW EXTENSION) -------------------------+    |
|   |   default factory(pi: ExtensionAPI):                            |    |
|   |     - read process.env.BOB_SESSION_ID                           |    |
|   |     - read process.env.BOB_EXTENSION_SOCK_PATH                  |    |
|   |     - net.createConnection(sockPath)                            |    |
|   |     - for each documented pi event:                             |    |
|   |         pi.on(name, e => sock.write(NDJSON frame))              |    |
|   |     - on any failure: ui.warn once; flag transport dead         |    |
|   +-----------------------------------------------------------------+    |
+--------------------------------------------------------------------------+
```

### Responsibility Separation

| Component | Responsibility | Notes |
|---|---|---|
| Pi-agent Supervisor actor | Sets `BOB_SESSION_ID` and `BOB_EXTENSION_SOCK_PATH` on every `pi` child. Does **not** pass `-e`. | Existing actor; small addition to `spawn` |
| Extension-IPC actor | Unchanged transport-side. The `MonitoringHandle` it dispatches events to is the only swap. | Existing actor from Phase 1a |
| `TracingMonitoringHandle` | Implements `MonitoringHandle::record_event`; emits one `tracing::info!` per inbound event with structured `session` and `event` fields. | New, replaces `NoopMonitoringHandle` in `bob::serve` wiring |
| `bob.ts` (the bob extension) | Reads the env vars set by the bob service; opens the UDS; subscribes to every documented pi event; writes one NDJSON frame per event. Logs one warning and degrades to no-op on any failure. | New file under `the-intern/extensions/` |
| Operator (human) | Installs the shipped `bob.ts` into their pi extension search path. Optional — the bob service works without it. | Documented in `the-intern/extensions/README.md` |

## Components

### Component 1: bob extension (`bob.ts`)

**Purpose:** Forward every documented pi event from one pi-agent process to
the bob service's `extension.sock`, tagged with the bob service's session
id for that pi-agent process.
**Estimated size:** Small. One TypeScript file plus a focused test suite.
The factory body is dominated by the static list of event names.
**Interfaces:**
- *Consumes:* `process.env.BOB_SESSION_ID` (string, required); `process.env.BOB_EXTENSION_SOCK_PATH` (filesystem path, required).
- *Consumes (pi API):* `ExtensionAPI.on(name, handler)` for every event name in the documented set; `ctx.ui` (or stderr fallback) for the single warning line.
- *Produces:* one NDJSON line per event on the opened UDS, conforming to `InboundFrame::Event` (see Configuration Requirements → Wire contract).
- *Lifecycle:* the default factory runs synchronously at extension load; the socket is opened lazily on first event so a missing socket does not crash extension load.

### Component 2: Pi-agent Supervisor (env-var wiring)

**Purpose:** Surface the bob service's session id and `extension.sock`
path to the pi-agent child process so an installed bob extension can use
them.
**Estimated size:** Tiny — two lines added to the `pi` `Command` builder
in the existing supervisor crate, plus tests covering the env set.
**Interfaces:**
- *Consumes:* the session id the supervisor already allocates per spawn; the configured `extension.sock` path already resolved by the service shell (S-002).
- *Produces:* environment variables on the spawned pi process. No new CLI flags, no change to stdio framing, no change to the `runRpcMode()` channel.

### Component 3: `TracingMonitoringHandle`

**Purpose:** Replace `NoopMonitoringHandle` so that events routed by
`extension-ipc::multiplex` are observable in the service log.
**Estimated size:** Tiny — one struct, one `MonitoringHandle` impl, one
unit test asserting the log emission shape.
**Interfaces:**
- *Consumes:* `MonitoringEvent { session, payload }` from the existing
  multiplex.
- *Produces:* one `tracing::info!` event per call with structured fields
  `session = <SessionId>`, `event = <string from payload.event>`,
  optionally `payload = ?` at `debug` for full content.

### Component 4: Operator-facing installation documentation

**Purpose:** Give the operator a one-screen recipe for getting the
extension into their pi setup, including the offline / no-extension case.
**Estimated size:** Tiny — a new `the-intern/extensions/README.md`
section.
**Interfaces:**
- *Consumes:* nothing.
- *Produces:* documented install paths (`~/.pi/agent/extensions/`,
  `.pi/extensions/`) and the env-var contract reproduced verbatim so an
  operator can verify the extension out-of-tree.

## Workflow

End-to-end flow from `bob serve` start to a forwarded event being logged:

```
Operator starts bob serve
  ↓
Pi-agent Supervisor spawns "pi --mode rpc" for a new session
  → sets BOB_SESSION_ID + BOB_EXTENSION_SOCK_PATH on the child env
  ↓
pi loads its discovered extensions (★ operator-controlled);
   if bob.ts is installed, its factory runs
  ↓
the bob extension reads the two env vars and opens extension.sock
  → on success: subscribes to every documented pi event
  → on failure: logs one warning, becomes a no-op for the session
  ↓
pi emits an event (e.g. tool_call)
  ↓
the bob extension serialises and writes an InboundFrame::Event NDJSON line
  ↓
extension-ipc actor parses the frame and dispatches via multiplex
  ↓
TracingMonitoringHandle::record_event emits a structured tracing::info line
  ↓
Operator observes the line in the bob serve log
```

A pi-agent process whose pi has no `bob.ts` installed completes
the workflow as far as the spawn step and then runs unmodified — pi never
calls into any extension, no socket connection happens, no log line
appears. The bob service's other functionality is unaffected.

## Configuration Requirements

The Phase 3 deliverable rests on three configuration contracts.

### Environment-variable contract (Contract, not Example)

The supervisor MUST set these on every `pi` child process it spawns. They
are the sole communication channel between the bob service and the bob
extension at load time.

- **`BOB_SESSION_ID`** — string, REQUIRED. The exact session id the
  supervisor uses internally for this pi-agent process. Format: the
  serialised form of `bob_core::types::SessionId` already produced by the
  supervisor (a UUID per current implementation). The extension uses this
  value verbatim as the `session` field in every outbound frame; the bob
  service's multiplex routes by exact match.
- **`BOB_EXTENSION_SOCK_PATH`** — string, REQUIRED. Absolute path to the
  service's `extension.sock`. Same value the `extension-ipc` actor binds
  to. The extension opens a UDS to this path.

When either variable is missing the bob extension MUST log one warning
line and remain loaded as a no-op for the rest of the session. The bob
service MUST NOT fail to spawn pi when it cannot resolve a value for
either variable; instead it falls back to not setting that variable,
which produces the same operator-visible "no events" outcome.

### Wire contract (Contract, not Example)

Each forwarded event MUST be a single NDJSON line matching the existing
`InboundFrame::Event` variant:

- `kind` — literal string `"event"`.
- `session` — string, the value of `BOB_SESSION_ID`.
- `payload` — JSON object with at least:
  - `event` — string, the pi event name as documented at
    https://pi.dev/docs/latest/extensions (e.g. `"session_start"`,
    `"tool_call"`, `"message_end"`).
  - `data` — JSON object, the pi event object passed by `pi.on(...)`,
    serialised verbatim with `JSON.stringify`. Fields are not renamed,
    redacted, or filtered in Phase 3.

The extension MUST register a handler for every event name documented by
pi at the time the spec is implemented. Discovering the canonical list is
part of the breakdown task (the spec-breakdown skill is expected to call
out a verification step against the live pi docs).

The Rust side MUST NOT introduce any new frame variant or rename
existing fields. `framing.rs::InboundFrame::Event` is the contract.

### Sink contract

`TracingMonitoringHandle::record_event` MUST emit exactly one
`tracing::info!` per call. Required structured fields: `session` (rendered
as the `SessionId` `Display`), `event` (the string from
`payload.event`). The full payload MAY be attached at `tracing::debug`.
No file output, no in-memory buffer, no admin-RPC fan-out.

### Install paths

The extension is delivered as source. Installation paths it must work
under:

- `~/.pi/agent/extensions/bob.ts` (per-user, global to all
  projects)
- `<project>/.pi/extensions/bob.ts` (project-local)

These are pi's own discovery directories; the bob service is not involved
in extension delivery.

## Implementation Order

| Phase | What | Depends On |
|---|---|---|
| 1 | `the-intern/extensions/` Node project skeleton: `package.json` with dev-deps on `@earendil-works/pi-coding-agent` types and `@types/node`; `tsconfig.json`; a test runner (vitest or `node --test`); a `the-intern/extensions/README.md` covering the env-var contract and install paths. No runtime dependencies. | Nothing |
| 2 | Author `bob.ts` — the default factory, env-var read, UDS connect, per-event subscriptions, one-shot warning behaviour. Ships with a unit test that round-trips at least one event over a real UDS in a temp dir, asserting the frame shape against `InboundFrame::Event`. | Phase 1 |
| 3 | Pi-agent supervisor: set `BOB_SESSION_ID` and `BOB_EXTENSION_SOCK_PATH` on every spawned `pi` child. Unit test asserts the env keys are present on the `Command`. | Nothing (parallel-safe with Phases 1 and 2) |
| 4 | Swap `NoopMonitoringHandle` for a new `TracingMonitoringHandle` in `bob::serve`'s extension-ipc wiring. Unit test asserts the tracing event shape (using `tracing_test` or equivalent). | Phase 3 not required, but Phase 4 should be merged after Phase 2 so the e2e log line is verifiable. |

The spec-breakdown skill will turn each phase into one or more atomic
tasks. All four phases are intentionally small; the total surface should
be one TypeScript file plus around fifty lines of Rust changes spread
across the supervisor and `bob::serve`.

## Amendment Log

<!-- Optional. Use when an approved spec is amended after tasks are in flight.
| Date | What changed | Why | Affected tasks |
|------|-------------|-----|----------------|
| YYYY-MM-DD | Description of change | Reason for amendment | T-XXX, T-YYY |
-->
