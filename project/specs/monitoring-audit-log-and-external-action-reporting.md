---
title: Monitoring audit log and external action reporting
version: '0.1'
status: approved  # draft | review | approved | superseded
created: '2026-05-20'
author: planner
id: S-005
---

# Monitoring audit log and external action reporting

## Purpose

S-001 Phase 5 requires Monitoring to provide an append-only audit log and an
inbound report interface for external action CLIs. Today Monitoring is only a
scaffold: Phase 3 forwards pi-agent extension events to a tracing sink, and
Phase 4 can produce policy verdict observability, but there is no persistent
audit trail, no canonical audit record model, no live audit subscription backed
by Monitoring, and no way for external tools to report the action outcome they
performed.

This phase matters before S-001 Phase 7 because action CLIs need a stable
reporting contract before skills can safely describe side-effecting tools to the
agent. When this spec is delivered, extension events, policy verdicts, and
external tool reports are normalized by the Monitoring subsystem, appended to a
persistent JSONL audit log, and optionally surfaced through `bob audit tail`
according to operator-configured and CLI-supplied filters.

## Exclusions

What this specification explicitly does NOT cover:

- **Dedicated reporting socket.** External action CLIs report through
  `admin.sock`; no `report.sock` or third UDS is introduced in v1.
- **SQLite or database-backed audit storage.** The persistent audit log is a
  JSONL file. Indexed storage, migrations, compaction, and query planning are
  later storage-backend work.
- **Point-in-time audit queries.** Phase 5 exposes live tailing only. Listing
  records by session, time range, action id, or cursor belongs to a later query
  spec.
- **Report correlation tokens.** Same-UID/admin-socket access is sufficient
  authentication for `report.submit` in v1. Reports are not required to carry a
  bob-issued token tying them to a previously authorized action.
- **Arbitrary tool-defined metadata.** External action reports accept only the
  structured JSON fields defined by bob. Tool-specific free-form metadata is
  excluded to keep the audit schema reviewable.
- **Deletion, redaction, or retention workflows.** Monitoring appends records
  and tails records. Erasing, redacting, rotating, compressing, or expiring
  audit history is not part of this spec.
- **Changing policy semantics.** Policy verdict generation and authorization
  rules are S-004 work. Phase 5 only records verdict records emitted by that
  path.

## Architecture

### Design Principles

- **Monitoring owns audit behaviour.** Admin-RPC is a transport facade; it
  does not normalize records, apply audit filters, or own persistence state.
- **Append first, tail second.** Audit filtering controls what appears in live
  tail streams, not what is persisted. Accepted records are written to disk
  even when their kind is hidden from `bob audit tail`.
- **One canonical envelope.** Extension events, policy verdicts, and external
  tool reports share a common `AuditRecord` envelope with a `kind`, timestamp,
  optional session id, and kind-specific payload.
- **Durable by default.** A record is considered accepted only after it is
  appended to the persistent JSONL log or queued behind bounded, observable
  backpressure with a flush guarantee during graceful shutdown.
- **Local trust follows admin.sock.** `report.submit` relies on the existing
  admin socket filesystem-permission and peer-credential gate. The report body
  carries attribution, not authentication.
- **Schema beats blobs.** External tool reports use bob-defined structured
  fields so review, rendering, and later querying can rely on stable shapes.

### System Diagram

```
+----------------------------- bob serve ------------------------------+
|                                                                       |
|  extension-ipc ---- event records -----+                              |
|                                        |                              |
|  policy-control ---- verdict records --+--> Monitoring actor          |
|                                        |      - normalize envelope    |
|  admin-rpc report.submit -- reports ---+      - append JSONL          |
|                                               - fan out live tails    |
|                                                        ^              |
|                                                        |              |
|  admin-rpc audit.tail <--------- subscription handle ---+              |
+-------------^------------------------------+--------------------------+
              |                              |
              | admin.sock                   | JSONL audit file
              | same-UID peer gate           v
       external action CLI             persistent audit log
       bob audit tail
```

### Responsibility Separation

| Component | Responsibility | Notes |
|---|---|---|
| Monitoring actor | Owns audit record normalization, accepted-kind validation, JSONL append, and live tail fan-out | The canonical subsystem for Phase 5 |
| Audit log store | Appends canonical records to a persistent JSONL file and flushes on shutdown | Storage is deliberately simple and append-only |
| Tail registry | Tracks live `audit.tail` subscribers and applies tail visibility filters | Filtering affects live delivery only |
| Admin-RPC facade | Exposes `report.submit` and `audit.tail` over `admin.sock` | Enforces existing socket auth, then delegates to Monitoring |
| Extension-IPC integration | Sends forwarded pi events to Monitoring instead of only tracing them | Builds on S-003 frame handling |
| Policy integration | Emits policy verdict audit records to Monitoring | Builds on S-004 verdict paths |
| `bob audit tail` client | Subscribes to `audit.tail`, renders records, and accepts optional kind filters | No point queries in v1 |

## Components

### Component 1: Audit record model

**Purpose:** Define the canonical envelope and kind-specific payloads for extension events, policy verdicts, and external tool reports.
**Estimated size:** Medium.
**Interfaces:** Exposes bob-core domain types consumed by Monitoring, Admin-RPC, extension-ipc, policy-control, and the CLI renderer.

### Component 2: Monitoring actor

**Purpose:** Accept audit inputs, persist canonical records, and publish records to live subscribers.
**Estimated size:** Medium.
**Interfaces:** Exposes a Monitoring handle for `record_event`, `record_verdict`, `submit_report`, and `subscribe_tail`; consumes the audit log store and monitoring config.

### Component 3: JSONL audit log store

**Purpose:** Persist accepted audit records as one serialized JSON object per line.
**Estimated size:** Small.
**Interfaces:** Consumes canonical `AuditRecord`s from Monitoring; exposes append and shutdown-flush behaviour.

### Component 4: Admin-RPC monitoring methods

**Purpose:** Add the v1 public monitoring surface on `admin.sock`.
**Estimated size:** Small.
**Interfaces:** Exposes `report.submit` and `audit.tail`; delegates to Monitoring after the existing admin peer gate accepts the connection.

### Component 5: `bob audit tail`

**Purpose:** Let an operator watch live audit records from the terminal.
**Estimated size:** Small.
**Interfaces:** Consumes the `audit.tail` admin-RPC subscription; renders human-readable output by default and JSON with the existing `--json` convention.

### Component 6: Runtime integrations

**Purpose:** Route extension events and policy verdicts into Monitoring.
**Estimated size:** Small.
**Interfaces:** Replaces the Phase 3 tracing-only monitoring sink and wires S-004 verdict emission into the Monitoring handle.

## Workflow

Forwarded pi event:

```
pi-agent emits an event
  ↓
bob.ts forwards the event on extension.sock
  ↓
extension-ipc parses the frame and calls Monitoring
  ↓
Monitoring wraps it as kind = "event"
  ↓
Monitoring appends the record to JSONL
  ↓
Monitoring delivers it to matching live tail subscribers
```

Policy verdict:

```
pre-flight or tool_call authorization path produces a verdict
  ↓
policy integration calls Monitoring with the verdict summary
  ↓
Monitoring wraps it as kind = "verdict"
  ↓
record is appended to JSONL and delivered to matching live tails
```

External action report:

```
external action CLI connects to admin.sock
  ↓
admin-rpc enforces filesystem permissions and peer credentials
  ↓
CLI sends report.submit with bob-defined structured fields
  ↓
admin-rpc delegates to Monitoring
  ↓
Monitoring validates and wraps it as kind = "report"
  ↓
record is appended to JSONL and delivered to matching live tails
```

Operator tail:

```
operator runs bob audit tail [--filter <kind> ...]
  ↓
client opens admin.sock and subscribes through audit.tail
  ↓
Monitoring registers a live subscriber with the effective filters
  ↓
matching future records stream until disconnect or service shutdown
```

## Configuration Requirements

### Audit log path

- **What:** path to the JSONL audit log file. **Why:** Phase 5 requires
  persistent logs across service restarts.
- **Where:** bob's TOML config under the monitoring section, following ADR-002.
- **Constraints:** path must be writable by `bob serve`; parent directories are
  created with owner-only permissions where applicable.
- **Default behavior:** if omitted, bob chooses an OS-appropriate application
  state path. If the file cannot be opened or appended, service startup fails
  rather than silently running without durable audit.

### Tail visibility filters

- **What:** the audit kinds visible through live tail subscriptions by default.
  **Why:** operators need configurable noise control without sacrificing the
  durable audit trail.
- **Where:** bob's TOML config under the monitoring section.
- **Constraints:** allowed values are bob-defined audit kinds. Initial kinds are
  `events`, `reports`, and `verdicts` for CLI filters. Stored record kinds are
  singular `event`, `report`, and `verdict` inside the record envelope.
- **Default behavior:** all supported kinds are visible.
- **Contract:** `bob audit tail --filter <kind>` narrows the live stream to the
  requested kind or kinds. The canonical spelling is `verdicts`, not
  `veredicts`.

### External report schema

- **What:** bob-defined structured fields for `report.submit`. **Why:** report
  records must be reviewable and stable without arbitrary tool payloads.
- **Where:** Admin-RPC protocol types and bob-core audit domain types.
- **Constraints:** the report must identify the submitting tool/action name,
  outcome status, optional session id when known, optional human-readable
  summary, and timestamps/ids assigned or normalized by bob. No free-form
  metadata object is accepted in v1.
- **Default behavior:** malformed reports are rejected with a typed Admin-RPC
  error and are not appended.

### Persistence and shutdown

- **What:** Monitoring must flush accepted audit records during graceful
  shutdown. **Why:** a clean service stop must not lose records already
  acknowledged.
- **Where:** bob serve shutdown wiring and Monitoring actor implementation.
- **Constraints:** bounded queue backpressure is observable; accepted records
  are not dropped silently.
- **Default behavior:** if the Monitoring queue is full, callers receive a
  typed backpressure/service-unavailable error or the existing subsystem
  backpressure handling path, depending on the caller surface.

## Implementation Order

| Phase | What | Depends On |
|---|---|---|
| 1 | Define audit domain types in `bob-core`: canonical `AuditRecord`, kind-specific payloads for event/report/verdict, report validation shape, and filter kinds. | Nothing |
| 2 | Implement the Monitoring actor and JSONL audit log store: append records, flush on shutdown, expose a typed handle, and apply subscriber filters only to live delivery. | Phase 1 |
| 3 | Add Admin-RPC methods `report.submit` and `audit.tail`, plus `bob audit tail` client support for `--filter` and `--json` rendering. | Phase 2 |
| 4 | Wire runtime producers into Monitoring: extension events from S-003 and policy verdicts from S-004 become persistent audit records. | Phase 2 |
| 5 | Add integration coverage: persistent log survives restart, disabled tail kinds are still written to disk, `report.submit` uses admin.sock same-UID auth, and `bob audit tail --filter` receives only matching future records. | Phase 3, Phase 4 |

## Alternatives Considered

- **Thin Admin-RPC-only implementation.** Rejected because it would put
  monitoring behaviour in the transport layer. The chosen design keeps
  Admin-RPC as a facade and makes Monitoring the subsystem owner, matching
  S-002's actor-boundary model.
- **Dedicated `report.sock`.** Rejected by human direction. Reusing
  `admin.sock` keeps v1 local trust and socket management simple.
- **SQLite from the start.** Rejected by human direction. JSONL is enough for
  append and tail, and point queries are out of scope.
- **Dropping disabled audit kinds before persistence.** Rejected because the
  durable audit trail should remain complete. Filtering is a viewing concern.
- **Bob-issued report correlation tokens.** Rejected by human direction for v1.
  The admin socket's same-UID gate is the authentication boundary.
- **Arbitrary report metadata.** Rejected by human direction. V1 reports use
  only bob-defined structured fields.

## Amendment Log

<!-- Optional. Use when an approved spec is amended after tasks are in flight.
| Date | What changed | Why | Affected tasks |
|------|-------------|-----|----------------|
| YYYY-MM-DD | Description of change | Reason for amendment | T-XXX, T-YYY |
-->
