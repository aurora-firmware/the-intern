---
title: JS extension for pi-agent event forwarding
version: '0.3'
status: approved  # draft | review | approved | superseded
created: '2026-05-19'
author: planner
id: S-003
---

# JS extension for pi-agent event forwarding

## Purpose

S-001 Component 3 names the JS extension as a thin membrane inside every
pi-agent process that forwards runtime events to Monitoring and hosts the
blocking `tool_call` hook. This spec defines the **event-forwarding** half of
that membrane, and — per ADR-014 — the extension's role in skill *delivery*:
answering pi's resource-discovery event with a skill path bob resolved,
without reading or interpreting the content at that path. The blocking
`tool_call` hook is specified by S-004; skill *content* is specified by
S-010 and S-011.

Every supervised pi-agent session launched by `bob serve` is started with the
bob extension loaded from bob's resolved extension path. Every documented pi
event from each supervised session arrives on `extension.sock`, tagged with the
supervisor's session id, and is handed to Monitoring, which persists it as an
audit record (S-005) and logs it as a structured `tracing` line. If the extension file is missing at the resolved path,
bob fails closed and does not launch the pi-agent session.

Throughout this spec, **"bob service"** means the Rust binary `bob`
(the workspace under `the-intern/service/`) and **"bob extension"** means
the JS extension shipped as `the-intern/pi-extension/bob.ts`. They share
a name deliberately — the extension exists only to talk to the service —
but they are two distinct artifacts with different runtimes and lifecycles.
The bob extension's installed location is defined by the XDG layout in ADR-009:
`$XDG_DATA_HOME/bob/extensions/bob.ts`, falling back to
`~/.local/share/bob/extensions/bob.ts` on Linux. The path is overridable with the
top-level `config.toml` key `extension_path`.

## Exclusions

What this specification explicitly does NOT cover:

- **Blocking `tool_call` hook.** Specified by S-004. Authorization decisions, the `Authz` frame
  family already declared in `extension-ipc/src/framing.rs`, and any
  bidirectional verdict flow are S-001 Phase 4 work and out of scope here.
- **Agent skill content.** What the shipped skills *say* — triage policy,
  taxonomy, diary discipline, CLI reference — is out of scope here and belongs
  to S-010 and S-011. The extension's role is confined to *delivery*: it
  answers pi's resource-discovery event with a skill path bob resolved, and it
  neither reads nor interprets the content at that path (ADR-014). Skill
  delivery is therefore no longer independent of this spec, as this bullet
  previously stated; that independence held only while skills reached pi-agent
  through working-directory auto-discovery.
- **Monitoring subsystem.** How forwarded events are persisted, filtered,
  and tailed — the audit log, `bob audit tail`, and the inbound report
  interface — is S-005's contract. This spec delivers each event to
  Monitoring and stops there.
- **Attachment tracking and `sessions.list` enrichment.** Bob does not
  expose whether a given session has the extension loaded. Operators infer
  it from the presence (or absence) of that session's forwarded events in
  `bob audit tail` or the service log.
- **`extension.sock` schema changes.** The existing
  `InboundFrame::Event { session, payload }` / `OutboundFrame::*` schema
  is preserved verbatim. No new frame variants are added in Phase 3.
- **npm / pi package installation.** The extension is shipped as source under
  `the-intern/pi-extension/` and packaged into the release extension archive. This
  spec does not publish to npm, does not invoke pi's `pi install`, and does not
  vendor the pi-agent extension typings.
- **Backfilling or replaying events.** Events are forwarded only while
  the extension is connected; nothing is buffered for replay. Losing the
  connection to bob ends the session (see Design Principles), so there is no
  disconnected window to backfill.

## Architecture

### Design Principles

- **Bob owns extension delivery for supervised sessions.** A supervised `pi`
  session requires the bob extension because the same membrane forwards events
  and hosts the blocking `tool_call` authorization hook (S-004). Bob supplies
  the extension with `pi --extension <resolved path>` and fails closed when the
  file is missing.
- **One-way data flow in Phase 3** (history; S-004 later added the service → extension verdict path). Events travel pi → extension →
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
- **Degrade quietly without configuration; stop loudly without a transport.** No
  retries, no backoff, nothing that crashes pi or the bob service, and each
  failure is reported once. Three cases:
  - *Missing configuration* — `BOB_SESSION_ID` or `BOB_EXTENSION_SOCK_PATH`
    unset at load: one warning; the extension stays loaded as a no-op and
    never attempts a transport (see the Environment-variable contract).
  - *Transport lost* — the first connection fails, the connected socket
    closes, a write fails, or events queued before the connection is
    established exceed the backlog bound: the extension reports one error
    that names bob.service and tells the user to run `bob chat` again and
    `/resume`, fails any pending tool-call authorization closed (S-004), and
    shuts the pi session down. A session bob can no longer authorize or
    monitor does not keep running. The socket also closes when bob itself
    drops the connection (for example on a malformed frame); the extension
    cannot tell this apart, so the same error is shown although bob.service
    is still running.
  - *bob slow* — a connected socket that is only slow to drain: once the
    backlog bound is reached, the oldest queued events are dropped with one
    warning and the session continues. Tool-call authorization frames are
    kept in preference to events; only a backlog made entirely of them
    fails its oldest closed, and S-004's verdict timeout still applies.

  When the extension has no UI to report through, its warning or error goes
  to stderr; for a pool worker the supervisor forwards stderr to the service
  log (S-002), so the operator sees it there.
- **TypeScript, no build step.** Pi loads the extension via jiti, so the
  shipped source is `.ts` directly. No bundling or compilation pipeline is
  introduced in `the-intern/pi-extension/`.

### System Diagram

```
+---------------------------- bob serve (Rust) -----------------------------+
|                                                                          |
|   +-- pi-agent-supervisor actor --------------------------------------+   |
|   |   starts each pi child (one per session) with:                    |   |
|   |     S-002's pi-agent process settings (command, args,             |   |
|   |       --model, cwd, ...) -- not owned by this spec                |   |
|   |     plus the extension wiring this spec owns:                     |   |
|   |       --extension <resolved_extension_path>                       |   |
|   |       env BOB_SESSION_ID, BOB_EXTENSION_SOCK_PATH                 |   |
|   +-------------------------------------------------------------------+   |
|                                                                          |
|   +-- extension-ipc actor (owns extension.sock) ----------------------+   |
|   |   accepts UDS connections (filesystem-gated)                      |   |
|   |   parses InboundFrame::Event { session, payload }                 |   |
|   |   routes via multiplex.rs to MonitoringHandle::record_event       |   |
|   |   MonitoringHandle impl: Monitoring-backed (audit, S-005)         |   |
|   +-------------------------------------------------------------------+   |
+--------------------------------+-----------------------------------------+
                                 |  extension.sock (UDS, NDJSON)
                                 v
+---------------------------- pi-agent process ----------------------------+
|   pi <S-002 settings> --extension <resolved bob.ts path>                 |
|                                                                          |
|   +-- bob.ts (THE NEW EXTENSION) -------------------------+    |
|   |   default factory(pi: ExtensionAPI):                            |    |
|   |     - read process.env.BOB_SESSION_ID                           |    |
|   |     - read process.env.BOB_EXTENSION_SOCK_PATH                  |    |
|   |     - net.createConnection(sockPath)                            |    |
|   |     - for each documented pi event:                             |    |
|   |         pi.on(name, e => sock.write(NDJSON frame))              |    |
|   |     - missing env vars: warn once; stay a no-op                 |    |
|   |     - transport lost: error once; shut pi session down          |    |
|   +-----------------------------------------------------------------+    |
+--------------------------------------------------------------------------+
```

### Responsibility Separation

| Component | Responsibility | Notes |
|---|---|---|
| Pi-agent Supervisor actor | Starts every `pi` child with the pi-agent process settings S-002 defines, plus this spec's extension wiring: sets `BOB_SESSION_ID` and `BOB_EXTENSION_SOCK_PATH`; **passes `--extension <path>`** (CR-003) resolving to `$XDG_DATA_HOME/bob/extensions/bob.ts` or the `extension_path` override, failing closed if missing. Forwards pool workers' stderr to the service log (S-002), which is where the extension's warning or shutdown error surfaces for pool workers. | Existing actor; the rest of the command line — including `--model` — is S-002's |
| Extension-IPC actor | Unchanged transport-side; dispatches each event to the Monitoring-backed handle (S-005). | Existing actor from Phase 1a |
| Monitoring-backed event handle | Implements `MonitoringHandle::record_event`: hands each event to Monitoring, which persists it as an audit record (S-005), and emits one `tracing::info!` line with structured `session` and `event` fields. | Replaced the Phase 3 tracing-only `TracingMonitoringHandle`, which remains only as a test double |
| `bob.ts` (the bob extension) | Reads the env vars set by the bob service; opens the UDS; subscribes to every documented pi event; writes one NDJSON frame per event. With missing configuration, logs one warning and stays a no-op; when the transport to bob is lost, reports one error and shuts the pi session down (Design Principles). | New file under `the-intern/pi-extension/` |
| Operator (human) | Installs or points bob at `bob.ts` under `$XDG_DATA_HOME/bob/extensions/bob.ts` (override `extension_path`); bob supplies that path to pi via `pi --extension`. | Documented in `the-intern/pi-extension/README.md` and `the-intern/docs/` |

## Components

### Component 1: bob extension (`bob.ts`)

**Purpose:** Forward every documented pi event from one pi-agent process to
the bob service's `extension.sock`, tagged with the bob service's session
id for that pi-agent process.
**Estimated size:** Small. One TypeScript file plus a focused test suite.
The factory body is dominated by the static list of event names.
**Interfaces:**
- *Consumes:* `process.env.BOB_SESSION_ID` (string, required); `process.env.BOB_EXTENSION_SOCK_PATH` (filesystem path, required); `process.env.BOB_SKILL_INSTALL_PATH` (filesystem path, optional — see Environment-variable contract).
- *Consumes (pi API):* `ExtensionAPI.on(name, handler)` for every event name in the documented set; `ctx.ui.notify` at `warning` severity (missing configuration, slow drain) and at `error` severity (transport lost), with a stderr fallback when there is no UI; `ctx.shutdown()` to end the session when the transport is lost.
- *Produces:* one NDJSON line per event on the opened UDS, conforming to `InboundFrame::Event` (see Configuration Requirements → Wire contract).
- *Lifecycle:* the default factory runs synchronously at extension load; the socket is opened lazily on first event so a missing socket does not crash extension load.

### Component 2: Pi-agent Supervisor (extension and env-var wiring)

**Purpose:** Surface the bob service's session id, `extension.sock` path, and
resolved bob extension path to the pi-agent child process.
**Estimated size:** Small — command construction, configuration plumbing, and
tests covering the env vars, `--extension`, and fail-closed missing-file
behaviour.
**Interfaces:**
- *Consumes:* the session id the supervisor already allocates per spawn; the configured `extension.sock` path already resolved by the service shell (S-002); the resolved `extension_path` from `BobConfig`.
- *Produces:* `BOB_SESSION_ID` and `BOB_EXTENSION_SOCK_PATH` environment variables (both REQUIRED), plus `BOB_SKILL_INSTALL_PATH` (OPTIONAL, set only when the service's resolved skill install path is non-empty — `S-011`/`ADR-014`), plus `--extension <resolved path>` on the spawned pi process. No change to stdio framing or the `runRpcMode()` channel. These are the only parts of the pi command line and environment this spec owns; every other argument — `pi_agent_args`, `--model`, the working directory — comes from S-002's pi-agent process settings, and this spec does not restate them.

### Component 3: Event sink

**Purpose:** Make every event routed by `extension-ipc::multiplex`
observable. Phase 3 delivered a tracing-only `TracingMonitoringHandle`;
S-005 replaced it with a Monitoring-backed handle, so events are now also
persisted and tailable.
**Estimated size:** Tiny — one `MonitoringHandle` impl and its tests.
**Interfaces:**
- *Consumes:* `MonitoringEvent { session, payload }` from the existing
  multiplex.
- *Produces:* an audit record handed to Monitoring, shaped as S-005 defines;
  and one `tracing::info!` event per call with structured fields
  `session = <SessionId>` and `event = <string from payload.event>`, with the
  full payload optionally at `debug`.

### Component 4: Operator-facing installation documentation

**Purpose:** Give the operator a one-screen recipe for the extension's default
location and override, including the fail-closed missing-extension behaviour.
**Estimated size:** Tiny — a new `the-intern/pi-extension/README.md` section.
**Interfaces:**
- *Consumes:* nothing.
- *Produces:* documented default path (`~/.local/share/bob/extensions/bob.ts`), the
  `extension_path` override, and the env-var contract reproduced verbatim.

## Workflow

End-to-end flow from `bob serve` start to a forwarded event being recorded:

```
Operator starts bob serve
  ↓
Pi-agent Supervisor starts pi for a new session with S-002's pi-agent
process settings (for a pool worker: pi_agent_args, default --mode rpc, and
--model when pi_agent_model is set)
  → resolves extension_path
  → refuses to spawn if the file is absent
  → runs pi --extension <resolved path>
  → sets BOB_SESSION_ID + BOB_EXTENSION_SOCK_PATH on the child env
  ↓
the bob extension reads the two env vars and opens extension.sock
  → on success: subscribes to every documented pi event
  → env vars missing: logs one warning, stays a no-op for the session
  → transport lost (now or later in the session): reports one error, fails
    pending authorization closed, and shuts the pi session down
  ↓
pi emits an event (e.g. tool_call)
  ↓
the bob extension serialises and writes an InboundFrame::Event NDJSON line
  ↓
extension-ipc actor parses the frame and dispatches via multiplex
  ↓
the Monitoring-backed handle records the event as an audit record (S-005)
and emits a structured tracing::info line
  ↓
Operator observes the event in bob audit tail and the bob serve log
```

If no extension file exists at the resolved path, bob returns a clear
child-process error naming the expected path and does not start the pi-agent
session.

## Configuration Requirements

The Phase 3 deliverable rests on three configuration contracts.

### Environment-variable contract (Contract, not Example)

The supervisor MUST set `BOB_SESSION_ID` and `BOB_EXTENSION_SOCK_PATH` on
every `pi` child process it spawns; they are the sole communication channel
between the bob service and the bob extension at load time for event
forwarding and tool-call authorization. `BOB_SKILL_INSTALL_PATH` (added by
the 2026-08-09 amendment below) shares this same per-session environment
delivery mechanism but is OPTIONAL and governs a separate concern —
resource-discovery skill supply, not event forwarding or authorization —
per `S-011`/`ADR-014`.

- **`BOB_SESSION_ID`** — string, REQUIRED. The exact session id the
  supervisor uses internally for this pi-agent process. Format: the
  serialised form of `bob_core::types::SessionId` already produced by the
  supervisor (a UUID per current implementation). The extension uses this
  value verbatim as the `session` field in every outbound frame; the bob
  service's multiplex routes by exact match.
- **`BOB_EXTENSION_SOCK_PATH`** — string, REQUIRED. Absolute path to the
  service's `extension.sock`. Same value the `extension-ipc` actor binds
  to. The extension opens a UDS to this path.
- **`BOB_SKILL_INSTALL_PATH`** — string, OPTIONAL (unlike the two variables
  above). Absolute path to the service's resolved skill install location
  (`ADR-009` `data` bucket default, or the configured `skill_install_path`
  override — `S-002`). Set only when the resolved path is non-empty; the
  supervisor MUST omit the variable entirely, not set it empty, when there
  is nothing to supply. The extension answers pi's `resources_discover`
  event with this path when present. This variable carries no bearing on
  event forwarding or the `tool_call` authorization hook.

When `BOB_SESSION_ID` or `BOB_EXTENSION_SOCK_PATH` is missing the bob
extension MUST log one warning line and remain loaded as a no-op for the
rest of the session. The bob service MUST NOT fail to spawn pi when it
cannot resolve a value for either variable; instead it falls back to not
setting that variable, which produces the same operator-visible "no events"
outcome. When `BOB_SKILL_INSTALL_PATH` is absent, empty, or names a path
that does not exist, the extension MUST contribute no skill paths and log
one warning, without affecting event forwarding or authorization — this is
a materially different (fail-open, non-fatal-to-the-session's-core-purpose)
failure mode from the two REQUIRED variables, reflecting that skill supply
is instructional content rather than the monitoring/authorization membrane
(`ADR-014` §4).

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

Every forwarded event MUST be handed to Monitoring, which persists it as
S-005 defines. The extension-IPC side MUST also emit exactly one
`tracing::info!` per event, with structured fields `session` (rendered as the
`SessionId` `Display`) and `event` (the string from `payload.event`); the
full payload MAY be attached at `tracing::debug`. What the audit record
contains, how it is filtered, and how it is tailed are S-005's contract, not
this spec's.

### Install paths

The extension is delivered as source and lives at bob's default location:

- `$XDG_DATA_HOME/bob/extensions/bob.ts` (→ `~/.local/share/bob/extensions/bob.ts`),
  overridable by the `config.toml` key `extension_path`.

bob supplies this path to pi via `pi --extension <path>` and fails closed if the
file is absent. The release workflow packages the source extension as
`the-intern-bob-extension-<tag>.tar.gz`; placing `bob.ts` at the default path is
an operator installation step unless `extension_path` points elsewhere.

## Implementation Order

| Phase | What | Depends On |
|---|---|---|
| 1 | `the-intern/pi-extension/` Node project skeleton: `package.json` with dev-deps on `@earendil-works/pi-coding-agent` types and `@types/node`; `tsconfig.json`; a test runner (vitest or `node --test`); a `the-intern/pi-extension/README.md` covering the env-var contract and install paths. No runtime dependencies. | Nothing |
| 2 | Author `bob.ts` — the default factory, env-var read, UDS connect, per-event subscriptions, one-shot warning behaviour (failure handling since amended — see Design Principles). Ships with a unit test that round-trips at least one event over a real UDS in a temp dir, asserting the frame shape against `InboundFrame::Event`. | Phase 1 |
| 3 | Pi-agent supervisor: set `BOB_SESSION_ID` and `BOB_EXTENSION_SOCK_PATH` on every spawned `pi` child. Unit test asserts the env keys are present on the `Command`. | Nothing (parallel-safe with Phases 1 and 2) |
| 4 | Swap `NoopMonitoringHandle` for a new `TracingMonitoringHandle` in `bob::serve`'s extension-ipc wiring (superseded by S-005's Monitoring-backed handle). Unit test asserts the tracing event shape (using `tracing_test` or equivalent). | Phase 3 not required, but Phase 4 should be merged after Phase 2 so the e2e log line is verifiable. |

The spec-breakdown skill will turn each phase into one or more atomic
tasks. All four phases are intentionally small; the total surface should
be one TypeScript file plus around fifty lines of Rust changes spread
across the supervisor and `bob::serve`.

## Amendment Log

| Date | What changed | Why | Affected tasks |
|------|-------------|-----|----------------|
| 2026-06-13 | System diagram updated: the `extension-ipc` actor "accepts UDS connections (perms + SO_PEERCRED)" is now "accepts UDS connections (filesystem-gated)". | ADR-005 (accepted 2026-05-22) made filesystem permissions the sole connection gate and demoted `SO_PEERCRED` to audit; this diagram label was never updated. PR #22 reconciles the artifact set. | None (documentation reconciliation). |
| 2026-06-23 | Bob now owns and supplies the extension by path (`pi --extension`), default `$XDG_DATA_HOME/bob/extensions/bob.ts` (override `extension_path`), required and fail-closed. The obsolete pi-discovery-path model was removed from the active spec text. | CR-003 (depends on ADR-009 layout; the extension is the S-004 authz membrane so it must load). | T-100, T-101, T-102, T-108 |
| 2026-08-01 | Exclusions' "Agent skills" bullet corrected: skills were never bundled with Phase 4/the extension; they reach pi-agent via cwd-relative auto-discovery (ADR-012 §7), delivered concretely by S-010. | Architecture Consistency Review of S-010 found this bullet stale against ADR-012 §7 and against S-001's corrected Component 3 (2026-08-01 amendment). | None (documentation reconciliation). |
| 2026-08-06 | Exclusions' "Agent skills" bullet replaced by "Agent skill *content*": the extension now supplies skill paths to pi by answering pi's resource-discovery event, so skill *delivery* is no longer independent of this spec. Skill *content* remains out of scope (S-010, S-011). | ADR-014 accepted 2026-08-06. The 2026-08-01 amendment's "independent of the extension" claim held only while skills reached pi through cwd-relative auto-discovery. This is a scope amendment, not a wording correction: the extension gains a delivery responsibility this spec previously disclaimed. | S-011 breakdown tasks (Gate 2 pending). |
| 2026-08-09 | Environment-variable contract extended with a third variable, `BOB_SKILL_INSTALL_PATH` (OPTIONAL, fail-open, distinct from the two REQUIRED variables), and Components 1/2's Interfaces updated to match. The contract's "sole communication channel" framing is now scoped to event forwarding and authorization specifically, since the new variable governs a separate concern (resource-discovery skill supply) delivered over the same per-session environment mechanism. | Gate 2 preflight on the S-011 task breakdown (T-158/T-160) found this spec's closed two-variable enumeration would contradict the shipped contract once those tasks land, mirroring the reconciliation S-002 already made on 2026-08-06 for the same ADR-014/S-011 decision. | T-158, T-160 (pending). |
| 2026-09-28 | Two changes. (1) The supervisor's spawn is no longer restated here as a full command line: the system diagram, the Responsibility table's supervisor row, Component 2's "Produces", and the workflow now state that pi starts with S-002's pi-agent process settings (including `--model` when `pi_agent_model` is set) plus the extension wiring this spec owns (`--extension` and the `BOB_*` environment variables), and that the supervisor forwards pool workers' stderr to the service log — where the extension's single degradation warning surfaces when it has no UI (Design Principles). (2) Directory paths updated from `the-intern/extensions/` to `the-intern/pi-extension/`. | (1) CR-015 and its Architecture Consistency Review (2026-09-28), which found four places here listing the full pi command line that `--model` would have made incomplete; pointing to S-002 instead of adding `--model` four times removes the duplication that caused the gap. (2) Documentation reconciliation: the directory was renamed in commit `416035e`, and this spec's paths were never updated. | Tasks TBD (CR-015 breakdown pending); (2) none |
| 2026-09-29 | Two reconciliations with already-shipped, already-decided behaviour. (1) **Event sink:** the Purpose, Exclusions, diagram, Responsibility table, Component 3 (renamed "Event sink"), workflow, and Sink contract no longer describe the Phase 3 tracing-only `TracingMonitoringHandle` as current: each forwarded event is handed to Monitoring and persisted as an audit record per S-005, and still logged as one `tracing::info!` line; the record's content, filtering, and tailing are S-005's contract. (2) **Losing bob:** the "Quiet degradation, loud once" principle is replaced by three cases — missing configuration (one warning, no-op, no transport attempted — unchanged), transport lost (connect failure, socket close — including bob itself dropping the connection, which the extension cannot distinguish — write failure, or pre-connect backlog overflow: one error naming bob.service and pointing to `bob chat` + `/resume`, pending tool-call authorization failed closed, pi session shut down), and bob slow (post-connect backlog: oldest events dropped with one warning, session continues, authorization frames preferred). The Exclusions' backfill bullet, the bob.ts diagram box, the bob.ts Responsibility row, and the workflow now match. The Environment-variable contract is unchanged. Follow-ups from the review: Component 1's pi-API interface now lists `ctx.ui.notify` at both severities and `ctx.shutdown()`; the supervisor row says the extension's warning *or shutdown error* surfaces in the service log; the "One-way data flow" principle, the tool_call Exclusion, and Implementation Order phases 2 and 4 are marked as history superseded by S-004/S-005. | (1) S-005 (approved) explicitly replaced the Phase 3 tracing-only sink and wired extension events into persistent audit records; S-003 was never updated. (2) GitHub issue #112 (fixed by PR #113, merged 2026-09-22) changed transport-loss behaviour from a silent no-op to a loud shutdown without amending this spec, leaving its principle contradicted by shipped code. Recorded here with human approval (2026-09-29) and an Architecture Consistency Review; process rule adopted: GitHub issue fixes must conform to approved specs and ADRs or escalate as blocking. | None (reconciliation with shipped behaviour) |
