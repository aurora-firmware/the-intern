---
id: CR-005-amendment-drafts
title: Proposed amendment drafts for CR-005 (configurable working directory)
status: applied
created: '2026-07-05'
author: planner
---

# CR-005 — Amendment Drafts (approved and applied 2026-07-05)

> **RESOLVED 2026-07-05.** These drafts were approved as drafted and applied to
> the canonical artifacts: S-002, S-009, S-005, and ADR-012 were amended; the §5
> F2 data-flow ADR was recorded and accepted as **ADR-013**; and Gate 2 tasks
> T-118–T-130 were created (passed the Architect preflight). This file is
> retained as the proposal record — the "proposal / pending approval / TBD /
> number to be confirmed" language below reflects its state at drafting time.

These are **proposals**, not applied changes. Per the CR-005 resolution the
approved specs/ADRs are NOT edited here; this companion file holds the exact
replacement/added wording so the human can approve it before any spec/ADR is
amended and before Gate 2 task breakdown.

Scope of these drafts is bounded strictly by the resolved decisions recorded in
CR-005 §"Consistency Review Outcome & Resolved Decisions" (combined scope;
default = inherit launch cwd; job-id carried through the inbound queue and cwd
resolved from the live schedule table with `InternalEvent` unchanged; audit
records resolved cwd; no directory ownership check; interactive chat unchanged;
absolute-only validation at add/load, existence checked at fire time). Nothing
below reopens those decisions.

Grounding: the service code on `feat/schedule-file-prompt` already lands the
`prompt`/`file` split — `ScheduleEntry { id, cron, prompt: Option<String>,
file: Option<String> }` with exactly-one-of enforced and `file` required to be
absolute (`bob-core/src/types/schedule.rs`). The periodic path today enqueues
only the event and drops `RequestContext` (`bob/src/serve.rs`, `enqueue(event)`
around line 190), so the dispatcher's `dequeue_next` has no job id — the F2
problem these drafts fix.

House-style reminder: specs describe behaviour and interfaces, not code. The
schema shapes quoted below are **data contracts** (they already appear in
S-009 §State Store Requirements and ADR-012), not implementation snippets.

---

## 0. Orientation — config/state split (F7)

Two distinct settings, two distinct homes, matching the split ADR-012/CR-004
already established between static config and mutable schedule state:

| Setting | Home | Governing decision | Mutability |
|---|---|---|---|
| `pi_agent_cwd` (service-wide worker cwd) | `config.toml` | ADR-002 (TOML static config) | Loaded once at startup, immutable per run |
| per-entry `cwd` on a schedule entry | `schedules.json` | ADR-012 (mutable JSON schedule state) | Mutated via `schedule.*`, rewritten atomically |

Precedence at fire time: per-entry `cwd` (if set) → service-wide `pi_agent_cwd`
(if set) → inherited `bob serve` launch cwd (today's behaviour, the v1 default).

---

## 1. S-002 — Bob Service Shell Architecture

### 1a. Configuration section — add the `pi_agent_cwd` key

**Current** (S-002 §Configuration, the bullet list is behavioural and ends with
"Subsystem placeholders"). Add a new bullet after **Shutdown deadlines** /
before **Tracing** (placement is editorial):

**Proposed addition:**

> - **pi-agent worker working directory (`pi_agent_cwd`).** The service-wide
>   working directory the supervisor gives every pi-agent RPC worker it spawns
>   for the `bob serve` pool. *What must exist:* an optional key naming the
>   directory workers run in. *Where it lives:* `config.toml` as a top-level
>   `snake_case` key (ADR-002), not a per-subsystem table. *Constraints:* when
>   set it must be an **absolute** path; a relative value is rejected at config
>   load with a clear configuration error. *Missing-value behaviour:* unset →
>   workers inherit the launch cwd of the `bob serve` process (the pre-CR-005
>   behaviour, backward compatible and the v1 default). *Existence handling
>   (lazy / spawn-time):* directory existence is **not** gated at config load and
>   does **not** fast-fail service startup; a set-but-missing `pi_agent_cwd`
>   surfaces at worker spawn time as a logged (warned) worker-spawn failure
>   through the supervisor's existing child-process error path (and, for a
>   scheduled firing, is skipped with a warning like any other spawn failure).
>   Operators are advised to set an explicit workspace so pi's context-file
>   (`AGENTS.md`/`CLAUDE.md`), skills, and relative-path resolution are
>   predictable.

### 1b. Responsibility Separation — Pi-agent Supervisor row

**Current:**

> | Pi-agent Supervisor actor | Scaffold for S-001 Phase 2 work — owns the warm pool, spawn/reap, and prompt routing | Empty implementation; `bob sessions list` shows the (currently empty) pool |

**Proposed replacement:**

> | Pi-agent Supervisor actor | Scaffold for S-001 Phase 2 work — owns the warm pool, spawn/reap, and prompt routing; spawns each worker with an explicit working directory resolved from `pi_agent_cwd` (inheriting the launch cwd when unset), and supports acquiring a session under a caller-supplied cwd for per-entry scheduled jobs | Warm workers carry the service-wide cwd; a per-entry-cwd request needs a dedicated worker (see Component 6) |

### 1c. Component 6: Subsystem scaffolds — add the worker-cwd / warm-pool contract (F3)

**Current** (Component 6 Interfaces bullet ends with the sentence about
`list_sessions`). Append the following paragraph to Component 6:

**Proposed addition:**

> **Worker working directory and the warm-pool contract.** The supervisor spawns
> every pool worker with an explicit working directory: `pi_agent_cwd` when set,
> otherwise the inherited launch cwd. Warm-pool workers are pre-spawned with that
> single service-wide cwd, so they can only be reused by requests that want that
> cwd. A request that supplies its own working directory (a per-entry scheduled
> job with an explicit `cwd`, per S-009) therefore **cannot** reuse a warm
> worker: the supervisor must spawn a **dedicated** worker in the requested
> directory. That dedicated worker forgoes warm-pool latency and consumes one
> `max_processes` slot for the duration of the run.
>
> **When `max_processes` is exhausted.** Acquisition of a per-entry-cwd worker is
> bound by `max_processes` exactly like any other spawn: when active plus warm
> workers already fill the limit, the acquisition is refused rather than evicting
> a live worker or exceeding the bound. Because scheduled runs are
> fire-and-forget `periodic` deliveries with no caller to receive a receipt, a
> refused acquisition **skips that fire** with a logged warning and a monitoring
> failure record; the schedule entry remains and fires again on its next tick.

### 1e. Component 7 / interactive-chat workflow — `bob chat` ignores `pi_agent_cwd`

**Current** (S-002 §Component 7, the *Interactive chat* bullet, and the
"Interactive chat" workflow block). Add one clarifying sentence to the
*Interactive chat* bullet in Component 7:

**Proposed addition:**

> `bob chat` runs the supervised interactive `pi` session in the current working
> directory where the `bob chat` command is invoked; it does **not** consult
> `pi_agent_cwd`, which governs only the `bob serve` RPC worker pool. This keeps
> interactive behaviour unchanged by CR-005.

(Editorially the same one-line note may be echoed in the "Interactive chat"
workflow block; the Component 7 bullet is the authoritative home.)

### 1d. S-002 Amendment Log — new row

**Proposed addition** to the Amendment Log table:

> | 2026-07-05 | Added the service-wide `pi_agent_cwd` config key (absolute-only; default = inherit launch cwd; existence handled lazily at spawn time — no startup gate); the supervisor spawns workers with an explicit resolved cwd; documented that a per-entry-cwd scheduled job spawns a dedicated worker (no warm-pool reuse), consumes a `max_processes` slot, and — when the pool is exhausted — skips that fire with a warning rather than blocking or evicting; clarified that `bob chat` ignores `pi_agent_cwd` and uses the invocation cwd. | CR-005. | CR-005 tasks TBD |

---

## 2. S-009 — Scheduler Channel Adapter and bob schedule CLI

This edit does two things in one pass: (a) reconciles the already-merged
`prompt`/`file` split that S-009 never captured (F6), and (b) adds the per-entry
`cwd` field, CLI flag, list output, validation, and fire-time resolution.

### 2a. Design Principle "Schedule entries must be valid before becoming runnable"

**Current:**

> - **Schedule entries must be valid before becoming runnable.** Bob must not
>   accept or load a bad job. Every entry must have a non-empty unique id, a valid
>   cron expression, and a non-empty prompt. `schedule.add`, service startup, and
>   `schedule.reload` all validate these invariants with a clear error; malformed
>   entries are never silently ignored or deferred.

**Proposed replacement:**

> - **Schedule entries must be valid before becoming runnable.** Bob must not
>   accept or load a bad job. Every entry must have a non-empty unique id, a valid
>   cron expression, and **exactly one** prompt source — either an inline
>   `prompt` string or a `file` path — that is present and non-blank. When `file`
>   is used it must be an **absolute** path. An optional `cwd`, when present, must
>   also be an **absolute** path. `schedule.add`, service startup, and
>   `schedule.reload` all validate these invariants (absolute-path shape
>   included) with a clear error; malformed entries are never silently ignored or
>   deferred. Directory and file **existence** are deliberately not checked at
>   validation time (a path can be removed after add); existence is resolved at
>   fire time (see the cron-tick workflow).

### 2b. Responsibility Separation — Schedule state store row

**Current:**

> | Schedule state store | Persists named jobs (id, cron expression, prompt) across restarts | Versioned JSON document at `$XDG_STATE_HOME/bob/schedules.json`, falling back to `~/.local/state/bob/schedules.json`; validated at startup and on reload |

**Proposed replacement:**

> | Schedule state store | Persists named jobs (id, cron expression, one of prompt/file, and an optional cwd) across restarts | Versioned JSON document at `$XDG_STATE_HOME/bob/schedules.json`, falling back to `~/.local/state/bob/schedules.json`; validated at startup and on reload |

### 2c. Component 2: Schedule state schema

**Current:**

> **Purpose:** Defines and validates the versioned JSON schedule store, mapping named job entries (id, cron expression, prompt string) to the types the scheduler actor consumes.

**Proposed replacement:**

> **Purpose:** Defines and validates the versioned JSON schedule store, mapping named job entries (id, cron expression, exactly one of an inline prompt string or an absolute prompt-file path, and an optional absolute working directory) to the types the scheduler actor consumes.

### 2d. Workflow "Adding a job" — reflect `--file` and `--cwd`

**Current first line:**

> Operator runs: bob schedule add --id check-email --cron "*/15 * * * *" --prompt "Check email …"

**Proposed replacement (illustrative command; shows the new flags):**

> Operator runs: bob schedule add --id check-email --cron "*/15 * * * *" \
>   --prompt "Check email …" [--cwd /srv/workspaces/email]
>   (or --file /srv/prompts/email.md in place of --prompt)

Add one line to the same workflow's validation step:

**Current:**

> admin-RPC handler validates cron expression and id uniqueness

**Proposed replacement:**

> admin-RPC handler validates cron expression, id uniqueness, exactly-one-of
> prompt/file, and that any supplied file path and cwd are absolute

### 2e. Workflow "Cron tick (steady state)" — cwd resolution and missing-cwd skip

**Current:**

> Scheduler actor constructs periodic InternalRequest
>   { channel_id: "scheduler", job_id: "check-email", payload: "<prompt>", kind: Periodic }

**Proposed replacement:**

> Scheduler actor resolves this fire's working directory:
>   per-entry cwd (if set) → service-wide pi_agent_cwd (if set) → inherited launch cwd
>   → if a per-entry cwd is set but the directory does not exist now: skip this
>     fire with a warning and a monitoring failure record (analogous to the
>     missing-prompt-file skip); the entry fires again next tick
>   ↓
> Scheduler actor constructs the periodic InternalRequest carrying the prompt,
>   channel_id "scheduler", and job_id; the resolved cwd is carried to the
>   dispatcher via the job id (see ADR — F2 data-flow), not embedded in
>   InternalEvent

### 2f. State Store Requirements — reconcile schema and add cwd (F6 + cwd)

**Current:**

> - **What:** A versioned JSON document containing zero or more named job entries.
>   Each entry requires a unique string `id`, a valid cron expression (`cron`),
>   and a non-empty prompt string (`prompt`).
> - **Where:** `$XDG_STATE_HOME/bob/schedules.json`, falling back to
>   `~/.local/state/bob/schedules.json` on Linux (ADR-009 / ADR-012).
> - **Shape:** the initial schema is `{ "version": 1, "entries": [...] }`, with
>   each entry shaped as `{ "id": string, "cron": string, "prompt": string }`.
> - **Constraints:** `id` must be unique across all entries. `cron` must be a
>   valid 5-field cron expression. `prompt` must be non-empty. No maximum entry
>   count is enforced at the spec level.
> - **Missing-value behaviour:** A missing schedule store or an empty `entries`
>   array is valid and results in no scheduled jobs. A malformed document, duplicate
>   id, blank field, or invalid cron expression is rejected as a whole at startup
>   and at `schedule.reload` time; the service must not silently skip individual
>   bad entries. The same invariants are enforced at `schedule.add` time before
>   anything is written.

**Proposed replacement:**

> - **What:** A versioned JSON document containing zero or more named job entries.
>   Each entry requires a unique string `id`, a valid cron expression (`cron`),
>   and **exactly one** prompt source: an inline `prompt` string or an absolute
>   `file` path whose contents are read fresh at each fire. Each entry may
>   additionally carry an optional absolute `cwd` naming the working directory the
>   fired pi-agent session runs in.
> - **Where:** `$XDG_STATE_HOME/bob/schedules.json`, falling back to
>   `~/.local/state/bob/schedules.json` on Linux (ADR-009 / ADR-012).
> - **Shape (contract):** the schema is `{ "version": 1, "entries": [...] }`,
>   with each entry shaped as
>   `{ "id": string, "cron": string, ("prompt": string | "file": string), "cwd"?: string }`.
>   Exactly one of `prompt`/`file` is present; `cwd` is omitted when unset. The
>   store version stays `1`: `prompt`-only stores written before this change load
>   unchanged (the added fields are optional).
> - **Constraints:** `id` must be unique across all entries. `cron` must be a
>   valid 5-field cron expression. Exactly one of `prompt`/`file` must be present
>   and non-blank. `file`, when used, must be an absolute path. `cwd`, when
>   present, must be an absolute path. Path **existence** is not required at
>   validation time. No maximum entry count is enforced at the spec level.
> - **Missing-value behaviour:** A missing schedule store or an empty `entries`
>   array is valid and results in no scheduled jobs. A malformed document,
>   duplicate id, blank/missing prompt source, both prompt and file set, a
>   relative `file` or `cwd`, or an invalid cron expression is rejected as a whole
>   at startup and at `schedule.reload` time; the service must not silently skip
>   individual bad entries. The same invariants are enforced at `schedule.add`
>   time before anything is written. A per-entry `cwd` that does not exist at fire
>   time causes that fire to be skipped with a warning (existence is a fire-time
>   concern, not a validation-time one).

### 2g. admin-RPC scheduler methods & `bob schedule` CLI — surface `cwd`

**Current** (Responsibility Separation, admin-RPC scheduler methods row is fine
as-is; the additive behaviour is the `cwd` parameter). Add to Component 3
Interfaces and Component 4:

**Proposed addition to Component 3 (admin-RPC scheduler methods):**

> `schedule.add` accepts an optional `cwd` parameter alongside the prompt/file
> parameters; `schedule.list` includes each entry's `cwd` when set. Validation of
> the absolute-path constraint happens in the `schedule.add` handler before the
> store is written.

**Proposed addition to Component 4 (`bob schedule` subcommands):**

> `bob schedule add` exposes an optional `--cwd <dir>` flag that maps to the
> `schedule.add` `cwd` parameter; `bob schedule list` renders each entry's `cwd`
> in both human and `--json` output.

### 2h. Add an "Optional" acceptance surface to the cron-tick fire path

No new component; covered by 2e. (Noted so the Gate 2 breakdown authors a
State-driven / Optional AC for "WHERE a per-entry cwd is set, the fired session's
working directory SHALL be that cwd".)

### 2i. S-009 Amendment Log — new row

**Proposed addition:**

> | 2026-07-05 | Reconciled the schedule-entry schema with the already-merged `prompt`/`file` split (exactly-one-of, absolute `file`) and added an optional absolute per-entry `cwd` field, the `--cwd` CLI flag, `schedule.list` cwd output, absolute-only add/load validation, and fire-time cwd resolution with a missing-directory skip+warn. | CR-005 (with F6 schema reconciliation). | CR-005 tasks TBD |

---

## 3. S-005 — Monitoring audit log and external action reporting

Human decision: record the **resolved** cwd in the scheduled-run audit record.

**Shape decision (resolved — §7.1, option a):** extend the **existing** event
audit payload with a resolved-cwd field; do **not** introduce a dedicated
scheduled-run payload kind. S-005 today defines three record kinds — `event`,
`report`, `verdict` — via `AuditRecordPayload`; the `event` payload
(`ExtensionEventAuditPayload { name, summary }`) is the record produced for a
`periodic` firing on queue admission (per S-009's Monitoring responsibility). The
resolved cwd is added as a new **optional** field on that existing event payload,
keeping the record-kind set (`event`/`report`/`verdict`) unchanged.

### 3a. Design Principles — add a scheduled-run attribution note

**Proposed addition** to S-005 §Design Principles:

> - **Scheduled runs record their resolved working directory.** When a scheduled
>   (`periodic`) job fires, its event audit record carries the **resolved**
>   working directory the pi-agent session ran in — the concrete absolute path
>   after precedence is applied (per-entry `cwd` → `pi_agent_cwd` → inherited),
>   not the raw per-entry field. This makes it auditable which workspace a
>   scheduled agent session executed against.

### 3b. Component 1 (Audit record model) — extend the existing event payload

**Proposed addition** to Component 1 (Audit record model) Interfaces:

> The event audit payload gains an **optional** resolved working-directory field.
> It is populated with the absolute cwd actually used when the event records a
> `periodic` (scheduled) firing, and omitted for events that have no execution
> directory (for example forwarded pi-agent extension events). No new audit
> record kind is added: the record-kind set stays `event`/`report`/`verdict`, and
> the field lives on the existing event payload. `report` and `verdict` payloads
> are unchanged.

### 3c. External report schema — no change

The `report.submit` external-report schema is unchanged; the resolved-cwd field
is scoped to the event payload only.

### 3c. S-005 Amendment Log — new row

**Proposed addition:**

> | 2026-07-05 | The event audit payload gains an optional resolved-working-directory field, populated for `periodic` firings with the absolute cwd used after per-entry → service-wide → inherited precedence. No new record kind is introduced. | CR-005. | CR-005 tasks TBD |

---

## 4. ADR-012 — Scheduler admission uses Unix trust boundary and JSON state

Two changes: (a) record the trust relaxation for both prompt files and cwd (F4),
and (b) update the JSON contract block to the reconciled schema (F6).

### 4a. Decision item 5 — update the schema contract block

**Current** (ADR-012 §Decision, item 5 JSON block):

> ```json
> {
>   "version": 1,
>   "entries": [
>     {
>       "id": "check-email",
>       "cron": "*/15 * * * *",
>       "prompt": "Check email and summarize anything urgent"
>     }
>   ]
> }
> ```

**Proposed replacement:**

> ```json
> {
>   "version": 1,
>   "entries": [
>     {
>       "id": "check-email",
>       "cron": "*/15 * * * *",
>       "prompt": "Check email and summarize anything urgent",
>       "cwd": "/srv/workspaces/email"
>     }
>   ]
> }
> ```
>
> Each entry carries exactly one prompt source — either an inline `prompt` string
> or an absolute `file` path read fresh at each fire — plus an optional absolute
> `cwd`. The unused prompt field and an absent `cwd` are omitted on disk; the
> store version stays `1` and older `prompt`-only stores load unchanged.

### 4b. New Decision item — trust relaxation for prompt files and cwd (F4)

**Proposed addition** as a new item under ADR-012 §Decision (e.g. item 7), and a
matching note under §Consequences → Negative:

> 7. **Prompt-file contents and the working directory are trusted, un-checked
>    inputs.** A schedule entry's `file` contents and its `cwd` originate in the
>    owner-only schedule store, so their *values* are trusted; bob performs **no**
>    ownership or permission check on either the prompt file or the working
>    directory before use. This is a deliberate relaxation, previously recorded
>    only as a code comment: because pi auto-loads `AGENTS.md`/`CLAUDE.md` and
>    skills from the working directory and reads the prompt file verbatim, a file
>    or directory writable by another principal could inject prompt content or
>    context that bypasses `[policy].admitted_users`. Operators MUST keep both the
>    prompt file and the cwd under the same owner-only protection as
>    `schedules.json` itself. Filesystem permissions — not a bob-side ownership
>    check — are the gate.

**Consequences → Negative, proposed addition:**

> - Prompt-file contents and the scheduled working directory are used without an
>   ownership check; a mis-permissioned file or directory can inject trusted
>   context. Acceptable only while schedule state and its referenced paths are
>   guarded by the same Unix owner-only permissions as the control plane.

---

## 5. New ADR (proposed **ADR-013**; number to be confirmed by the Architect) — F2 data-flow

The Architect finalises/records this; the draft below supplies context, decision,
and consequences. It may alternatively be recorded as an **ADR-004 addendum** if
the Architect prefers to keep it adjacent to the delivery-kind decision.

**Title:** Inbound persistence queue carries the job id so the periodic
dispatcher resolves per-entry execution context from the live schedule table.

**Status:** proposed (Architect to accept).

### Context

CR-005 adds a per-entry working directory to scheduled jobs. The dispatcher that
fires a scheduled run must know that entry's execution context (its `cwd`).
Today the periodic path drops attribution at the queue boundary: the scheduler
adapter builds an `InternalEvent` plus a `RequestContext` (job id in
`context_id`), but `PersistenceStore::enqueue` persists only the event —
`RequestContext` is not carried (`bob/src/serve.rs`, `enqueue(event)`). The
periodic dispatcher's `dequeue_next` therefore sees the event with no job id and
no way to look up the entry.

Two forces constrain the fix:
- ADR-004 keeps `InternalEvent` typed by delivery kind only; channel- and
  entry-specific data (including cwd) must **not** be embedded in the core
  delivery type (F1; consistent with S-006 and S-001's thin-core principle).
- Schedule entries are mutable: the live table can change between enqueue and
  fire, so the cwd must be resolved from the **current** table, not a snapshot
  captured at enqueue.

### Decision

The inbound persistence queue carries a **job-id correlator** for `periodic`
requests. `PersistenceStore::{enqueue, dequeue_next}` (and the inbound queue they
back) are extended to carry the job id alongside the event. The periodic
dispatcher, on dequeue, resolves the firing entry's execution context (its
`cwd`, and any future per-entry execution settings) from the **live schedule
table** it observes via `ReloadHandle::subscribe`. `InternalEvent` is unchanged;
execution context is not a property of the delivery type. When the job id no
longer resolves to a live entry (removed between enqueue and fire), the
dispatcher falls back to the service-wide default and records the condition.

### Consequences

**Positive:**
- Keeps `InternalEvent` channel- and context-agnostic (honours ADR-004, S-006,
  S-001); cwd never leaks into the core delivery type.
- The dispatcher always resolves against the current schedule table, so a cwd
  edited or removed after enqueue is reflected at fire time.
- Generalises: future per-entry execution settings resolve the same way without
  further queue-shape changes.

**Negative:**
- The `PersistenceStore` port and the inbound queue shape change — an
  already-integrated interface — and every producer/consumer of that queue must
  supply/ignore the correlator.
- A small race window exists: a job removed between enqueue and dequeue no longer
  resolves; the dispatcher must define the fallback (service-wide default) rather
  than fail.

**Neutral:**
- Non-periodic deliveries carry no job-id correlator (or carry it as absent) and
  are unaffected.
- Audit attribution the scheduler-adapter derives from `RequestContext` is
  independent of this change.

---

## 6. Affected-artifact completeness check

CR-005's impact and amendment lists are essentially complete. Confirmed set:

| Artifact | Change | Covered by |
|---|---|---|
| S-002 | `pi_agent_cwd` config; worker-spawn cwd; warm-pool/`max_processes` contract | §1 |
| S-009 | per-entry `cwd`, `--cwd`, list output, validation, fire-time resolution, `prompt`/`file` reconciliation | §2 |
| S-005 | resolved cwd in scheduled-run audit record | §3 |
| ADR-012 | trust relaxation (file + cwd) + schema block update | §4 |
| New ADR-013 (or ADR-004 addendum) | queue carries job id; dispatcher resolves cwd from live table | §5 |
| ADR-009 | **no change** — agent cwd is not a bob-managed XDG bucket (confirmed) | — |
| ADR-002 | **no amendment** — `pi_agent_cwd` is an additive `config.toml` key under the existing static-config decision; referenced only | §0 |
| ADR-004 | **no amendment to the decision** — `InternalEvent` unchanged; the new ADR references it | §5 |
| S-006 | **no amendment** — consulted as a binding constraint (no channel/execution context in the core delivery type) | F1/F10 |
| S-001 | **no amendment expected** — consulted as a thin-core constraint; the Architect should confirm when recording ADR-013 that the queue-carries-job-id change stays within S-001's inbound-interface description | §9 item 2 |

**Additions CR-005 under-specifies (not new scope, flagged for the breakdown):**

- **S-007 (user docs) is a task surface, not a spec amendment.** The operator
  guide's schedule and configuration pages must document `pi_agent_cwd`, `--cwd`,
  the precedence rule, and the owner-only-cwd trust guidance. That is
  documentation *implementation* derived from these amendments and belongs in the
  Gate 2 breakdown as a docs task; S-007 itself needs no wording change.
- **README pi-agent compatibility** is unaffected (no pi-agent version pin
  changes).

---

## 7. Open questions — all resolved (2026-07-05)

1. **S-005 scheduled-run record shape (modelling). RESOLVED — option (a):** extend
   the **existing** event audit payload with an optional resolved-cwd field; do
   **not** add a dedicated scheduled-run payload kind. The record-kind set stays
   `event`/`report`/`verdict`. §3 is updated to specify this concrete shape,
   grounded in S-005's existing `ExtensionEventAuditPayload`.

2. **`pi_agent_cwd` existence at startup. RESOLVED — lazy / spawn-time:** validate
   absolute-only at config load; do **not** add a startup existence gate. A
   set-but-missing `pi_agent_cwd` surfaces at worker spawn time as a logged
   (warned) spawn failure (skip + warn for a scheduled firing), symmetric with the
   per-entry fire-time posture. §1a reflects this.

3. **Interactive-chat `bob chat` cwd. RESOLVED — add the explicit note:** `bob
   chat` uses the cwd where it is invoked and does **not** consult `pi_agent_cwd`.
   §1e adds the one-line clarification to S-002 Component 7 (interactive-chat).

4. **ADR-013 vs ADR-004 addendum (Architect's call — still open by design).** §5
   is written as a standalone ADR; the Architect decides the final form and
   number when recording it. This is an Architect-owned finalisation, not a human
   decision blocking wording approval.

---

## 8. Provisional task outline (NON-BINDING — Gate 2 has not run)

Illustrative only; the real decomposition happens after these amendments are
approved. Grouped by natural file isolation:

- Amend specs/ADRs per §1–§5 (docs task on `dev-agent`; not code).
- `bob-core`: add optional `cwd` to `ScheduleEntry`; extend
  `validate_schedule_store` for absolute `cwd` (+ reconcile prompt/file if not
  already validated).
- `bob-core`/persistence: extend `PersistenceStore::{enqueue, dequeue_next}` and
  the inbound queue to carry the job id (ADR-013).
- `pi-agent-supervisor`: worker spawn sets `current_dir`; add cwd-aware session
  acquisition (dedicated worker, `max_processes`-bounded, skip-on-exhaustion).
- `bob` config: add `pi_agent_cwd` (absolute-only load validation).
- `scheduler-adapter` / `serve.rs`: fire-time cwd precedence resolution +
  missing-cwd skip+warn; thread job id → dispatcher → cwd-aware acquire.
- `admin-rpc` + `bob` CLI: `schedule.add` `cwd` param, `--cwd` flag,
  `schedule.list` output.
- Monitoring: record resolved cwd in the scheduled-run audit record (pending §7.1
  shape decision).
- Docs (S-007): operator-guide schedule + configuration + trust-guidance updates.
- Tests: precedence, absolute-only validation, fire-time skip, warm-pool bypass /
  `max_processes` exhaustion, audit-cwd assertion.

---

## 9. What still needs approval before implementation can start

All three §7 open questions are resolved and folded into the drafts. Only two
items remain:

1. **Human approves the §1–§5 amendment wording** (S-002, S-009, S-005, ADR-012,
   and the new ADR draft). Approval authorises the Planner to apply these edits to
   the canonical specs/ADRs on `dev-agent`.
2. **The Architect records the F2 ADR (§5)** with its final number/form and
   confirms S-001 needs no amendment.

Only after (1) is approved and the ADR (§5) is recorded should the spec/ADR edits
be applied and Gate 2 task breakdown begin. No code changes are proposed here.
