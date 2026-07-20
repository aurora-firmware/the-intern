---
id: ADR-013
title: Inbound persistence queue carries a job-id correlator so the periodic 
  dispatcher resolves per-entry execution context from the live schedule table
status: accepted
created: '2026-07-05'
---

# ADR-013: Inbound persistence queue carries a job-id correlator so the periodic dispatcher resolves per-entry execution context from the live schedule table

## Context

CR-005 adds a per-entry working directory (`cwd`) to scheduled jobs. The
dispatcher that fires a scheduled run must know that entry's execution context
(its `cwd`). Today the periodic path drops attribution at the queue boundary:
the scheduler-adapter builds an `InternalEvent` plus a `RequestContext` (job id
in `context_id`), but `PersistenceStore::enqueue` persists only the event —
`RequestContext` is not carried (`bob/src/serve.rs`, `enqueue(event)`). The
periodic dispatcher's `dequeue_next` therefore sees the event with no job id and
no way to look up the entry.

Two forces constrain the fix:

- ADR-004 keeps `InternalEvent` typed by delivery kind only; channel- and
  entry-specific data (including `cwd`) must **not** be embedded in the core
  delivery type (consistent with S-006 and S-001's thin-core principle).
- Schedule entries are mutable: the live table can change between enqueue and
  fire, so the `cwd` must be resolved from the **current** table, not a snapshot
  captured at enqueue.

## Decision

The inbound persistence queue carries a **job-id correlator** for `periodic`
requests. `PersistenceStore::{enqueue, dequeue_next}` (and the inbound queue they
back) are extended to carry the job id alongside the event. The periodic
dispatcher, on dequeue, resolves the firing entry's execution context (its
`cwd`, and any future per-entry execution settings) from the **live schedule
table** it observes via `ReloadHandle::subscribe`. `InternalEvent` is unchanged;
execution context is not a property of the delivery type. When the job id no
longer resolves to a live entry (removed between enqueue and fire), the
dispatcher falls back to the service-wide default and records the condition.

Accepted by the Architect on 2026-07-05, after an architecture-consistency
review against ADR-004 (`InternalEvent` typed by delivery kind only), S-006,
S-001's thin-core principle, and the applied S-009/ADR-012 CR-005 amendments
found no contradiction. Drafted under CR-005 and approved for wording by the
human on 2026-07-05.

## Consequences

### Positive

- Keeps `InternalEvent` channel- and context-agnostic (honours ADR-004, S-006,
  S-001); `cwd` never leaks into the core delivery type.
- The dispatcher always resolves against the current schedule table, so a `cwd`
  edited or removed after enqueue is reflected at fire time.
- Generalises: future per-entry execution settings resolve the same way without
  further queue-shape changes.

### Negative

- The `PersistenceStore` port and the inbound queue shape change — an
  already-integrated interface — and every producer/consumer of that queue must
  supply or ignore the correlator.
- A small race window exists: a job removed between enqueue and dequeue no longer
  resolves; the dispatcher must define the fallback (service-wide default) rather
  than fail.

### Neutral

- Non-periodic deliveries carry no job-id correlator (or carry it as absent) and
  are unaffected.
- Audit attribution the scheduler-adapter derives from `RequestContext` is
  independent of this change.

## Alternatives Considered

### Alternative A: Put the working directory (execution context) on `InternalEvent`

**Description:** Extend the core delivery type with the `cwd` (and any future
per-entry execution settings) so the dispatcher reads it directly off the event.
**Rejected because:** ADR-004 types `InternalEvent` by delivery kind only;
embedding channel-/entry-specific execution context violates that contract and
S-006/S-001's thin-core principle. It would also freeze the `cwd` into a queued
event.

### Alternative B: Carry the fully-resolved `cwd` through the queue

**Description:** Resolve the entry's `cwd` at enqueue time and persist it
alongside the event, so the dispatcher needs no lookup.
**Rejected because:** it freezes the `cwd` at enqueue time, so an edit or removal
of the entry between enqueue and fire would not be reflected — inconsistent with
the mutable-schedule model and the dynamic re-read behaviour already adopted for
file-backed prompts (`feat/schedule-file-prompt`). Resolving from the live table
at fire time keeps behaviour consistent and confines the change to a
lightweight correlator.
