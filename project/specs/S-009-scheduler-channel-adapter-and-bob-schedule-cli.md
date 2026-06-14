---
title: Scheduler Channel Adapter and bob schedule CLI
version: '0.1'
status: approved  # draft | review | approved | superseded
created: '2026-06-11'
author: planner
id: S-009
---

# Scheduler Channel Adapter and bob schedule CLI

## Purpose

Bob has no way to trigger pi-agent autonomously on a recurring schedule — every
request today originates from an interactive caller. This matters now because
Phase 6 of S-001 calls for a scheduler channel alongside chat and email, and
scheduled triggering is the prerequisite for any periodic
automation (such as email polling) the operator wants to configure. When this
work is done, an operator can define named cron jobs in `bob.toml`, manage them
at runtime with `bob schedule` subcommands, and rely on bob to fire the
corresponding pi-agent prompts on time without any external scheduler. Success
is confirmed when a configured cron entry causes a `periodic` request to reach
pi-agent on the expected cadence and the entry survives a `bob` restart.

## Exclusions

What this specification explicitly does NOT cover:

- **Email-specific logic.** Email monitoring and processing are handled by
  pi-agent invoking the himalaya skill. The scheduler delivers a verbatim prompt
  to pi-agent; what pi-agent does with that prompt is out of scope.
- **Non-time-based trigger types.** Time-based scheduling only. Other trigger
  types are out of scope for this adapter.
- **Response routing back to the scheduler.** Scheduled jobs are
  fire-and-forget (`periodic` delivery kind per ADR-004); no response is routed
  back to the adapter.
- **Job run history and audit storage.** Observability of job execution is
  delegated to the existing monitoring layer (S-005). This spec adds no new
  storage.
- **Job dependencies, ordering, and chaining.** Each job fires independently.
  No DAG or sequencing primitives are in scope.
- **System cron as a fallback.** Scheduled jobs are intentionally tied to bob's
  process lifetime. If bob is down, no jobs fire. This design decision is
  recorded in the companion ADR (ADR-006).

## Architecture

### Design Principles

- **Scheduler tasks must not outlive the bob process.** Scheduled jobs run only
  while bob is running. A job that fires while bob is stopped is simply skipped,
  never replayed or queued externally. This is a deliberate coupling of task
  lifecycle to service health.
- **The scheduler is an adapter, not a core subsystem.** Channel identity (time
  as trigger source) must not enter the deterministic core. The scheduler
  adapter translates timer events into `periodic` `InternalRequest` values and
  injects them into the queue, exactly as any other channel adapter would.
- **Config file is the source of truth; admin-RPC is the mutation path.** The
  `[schedule]` section of `bob.toml` is authoritative. The `bob schedule`
  subcommands mutate that section and signal the adapter to reload; they never
  maintain independent state.
- **Each cron expression must be validated on entry.** An invalid cron
  expression must be rejected at `bob schedule add` time (and at startup) with
  a clear error, never silently ignored or deferred.
- **Job payloads are opaque to bob.** The prompt string is passed verbatim to
  pi-agent. Bob neither parses nor validates the content.

### System Diagram

```
Operator                  bob CLI                  admin.sock
   │                         │                         │
   │  bob schedule add …     │                         │
   ├────────────────────────►│                         │
   │                         │  schedule.add RPC       │
   │                         ├────────────────────────►│
   │                         │                         │  Scheduler Actor
   │                         │                         ├────────────────►  writes bob.toml
   │                         │                         │                   reloads live jobs
   │  (response)             │  (receipt)              │
   │◄────────────────────────┤◄────────────────────────┤
   │
   │  (later — cron tick)
   │
                      Scheduler Actor
                            │  periodic InternalRequest
                            │  { prompt, ChannelId="scheduler", kind=Periodic }
                            ▼
                      Internal Queue
                            │
                            ▼
                      Requests Handler ──► pi-agent
                                           (processes prompt verbatim,
                                            no response expected)
```

### Responsibility Separation

| Component | Responsibility | Notes |
|---|---|---|
| Scheduler adapter actor | Owns the live job table; fires `periodic` `InternalRequest` on each cron tick; reloads config on signal | Wired into `bob-serve` supervision tree alongside chat-adapter |
| `[schedule]` config section | Persists named jobs (id, cron expression, prompt) across restarts | Part of `bob.toml`; validated at startup and on reload |
| `bob schedule` subcommands | Operator-facing CLI for add, remove, list, and reload | Thin admin-RPC clients; mirror pattern of existing `bob` subcommands |
| admin-RPC scheduler methods | Expose schedule mutation and query over `admin.sock` | New methods: `schedule.add`, `schedule.remove`, `schedule.list`, `schedule.reload` |
| Internal queue | Receives `periodic` requests from the scheduler adapter | Unchanged; the scheduler is just another producer |
| Monitoring layer (S-005) | Records the `periodic` request event on queue admission | Unchanged; no new storage added by this spec |

## Components

### Component 1: Scheduler adapter actor

**Purpose:** Maintains the live job table, evaluates cron expressions against wall-clock time, and submits a `periodic` `InternalRequest` carrying the job's prompt and a `ChannelId` of `"scheduler"` to the internal queue on each tick.
**Estimated size:** Medium.
**Interfaces:** Consumes the internal queue producer handle and a config-reload signal; exposes no outbound interface. Wired into the `bob-serve` supervision tree.

### Component 2: Schedule config schema

**Purpose:** Defines and validates the `[schedule]` section of `bob.toml`, mapping named job entries (id, cron expression, prompt string) to the types the scheduler actor consumes.
**Estimated size:** Small.
**Interfaces:** Consumed by the scheduler actor at startup and reload; consumed by the `schedule.add` RPC handler for validation.

### Component 3: admin-RPC scheduler methods

**Purpose:** Exposes `schedule.add`, `schedule.remove`, `schedule.list`, and `schedule.reload` over `admin.sock`, delegating to the scheduler actor and persisting mutations to `bob.toml`.
**Estimated size:** Small–medium.
**Interfaces:** Consumed by the `bob schedule` subcommands; delegates to the scheduler actor's reload signal and to the config writer.

### Component 4: `bob schedule` subcommands

**Purpose:** Provides the operator-facing `bob schedule add / remove / list / reload` CLI, implemented as thin admin-RPC clients over `admin.sock`.
**Estimated size:** Small.
**Interfaces:** Calls admin-RPC scheduler methods; follows the existing `bob status` / `bob sessions` client pattern.

## Workflow

**Adding a job:**

```
Operator runs: bob schedule add --id check-email --cron "*/15 * * * *" --prompt "Check email …"
  ↓
bob CLI sends schedule.add RPC to admin.sock
  ↓
admin-RPC handler validates cron expression and id uniqueness
  → invalid: return error to CLI; nothing written
  → valid: write new entry to bob.toml [schedule] section
  ↓
admin-RPC handler signals scheduler actor to reload
  ↓
Scheduler actor re-reads config, updates live job table
  ↓
bob CLI prints confirmation to operator
```

**Cron tick (steady state):**

```
Wall clock reaches next scheduled time for job "check-email"
  ↓
Scheduler actor constructs periodic InternalRequest
  { channel_id: "scheduler", job_id: "check-email", payload: "<prompt>", kind: Periodic }
  ↓
Request submitted to internal queue
  ↓
Requests Handler runs pre-flight admission (policy check)
  → rejected: monitoring records denial; no pi-agent dispatch
  → admitted: monitoring records admission
  ↓
pi-agent receives request, executes prompt verbatim
  ↓
(no response path — fire and forget)
```

**bob restart:**

```
bob starts, reads bob.toml [schedule] section
  ↓
Scheduler actor validates all cron expressions
  → any invalid: log error, skip that entry (do not abort startup)
  ↓
Live job table populated; scheduler begins ticking
  (jobs that would have fired while bob was down are not replayed)
```

## Configuration Requirements

- **What:** A `[schedule]` section in `bob.toml` containing zero or more named job entries. Each entry requires a unique string `id`, a valid cron expression (`cron`), and a non-empty prompt string (`prompt`).
- **Where:** `bob.toml`, the same layered config file used for all bob configuration (ADR-002).
- **Constraints:** `id` must be unique across all entries. `cron` must be a valid 5-field cron expression. `prompt` must be non-empty. No maximum entry count is enforced at the spec level.
- **Missing-value behaviour:** A missing or empty `[schedule]` section is valid and results in no scheduled jobs. An entry with an invalid cron expression is skipped with an error log at startup; it is rejected with an error response at `schedule.add` time.

## Implementation Order

| Phase | What | Depends On |
|---|---|---|
| 1 | Schedule config schema and startup validation wired into `BobConfig`; scheduler adapter actor scaffolded and supervised in `bob-serve` (no jobs fire yet, but the actor starts and stops cleanly) | S-006 adapter framework |
| 2 | Cron tick loop: scheduler actor fires `periodic` `InternalRequest` for each configured job on schedule; end-to-end path from tick to queue admission confirmed by test | Phase 1 |
| 3 | admin-RPC scheduler methods (`schedule.add`, `schedule.remove`, `schedule.list`, `schedule.reload`) and `bob schedule` subcommands; mutations persist to `bob.toml` and reload live job table | Phase 2 |

## Amendment Log

<!-- Optional. Use when an approved spec is amended after tasks are in flight.
| Date | What changed | Why | Affected tasks |
|------|-------------|-----|----------------|
| YYYY-MM-DD | Description of change | Reason for amendment | T-XXX, T-YYY |
-->
