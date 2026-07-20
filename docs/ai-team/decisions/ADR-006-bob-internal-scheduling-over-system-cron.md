---
id: ADR-006
title: Bob-internal scheduling over system cron
status: accepted
created: '2026-06-11'
---

# ADR-006: Bob-internal scheduling over system cron

## Context

S-009 (Scheduler Channel Adapter and bob schedule CLI) introduces periodic
job execution to bob. A design choice is required: should scheduled jobs be
driven by an OS-level scheduler (crontab, systemd timer) that invokes bob as a
subprocess, or should the scheduler live entirely inside the bob process?

The forces at play:

- Scheduled jobs submit `periodic` requests to the internal queue for pi-agent
  to process. If bob is not running, there is no queue, no pi-agent, and no
  meaningful target for a fired job.
- The operator already manages the schedule through bob (`bob schedule`
  subcommands and bob-owned persistent schedule state). Splitting control
  across bob and the OS scheduler creates two separate management surfaces for
  the same concern.
- A job that fires outside the service lifetime either fails silently (the
  invocation errors out) or produces partial side-effects with no audit trail in
  the monitoring layer.

## Decision

Scheduled jobs are managed and fired entirely within the bob process. No system
cron entries (crontab, systemd timers, launchd plists, etc.) are created or
required. The scheduler adapter actor, running inside `bob-serve`, owns the
cron tick loop. If bob is down when a job would have fired, that job is skipped
and not replayed when the service restarts. The operator controls the full
schedule lifecycle through bob.

> **Amended (ADR-012, 2026-06-30).** The scheduler remains bob-internal, but the
> persistent source of schedule state is no longer `bob.toml`. Schedule entries
> live in the dedicated JSON state store defined by ADR-012; `bob schedule`
> remains the operator control surface.

## Consequences

### Positive

- A single control surface: the operator uses `bob schedule` and bob-owned
  schedule state for all schedule management; no OS-level files need to be
  created, rotated, or removed alongside the service.
- Job lifecycle is tied to service health by design: no invocation reaches
  pi-agent unless bob is running, eliminating a class of race conditions and
  partial failures.
- The monitoring layer (S-005) captures every tick's queue admission or denial;
  this audit trail would be absent for externally-fired invocations.

### Negative

- Jobs do not fire while bob is stopped. Operators who need guaranteed delivery
  across restarts must ensure bob is kept running (e.g. via a process
  supervisor such as systemd) or accept that missed ticks are skipped.
- Bob becomes a dependency for anything time-critical. A service crash that
  goes undetected will silently skip scheduled jobs rather than surfacing a
  failure.

### Neutral

- Missed ticks are not replayed. This is consistent with the `periodic`
  delivery kind's fire-and-forget semantics (ADR-004): a `periodic` trigger has
  no caller waiting for a receipt, and no retry contract.
- Operators who want guaranteed execution can layer a process supervisor (e.g.
  systemd with `Restart=always`) on top of bob; that is an operational concern,
  not a design concern for this spec.

## Alternatives Considered

### Alternative A: System cron invokes bob as a subprocess

**Description:** Each scheduled job is a crontab or systemd timer entry that
runs `bob run-job <id>` (or similar) at the configured time. Bob is only a job
runner, not a scheduler.
**Rejected because:** Jobs fire even when the bob service is down, producing
failed invocations with no queue, no pi-agent, and no audit trail. The operator
must manage two separate control surfaces (crontab entries and bob schedule
state), keeping them in sync manually. There is no natural place to enforce the
local scheduler admission contract on externally-fired jobs.

### Alternative B: Hybrid — system cron triggers bob, which checks service health

**Description:** A crontab entry calls a wrapper script that checks whether bob
is running and, if so, forwards the job to the live service over `admin.sock`.
**Rejected because:** This reintroduces OS-level entries the operator must
manage, adds a wrapper script that must be installed and maintained alongside
the binary, and still fails silently if bob is not running (the script exits
without firing). The complexity cost exceeds the benefit over a simple
"scheduler lives in bob" approach.
