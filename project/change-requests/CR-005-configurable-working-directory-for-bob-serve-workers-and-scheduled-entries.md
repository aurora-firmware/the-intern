---
id: CR-005
title: Configurable working directory for bob serve workers and scheduled 
  entries
status: pending
created: '2026-07-05'
---

# Configurable working directory for bob serve workers and scheduled entries

## Desired Changes

Add an operator-controlled working directory (cwd) for the pi-agent worker
processes bob spawns, at two levels:

1. **Service-wide worker cwd** — a config option (proposed `pi_agent_cwd`) that
   sets the working directory of the RPC worker pool spawned by `bob serve`,
   instead of the workers implicitly inheriting the launch cwd. This lets pi
   discover project context (`AGENTS.md`/`CLAUDE.md`), skills, and prompt
   templates from a chosen directory, and makes relative paths in prompts
   resolve predictably.

2. **Per-entry cwd for scheduled jobs** — an optional `cwd` field on a schedule
   entry, surfaced as `--cwd <dir>` on `bob schedule add`, so a specific
   scheduled run executes in a specific directory, overriding the service-wide
   default. The goal is to give each scheduled job access to the instructions,
   skills, and context appropriate to it.

**Resolution & validation:** a supplied cwd must be an existing directory,
canonicalised to an absolute path at add time (mirroring the `--file` prompt
behaviour introduced on `feat/schedule-file-prompt`) and stored absolute in
`schedules.json`. At fire time a missing/invalid cwd should skip the run with a
warning, analogous to the missing-prompt-file handling.

**Precedence:** per-entry `cwd` (if set) → service-wide `pi_agent_cwd` (if set)
→ inherited launch cwd (today's behaviour).

## Context

Today bob sets **no** working directory for pi workers — there is no
`Command::current_dir(...)` in `RpcWorkerProcess::spawn` — so every worker,
including scheduled runs, inherits the cwd of the `bob serve` process. Under the
dev helper scripts that is `the-intern/service`; under systemd it is typically
`/`. This is implicit and unpredictable, and it means pi's context-file
discovery, skills discovery, and any relative paths in a prompt resolve against
an unintended directory.

Operators want a scheduled job to run "in" a chosen workspace so the agent picks
up the right instructions/skills/context per job. There is currently no
supported way to control this short of launching `bob serve` from a specific
directory, which applies globally and is awkward to script.

## Potential Impact

**Affected components / code:**

- **`config` (S-002):** new `pi_agent_cwd` config key + `BobConfig` field +
  default resolution.
- **`pi-agent-supervisor` (S-002):** `RpcWorkerProcess::spawn` (and possibly the
  interactive `InteractiveProcess::spawn`) set `current_dir`; `Config` gains a
  worker cwd; the pool `acquire_session` must support a per-session cwd for
  per-entry scheduled jobs (e.g. an `acquire_session_with_cwd`).
- **Periodic dispatch (`serve.rs::start_periodic_dispatcher`):** must obtain the
  firing entry's cwd and pass it to session acquisition. The dispatcher today
  only has the event payload (prompt) and `RequestContext` (job id in
  `context_id`); the entry cwd must be threaded to it.
- **`scheduler-adapter` (S-009):** carry `cwd` from `ScheduleEntry` into the
  dispatched event/context.
- **`bob-core` (S-009):** `ScheduleEntry` gains an optional `cwd` field (schema
  evolution, like the recent `prompt`/`file` change); `validate_schedule_store`
  requires an **absolute** path only — no directory-existence check at
  load/reload (F5: that would break whole-store rejection when a dir is removed).
  Existence is checked at fire time (skip + warn).
- **`bob-core` PersistenceStore port + inbound queue (F2, was missing):** the
  periodic path drops `RequestContext` at enqueue, so the dispatcher today has no
  job id. `PersistenceStore::{enqueue,dequeue_next}` and the inbound queue must
  carry the **job id** so the dispatcher can resolve cwd from the live schedule
  table. `InternalEvent` stays unchanged (F1).
- **`admin-rpc` (S-009):** `schedule.add` accepts an optional `cwd` param;
  `schedule.list` emits it.
- **`bob` CLI (S-009):** `--cwd` flag on `schedule add`; a config surface for the
  service-wide cwd.
- **Docs (S-007):** operator-guide schedule + configuration sections.

**Risks / migration:**

- **Warm-pool bypass.** A per-entry cwd cannot reuse a generic warm-pool worker
  (warm workers are pre-spawned with the service-wide cwd). A per-entry-cwd job
  must spawn a dedicated worker with that cwd, losing warm-pool latency and
  consuming a `max_processes` slot per distinct-cwd run. This is the single
  largest design consequence.
- **Event-model threading (ADR-004).** Carrying cwd from the schedule entry to
  the dispatcher may require extending `InternalEvent`/`RequestContext`, or a
  lookup-by-job-id against the live schedule table. This touches the
  inbound-interface contract.
- **Default behaviour change.** If the service-wide default becomes a fixed
  directory rather than "inherit," existing deployments change behaviour.
  Keeping the default = inherit avoids surprise (see recommendation below).
- **Trust boundary (ADR-012).** A scheduled job's cwd comes from the trusted,
  owner-only `schedules.json`, so the *value* is trusted; but pi will auto-load
  `AGENTS.md`/`CLAUDE.md`/skills from that directory, widening what a trusted
  schedule entry causes the agent to load. Consistent with the accepted
  decision on `feat/schedule-file-prompt` to not ownership-check external prompt
  files, no directory ownership check is proposed. This is
  acceptable for cwd as well, file system permissions will gate it.
- **Interactive chat.** `bob chat` sessions spawn pi from a separate config
  (`build_interactive_session_config`, empty args). Bob chat must use the current cwd where the bob chat command is invoked by default.
- **Validation timing.** A cwd's existence is time/environment dependent; a
  directory could be removed after add. Fire-time handling must fail gracefully
  (skip + warn) rather than crash the dispatcher.

**Default values (requested decision) — recommendation:**

- **Service-wide `pi_agent_cwd`:** default **unset → inherit `bob serve`'s launch
  cwd** (today's behaviour; backward compatible, least surprising). Document
  strongly that operators should set an explicit workspace. Do *not* silently
  default to a new directory in v1.
- **Per-entry `cwd`:** default **unset → fall back to `pi_agent_cwd`** (which
  falls back to inherited). An entry with no `--cwd` behaves exactly as today.
- **Decision (human, 2026-07-05):** default = **inherit launch cwd** (unset) for
  v1. Architect confirmed this is consistent with ADR-009 (a pi working directory
  is agent content, not a bob-managed XDG bucket, so no default location is
  implied). The XDG-workspace and home-dir alternatives were declined for v1.

## Possible Spec Amendments

- **S-002 (bob service shell architecture):** add the `pi_agent_cwd` config
  option, the worker-spawn cwd behaviour, and the default/precedence rules.
- **S-009 (scheduler channel adapter and bob schedule CLI):** add the per-entry
  `cwd` field to the schedule-store schema, the `--cwd` CLI flag, `schedule.list`
  output, validation, and fire-time cwd resolution + missing-cwd handling.
- **ADR-009 (XDG filesystem layout):** no amendment — default = inherit (agent
  cwd is not a bob-managed XDG bucket).
- **ADR-004 (inbound interface by delivery kind):** `InternalEvent` stays
  unchanged — cwd is **not** put on the delivery type (F1). The inbound
  persistence queue instead carries the **job id**; the dispatcher looks up cwd
  from the live schedule table (`ReloadHandle::subscribe`). This change to what
  the queue carries needs a **new ADR** (or ADR-004 addendum), recorded by the
  Architect once the design is settled.
- **ADR-012 (scheduler trust boundary):** record the trust relaxation explicitly
  for BOTH prompt files and cwd (today only a code comment): the value is trusted
  because it originates in the owner-only schedule store; pi auto-loads
  `AGENTS.md`/`CLAUDE.md`/skills from the cwd, so operators must keep it
  owner-only. No directory ownership check — filesystem permissions gate it.
- **S-005 (monitoring/audit):** record the resolved cwd in the scheduled-run
  audit record (human decision).
- **S-006 (channel adapter framework):** consulted as a binding constraint (no
  channel/execution context in the core delivery type); no amendment expected.
- **S-009 / ADR-012 schema reconciliation (F6):** the same S-009 edit must also
  reconcile the already-merged `prompt`|`file` split (S-009 and ADR-012 still
  show `{id, cron, prompt}`), landing
  `{id, cron, one-of{prompt|file}, optional cwd}`.

## Consistency Review Outcome & Resolved Decisions

Architect Architecture Consistency Review (2026-07-05): **CONSISTENT-WITH-CHANGES**
— no direct contradiction with any approved spec or accepted ADR; the amendments
above are the normal change-request path.

**Resolved decisions (human):**
- Scope: **combined** — service-wide + per-entry cwd stay in this one CR
  (Architect recommended splitting per-entry into its own spec; human chose
  combined).
- Service-wide `pi_agent_cwd` default: **inherit launch cwd** (unset), v1.
- Per-entry cwd data-flow: **carry the job id through the inbound queue; the
  dispatcher resolves cwd from the live schedule table** (`InternalEvent`
  unchanged).
- Audit: **record the resolved cwd** in the scheduled-run audit record (S-005).
- Trust: **no directory ownership check** — filesystem permissions gate it
  (record the relaxation in ADR-012/S-009 for both prompt-file and cwd).
- Interactive chat: **use the cwd where `bob chat` is invoked** (no change).

**Findings for the Planner to action (Architect F1–F10):**
- F1: do not put cwd on `InternalEvent` (ADR-004/S-006/S-001).
- F2: change `PersistenceStore`/inbound queue to carry the job id; Architect
  records the ADR once designed.
- F3: per-entry cwd spawns a dedicated worker (no warm-pool reuse); document the
  `max_processes`-exhaustion behaviour in S-002.
- F4: record the trust relaxation in ADR-012/S-009 (not just a code comment).
- F5: validate absolute-only at add/load; check existence at fire time
  (skip + warn).
- F6: reconcile the already-merged `prompt`|`file` split in the same S-009 edit.
- F7: default = inherit confirmed ADR-009-consistent; config split =
  `pi_agent_cwd` → `config.toml`, per-entry cwd → `schedules.json`.
- F9: (scope) human chose combined over split.
- F10: add S-006 (constraint) and S-005 (audit) to the impact/amendment lists.

## Proposed Amendment Drafts

Concrete, approvable amendment wording for S-002, S-009, S-005, ADR-012, and the
new F2 data-flow ADR lives in the companion file
`CR-005-amendment-drafts.md` (same directory). Those drafts are proposals
pending human approval; the canonical specs/ADRs are not edited until they are
approved.
