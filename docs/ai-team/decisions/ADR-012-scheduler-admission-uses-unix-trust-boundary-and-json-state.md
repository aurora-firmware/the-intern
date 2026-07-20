---
id: ADR-012
title: Scheduler admission uses Unix trust boundary and JSON state
status: accepted
created: '2026-06-30'
---

# ADR-012: Scheduler admission uses Unix trust boundary and JSON state

## Context

CR-004 identified a mismatch between the scheduler user experience and the
current pre-flight admission model.

Today each schedule entry gets a deterministic scheduler `UserId` derived from
the schedule id. When the cron fires, the scheduler submits a periodic request
whose `RequestContext.sender` is that derived UUID. The Requests Handler then
checks that UUID against `[policy].admitted_users`. If the operator has not
copied the derived UUID into `config.toml`, the job is accepted at
`bob schedule add` time but later denied at execution time with:

`preflight denied: user not admitted by policy`

That is a bad local-operator contract. The operator who created the job was
already authorized by the Unix-domain-socket trust boundary on `admin.sock`.
Requiring a second, scheduler-specific UUID allow-list is a redundant policy
surface in the current single-user-local deployment.

CR-004 also exposed a persistence problem. S-009 made `[schedule]` inside
`config.toml` the source of truth and let `schedule.*` mutate that config file.
This mixes static service configuration with mutable operator state. Under a
Unix trust-boundary model, direct file edits should be protected by the same
Unix permissions as the local control plane, and this is clearer when schedule
state has its own persistent file.

Forces and constraints:

- ADR-008 scopes the product to one Unix trust-domain account in v1.
- ADR-005 and ADR-007 make filesystem permissions on local Unix sockets the
  real local authorization boundary.
- ADR-010 already exempts interactive chat from pre-flight UUID admission
  because socket access plus action authorization are the meaningful gates.
- Schedules are durable mutable state: they must survive reboot, support
  add/remove/list operations, and be rewritten atomically.
- Tool-call authorization remains the gate for side effects performed by the
  agent after a scheduled prompt reaches pi-agent.

## Decision

Scheduled jobs are authorized by the local Unix trust boundary, not by
scheduler-derived UUIDs in `[policy].admitted_users`.

Concretely:

1. **Scheduler UUID admission is removed.** Scheduler-originated periodic work
   must not be denied solely because a per-job scheduler `UserId` is absent from
   `[policy].admitted_users`. A schedule entry that is present in the trusted
   schedule store is admitted for firing.
2. **Schedule mutation is authorized by the control plane.** `bob schedule add`,
   `remove`, `list`, and `reload` remain JSON-RPC methods over `admin.sock`.
   Access to that socket is the Unix filesystem-permission gate defined by
   ADR-005 and ADR-007.
3. **Direct file edits are authorized by filesystem permissions.** The schedule
   store must be readable and writable only by the same Unix trust population
   that can operate bob through `admin.sock`. In the current single-user-local
   deployment this means owner-only state directories and a `0600` schedule
   file. If bob later supports a Unix group for `admin.sock`, the same group
   trust model must be applied to the schedule store.
4. **Schedules move out of `config.toml`.** `config.toml` remains static service
   configuration. Runtime schedule state is stored separately.
5. **The schedule store is a versioned JSON document.** On Linux the default
   path is:

   `$XDG_STATE_HOME/bob/schedules.json`

   falling back to:

   `~/.local/state/bob/schedules.json`

   The file contains a JSON object with a schema version and an entries array.
   The initial shape is:

   ```json
   {
     "version": 1,
     "entries": [
       {
         "id": "check-email",
         "cron": "*/15 * * * *",
         "prompt": "Check email and summarize anything urgent",
         "cwd": "/srv/workspaces/email"
       }
     ]
   }
   ```

   Each entry carries exactly one prompt source — either an inline `prompt`
   string or an absolute `file` path read fresh at each fire — plus an optional
   absolute `cwd`. The unused prompt field and an absent `cwd` are omitted on
   disk; the store version stays `1` and older `prompt`-only stores load
   unchanged.

   Implementations must write it with atomic temp-file-and-rename updates and
   preserve the required file mode.
6. **Action authorization is unchanged.** Once a scheduled prompt reaches
   pi-agent, every tool call still passes through the existing S-004
   `tool_call` action authorization gate.
7. **Prompt-file contents and the working directory are trusted, un-checked
   inputs.** A schedule entry's `file` contents and its `cwd` originate in the
   owner-only schedule store, so their *values* are trusted; bob performs **no**
   ownership or permission check on either the prompt file or the working
   directory before use. This is a deliberate relaxation, previously recorded
   only as a code comment: because pi auto-loads `AGENTS.md`/`CLAUDE.md` and
   skills from the working directory and reads the prompt file verbatim, a file
   or directory writable by another principal could inject prompt content or
   context that bypasses `[policy].admitted_users`. Operators MUST keep both the
   prompt file and the cwd under the same owner-only protection as
   `schedules.json` itself. Filesystem permissions — not a bob-side ownership
   check — are the gate.

This ADR amends ADR-005, ADR-006, ADR-007, ADR-008, ADR-009, and ADR-010 for
the scheduler path. It does not remove application-level `UserId` as a general
request/audit concept, and it does not decide the admission model for future
external or multi-user adapters.

## Consequences

### Positive

- A schedule accepted through `bob schedule add` no longer fails later because
  an operator did not discover and copy a hidden scheduler UUID into policy
  config.
- Scheduler authorization matches the current product scope: one local Unix
  trust domain guarded by filesystem permissions.
- Static service configuration and mutable schedule state are separated.
- A JSON schedule store is compact, easy to parse with `serde_json`, easy to
  version, and still inspectable during debugging.
- Direct file edits have a clear trust story: only Unix users who can write the
  protected state file can add scheduled work.

### Negative

- The explicit `[policy].admitted_users` allow-list no longer controls scheduler
  execution. This is acceptable only while scheduler state is local and guarded
  by the Unix trust boundary.
- Existing deployments with `[schedule]` entries in `config.toml` need a
  migration path to `schedules.json`.
- ADRs and approved specs that currently describe scheduler UUID admission and
  `[schedule]` in `config.toml` must be amended before implementation work
  proceeds.
- Prompt-file contents and the scheduled working directory are used without an
  ownership check; a mis-permissioned file or directory can inject trusted
  context. Acceptable only while schedule state and its referenced paths are
  guarded by the same Unix owner-only permissions as the control plane.

### Neutral

- Periodic delivery remains fire-and-forget. Jobs still do not fire while bob is
  stopped and missed ticks are not replayed.
- The scheduler remains bob-internal; no system cron entries are introduced.
- Audit should still record scheduled execution and any runtime failures, but
  denied pre-flight UUID verdicts are no longer expected for scheduler jobs.

## Alternatives Considered

### Alternative A: Keep scheduler UUID admission

**Description:** Keep deriving `UserId::from_name(schedule_id)` and require
operators to add each derived UUID to `[policy].admitted_users`.
**Rejected because:** It creates a job that can be successfully added and then
silently fail at firing time for a non-obvious second configuration step. It is
also redundant under the single-user-local Unix trust boundary.

### Alternative B: Store schedules as TOML in `config.toml`

**Description:** Preserve S-009's current model: `[schedule]` in `config.toml`
is the source of truth and `schedule.*` mutates that file.
**Rejected because:** It treats mutable runtime schedule state as static service
configuration and keeps direct-edit authorization ambiguous.

### Alternative C: Store schedules as JSONL

**Description:** Store one schedule change or entry per line in an appendable
JSONL file.
**Rejected because:** Schedules are mutable set state, not an append-only log.
Add/remove/list/reload need whole-set validation, unique id enforcement, and
atomic replacement. JSONL would require tombstones or compaction without adding
value.
