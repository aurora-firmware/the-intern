---
id: CR-004
title: Use Unix identity for scheduler admission instead of scheduler UUIDs
status: pending
created: '2026-06-29'
---

# Use Unix identity for scheduler admission instead of scheduler UUIDs

## Desired Changes

Remove the requirement to authorize scheduled jobs by adding scheduler-derived
UUID `UserId` values to `[policy].admitted_users`.

Scheduled work should be authorized using Unix identity, not an application-level
UUID that the operator has to discover from logs and copy into policy config.
The relevant identity for local authorization is the Unix user that can access
the bob control socket and create or mutate schedule entries.

The desired end state is:

- `bob schedule add` must not create a job that later fails solely because its
  derived scheduler `UserId` is absent from `[policy].admitted_users`.
- Scheduler execution must not require operators to manually maintain UUID
  allow-list entries for each schedule id.
- If scheduler admission still needs an explicit identity, it must be based on
  Unix identity captured from the control-plane caller or another Unix ownership
  signal, not on a synthetic scheduler UUID.
- Remove unnecessary policy configuration and checks where Unix socket access is
  already the authoritative local authorization boundary.
- Move scheduled entries out of the static `config.toml` policy/config file
  into a dedicated persistent schedule store whose filesystem permissions match
  the local Unix trust boundary.
- The schedule store should live in persistent state, not runtime storage, so
  schedules survive reboot. Candidate location: `$XDG_STATE_HOME/bob/schedules.json`
  with fallback to `~/.local/state/bob/schedules.json` on Linux.
- The schedule store should use a compact programmatic format, preferably a
  versioned JSON document, because schedules are mutable runtime state owned by
  bob rather than human-authored static configuration. JSONL is not preferred:
  schedule mutation needs whole-set validation, replacement, and deletion rather
  than append-only log semantics.
- The schedule store's parent directory and file permissions must prevent
  modification by Unix users who cannot also operate bob through the local
  control plane. For the current single-user deployment this likely means an
  owner-only directory and `0600` file; if a future Unix group is allowed to use
  `admin.sock`, the same group trust model must apply to the schedule store.
- Keep tool-call authorization policy separate; this request is about admission
  of scheduled entries into execution, not the per-tool action allow-list.

## Context

The current implementation derives a stable scheduler `UserId` from each
schedule entry id using `UserId::from_name(entry.id)`. When the cron fires, the
scheduler submits a `Periodic` request whose `RequestContext.sender` is that
derived UUID. The Requests Handler then runs pre-flight admission against
`[policy].admitted_users`. If the derived UUID is absent, the event is dropped
and audit records show:

`preflight denied: user not admitted by policy`

This is surprising because the operator was already authorized to create the
job through `admin.sock`. The operator does not naturally know the derived UUID,
and requiring them to find it in logs and copy it into `config.toml` creates an
unnecessary second admission step.

The current design also stores schedule entries in `config.toml`, which mixes
static service configuration and mutable operator state. Under a Unix-identity
authorization model that creates an unnecessary direct-edit ambiguity: schedule
entries inserted by hand into `config.toml` do not pass through `admin.sock`.
A dedicated schedule state file with permissions aligned to the Unix control
plane would make the trust boundary explicit for both CLI mutations and direct
file edits.

Known current `UserId` admission/rejection usage:

- `policy-control::PolicyEngine::evaluate_admission` checks whether a
  `bob_core::types::UserId` is present in the policy snapshot's
  `admitted_users` list.
- `requests-handler::run_preflight` applies that admission check to queued
  requests before persistence/dispatch.
- The scheduler is the shipped queued adapter today, so it is the visible
  affected path.
- Future non-interactive adapters that submit through the Requests Handler would
  also inherit this `UserId` admission behavior unless the architecture is
  amended.
- Interactive sessions are already exempt from pre-flight admission and rely on
  local socket access.
- Tool-call authorization uses action rules for tool name/arguments; it is not a
  `UserId` admission check.

## Potential Impact

Affected areas:

- S-004 policy-control pre-flight admission semantics.
- S-009 scheduler channel adapter and `bob schedule` CLI behavior.
- ADR-010, which currently says pre-flight admission remains in force for
  non-interactive/programmatic intake such as the scheduler adapter.
- Operator documentation for scheduled job policy and the
  `[policy].admitted_users` section.
- Scheduler adapter request context construction.
- Requests Handler pre-flight admission behavior for scheduler-originated
  requests.
- Admin-RPC listener/dispatcher if Unix peer credentials need to be passed from
  socket accept into schedule mutation handling.
- Schedule persistence: schedule entries should move out of the `[schedule]`
  section in `config.toml` and into a dedicated persistent schedule store.
- Filesystem layout and operator docs for the new schedule store path and
  permissions.

Risks and considerations:

- Removing scheduler UUID admission may weaken the explicit per-adapter
  allow-list model from S-004; the replacement Unix-identity boundary must be
  stated clearly.
- Moving schedules out of `config.toml` changes the persistence contract from
  S-009 and needs a migration path for existing `[schedule]` entries. [TODO]
- The new schedule store needs an explicit schema and write contract. Candidate
  shape: a JSON object with a `version` field and an `entries` array containing
  `{ id, cron, prompt }` objects, written by atomic temp-file-and-rename updates
  with mode `0600`.
- The schedule store must not live under the runtime directory used for
  `admin.sock`; runtime storage is ephemeral, while schedules must survive
  reboot. Use persistent state storage with Unix permissions matching the
  control-plane trust boundary.
- If schedule entries can still be edited directly, direct-file authorization
  should be by filesystem ownership/permissions matching `admin.sock` access,
  not by scheduler UUID policy. [TODO]
- If future adapters are intended to serve multiple users or remote channels,
  removing `UserId` admission globally may be too broad. The amendment should
  distinguish scheduler/local-control-plane intake from future external
  adapters. [TODO]
- Existing deployments with scheduler UUIDs in `[policy].admitted_users` need a
  migration note; those entries should become unnecessary for scheduler jobs.

## Possible Spec Amendments

- Amend S-004 to remove scheduler-derived UUID admission as a requirement for
  scheduled jobs, or to scope pre-flight `UserId` admission only to adapters
  that provide meaningful application-level user identities.
- Amend S-009 so scheduled job admission is satisfied by Unix-authorized
  schedule creation/mutation, not by manual `[policy].admitted_users` entries,
  and so schedule persistence moves from `config.toml` to a dedicated persistent
  JSON schedule store.
- Amend ADR-010 or add a follow-up ADR clarifying that local scheduled work is
  governed by Unix socket/config ownership rather than per-job scheduler UUID
  admission.
- Amend ADR-009 or add a follow-up filesystem-layout decision to define the
  dedicated schedule store path, lifecycle, format, and permissions.
- Update operator docs to remove instructions requiring operators to copy
  scheduler `user_id` values into `[policy].admitted_users` and to document the
  new schedule store path and permission model.
