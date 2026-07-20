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
work is done, an operator can define named cron jobs through `bob schedule`,
persist them in bob's dedicated schedule state store, and rely on bob to fire
the corresponding pi-agent prompts on time without any external scheduler.
Success is confirmed when a configured cron entry causes a `periodic` request
to reach pi-agent on the expected cadence and the entry survives a `bob`
restart.

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
- **Schedule state file is the source of truth; admin-RPC is the mutation
  path.** The versioned JSON schedule store defined by ADR-012 is
  authoritative. The `bob schedule` subcommands mutate that store over
  `admin.sock` and signal the adapter to reload; they never maintain
  independent state.
- **Unix trust boundary admits scheduled work.** A job that is present in the
  trusted schedule store is admitted for firing. The authorization check for
  schedule creation and mutation is access to `admin.sock` and the protected
  schedule store, not a scheduler-derived UUID entry in `[policy].admitted_users`.
  Every tool call made by the resulting pi-agent session remains subject to
  S-004 action authorization.
- **Schedule entries must be valid before becoming runnable.** Bob must not
  accept or load a bad job. Every entry must have a non-empty unique id, a valid
  cron expression, and **exactly one** prompt source — either an inline `prompt`
  string or a `file` path — that is present and non-blank. When `file` is used it
  must be an **absolute** path. An optional `cwd`, when present, must also be an
  **absolute** path. `schedule.add`, service startup, and `schedule.reload` all
  validate these invariants (absolute-path shape included) with a clear error;
  malformed entries are never silently ignored or deferred. Directory and file
  **existence** are deliberately not checked at validation time (a path can be
  removed after add); existence is resolved at fire time (see the cron-tick
  workflow).
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
   │                         │                         ├────────────────►  writes schedules.json
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
| Scheduler adapter actor | Owns the live job table; fires `periodic` `InternalRequest` on each cron tick; reloads schedule state on signal | Wired into `bob-serve` supervision tree |
| Schedule state store | Persists named jobs (id, cron expression, one of prompt/file, and an optional cwd) across restarts | Versioned JSON document at `$XDG_STATE_HOME/bob/schedules.json`, falling back to `~/.local/state/bob/schedules.json`; validated at startup and on reload |
| `bob schedule` subcommands | Operator-facing CLI for add, remove, list, and reload | Thin admin-RPC clients; mirror pattern of existing `bob` subcommands |
| admin-RPC scheduler methods | Expose schedule mutation and query over `admin.sock` | New methods: `schedule.add`, `schedule.remove`, `schedule.list`, `schedule.reload` |
| Internal queue | Receives `periodic` requests from the scheduler adapter | Unchanged; the scheduler is just another producer, with scheduler admission already satisfied by trusted schedule-store membership |
| Monitoring layer (S-005) | Records the `periodic` request event on queue admission | Unchanged; no new storage added by this spec |

## Components

### Component 1: Scheduler adapter actor

**Purpose:** Maintains the live job table, evaluates cron expressions against wall-clock time, and submits a `periodic` `InternalRequest` carrying the job's prompt and a `ChannelId` of `"scheduler"` to the internal queue on each tick.
**Estimated size:** Medium.
**Interfaces:** Consumes the internal queue producer handle and a schedule-reload signal; exposes no outbound interface. Wired into the `bob-serve` supervision tree.

### Component 2: Schedule state schema

**Purpose:** Defines and validates the versioned JSON schedule store, mapping named job entries (id, cron expression, exactly one of an inline prompt string or an absolute prompt-file path, and an optional absolute working directory) to the types the scheduler actor consumes.
**Estimated size:** Small.
**Interfaces:** Consumed by the scheduler actor at startup and reload; consumed by the `schedule.add` RPC handler for validation. The store is written atomically with temp-file-and-rename and preserves the file mode required by ADR-012.

### Component 3: admin-RPC scheduler methods

**Purpose:** Exposes `schedule.add`, `schedule.remove`, `schedule.list`, and `schedule.reload` over `admin.sock`, delegating to the scheduler actor and persisting mutations to `schedules.json`.
**Estimated size:** Small–medium.
**Interfaces:** Consumed by the `bob schedule` subcommands; delegates to the scheduler actor's reload signal and to the schedule-store writer. `schedule.add` accepts an optional `cwd` parameter alongside the prompt/file parameters; `schedule.list` includes each entry's `cwd` when set. Validation of the absolute-path constraint happens in the `schedule.add` handler before the store is written.

### Component 4: `bob schedule` subcommands

**Purpose:** Provides the operator-facing `bob schedule add / remove / list / reload` CLI, implemented as thin admin-RPC clients over `admin.sock`.
**Estimated size:** Small.
**Interfaces:** Calls admin-RPC scheduler methods; follows the existing `bob status` / `bob sessions` client pattern. `bob schedule add` exposes an optional `--cwd <dir>` flag that maps to the `schedule.add` `cwd` parameter; `bob schedule list` renders each entry's `cwd` in both human and `--json` output.

## Workflow

**Adding a job:**

```
Operator runs: bob schedule add --id check-email --cron "*/15 * * * *" \
  --prompt "Check email …" [--cwd /srv/workspaces/email]
  (or --file /srv/prompts/email.md in place of --prompt)
  ↓
bob CLI sends schedule.add RPC to admin.sock
  ↓
admin-RPC handler validates cron expression, id uniqueness, exactly-one-of
  prompt/file, and that any supplied file path and cwd are absolute
  → invalid: return error to CLI; nothing written
  → valid: atomically write new entry to schedules.json
  ↓
admin-RPC handler signals scheduler actor to reload
  ↓
Scheduler actor re-reads schedule state, updates live job table
  ↓
bob CLI prints confirmation to operator
```

**Cron tick (steady state):**

```
Wall clock reaches next scheduled time for job "check-email"
  ↓
Scheduler actor resolves this fire's working directory:
  per-entry cwd (if set) → service-wide pi_agent_cwd (if set) → inherited launch cwd
  → if a per-entry cwd is set but the directory does not exist now: skip this
    fire with a warning and a monitoring failure record (analogous to the
    missing-prompt-file skip); the entry fires again next tick
  ↓
Scheduler actor constructs the periodic InternalRequest carrying the prompt,
  channel_id "scheduler", and job_id; the resolved cwd is carried to the
  dispatcher via the job id (see ADR-013), not embedded in InternalEvent
  ↓
Request submitted to internal queue
  ↓
Requests Handler accepts scheduler firing because the job was present in the
trusted schedule store (ADR-012)
  → if queue/admission infrastructure fails: monitoring records failure; no pi-agent dispatch
  → admitted: monitoring records admission
  ↓
pi-agent receives request, executes prompt verbatim
  → any resulting tool_call is evaluated by the S-004 action gate
  → blocked tool_call: pi-agent session continues, but that side effect does not run
  ↓
(no response path — fire and forget)
```

**bob restart:**

```
bob starts, reads schedules.json from persistent state
  ↓
Bob validates the whole schedule store
  → malformed store or invalid entry: startup fails with a clear configuration error
  → missing store or empty entries array: valid, no jobs scheduled
  ↓
Live job table populated; scheduler begins ticking
  (jobs that would have fired while bob was down are not replayed)
```

**Manual schedule-store reload:**

```
Operator edits schedules.json directly
  ↓
Operator runs bob schedule reload
  ↓
admin-RPC handler reads and validates the whole schedule store
  → malformed store or invalid entry: return error; live job table is unchanged
  → valid: replace the live job table with the validated entries
```

## State Store Requirements

- **What:** A versioned JSON document containing zero or more named job entries.
  Each entry requires a unique string `id`, a valid cron expression (`cron`),
  and **exactly one** prompt source: an inline `prompt` string or an absolute
  `file` path whose contents are read fresh at each fire. Each entry may
  additionally carry an optional absolute `cwd` naming the working directory the
  fired pi-agent session runs in.
- **Where:** `$XDG_STATE_HOME/bob/schedules.json`, falling back to
  `~/.local/state/bob/schedules.json` on Linux (ADR-009 / ADR-012).
- **Shape (contract):** the schema is `{ "version": 1, "entries": [...] }`,
  with each entry shaped as
  `{ "id": string, "cron": string, ("prompt": string | "file": string), "cwd"?: string }`.
  Exactly one of `prompt`/`file` is present; `cwd` is omitted when unset. The
  store version stays `1`: `prompt`-only stores written before this change load
  unchanged (the added fields are optional).
- **Constraints:** `id` must be unique across all entries. `cron` must be a
  valid 5-field cron expression. Exactly one of `prompt`/`file` must be present
  and non-blank. `file`, when used, must be an absolute path. `cwd`, when
  present, must be an absolute path. Path **existence** is not required at
  validation time. No maximum entry count is enforced at the spec level.
- **Missing-value behaviour:** A missing schedule store or an empty `entries`
  array is valid and results in no scheduled jobs. A malformed document,
  duplicate id, blank/missing prompt source, both prompt and file set, a
  relative `file` or `cwd`, or an invalid cron expression is rejected as a whole
  at startup and at `schedule.reload` time; the service must not silently skip
  individual bad entries. The same invariants are enforced at `schedule.add`
  time before anything is written. A per-entry `cwd` that does not exist at fire
  time causes that fire to be skipped with a warning (existence is a fire-time
  concern, not a validation-time one).
- **Write contract:** `schedule.add` and `schedule.remove` write the whole JSON
  document with atomic temp-file-and-rename updates and preserve the required
  file mode.
- **Permissions:** under the current single-user-local deployment, the parent
  state directory is owner-only and `schedules.json` is `0600`. If future
  admin-socket access is widened to a Unix group, the schedule store must use
  the same trust population.
- **Admission:** a schedule entry present in this trusted store is admitted for
  firing. Scheduler execution does not require a scheduler-derived `UserId` in
  `[policy].admitted_users`.

## Implementation Order

| Phase | What | Depends On |
|---|---|---|
| 1 | Schedule state schema and startup validation wired into the scheduler subsystem; scheduler adapter actor scaffolded and supervised in `bob-serve` (no jobs fire yet, but the actor starts and stops cleanly) | S-006 adapter framework |
| 2 | Cron tick loop: scheduler actor fires `periodic` `InternalRequest` for each configured job on schedule; end-to-end path from tick to queue admission confirmed by test | Phase 1 |
| 3 | admin-RPC scheduler methods (`schedule.add`, `schedule.remove`, `schedule.list`, `schedule.reload`) and `bob schedule` subcommands; mutations persist to `schedules.json` and reload live job table | Phase 2 |

## Amendment Log

<!-- Optional. Use when an approved spec is amended after tasks are in flight.
| Date | What changed | Why | Affected tasks |
|------|-------------|-----|----------------|
| YYYY-MM-DD | Description of change | Reason for amendment | T-XXX, T-YYY |
-->
| Date | What changed | Why | Affected tasks |
|------|-------------|-----|----------------|
| 2026-06-30 | Schedule source of truth moved from `[schedule]` in `bob.toml` to `$XDG_STATE_HOME/bob/schedules.json`; scheduler UUID admission removed in favor of trusted schedule-store membership under the Unix trust boundary. | ADR-012 / CR-004 fix the hidden scheduler UUID allow-list failure and separate mutable schedule state from static config. | Scheduler amendment tasks TBD |
| 2026-06-30 | Clarified schedule-store validation and runtime policy boundaries: `schedule.add`, startup, and `schedule.reload` reject malformed jobs as a whole; valid scheduled prompts may still have later tool calls blocked by S-004 action authorization. | Architecture-consistency review found contradictory startup behavior, and human clarification confirmed bob must not accept bad jobs while tool policy remains a later per-action gate. | Scheduler amendment tasks TBD |
| 2026-07-05 | Reconciled the schedule-entry schema with the already-merged `prompt`/`file` split (exactly-one-of, absolute `file`) and added an optional absolute per-entry `cwd` field, the `--cwd` CLI flag, `schedule.list` cwd output, absolute-only add/load validation, and fire-time cwd resolution with a missing-directory skip+warn (resolved cwd carried to the dispatcher via the job id per ADR-013). | CR-005 (with F6 schema reconciliation). | T-118, T-124, T-125, T-126, T-127, T-129, T-130 |
