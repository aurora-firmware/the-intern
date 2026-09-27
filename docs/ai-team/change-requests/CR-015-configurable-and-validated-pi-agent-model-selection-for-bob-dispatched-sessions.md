---
id: CR-015
title: Configurable and validated pi-agent model selection for bob-dispatched 
  sessions
status: pending
created: '2026-09-27'
---

# Configurable and validated pi-agent model selection for bob-dispatched sessions

## Desired Changes

Stop letting the pi-agent model bob dispatches with be whatever pi's own
persisted settings last selected, and make an invalid/removed model an
explicit, audit-visible failure instead of a silent no-op — reactively, not
via a proactive check. Config mirrors the service-wide + per-entry shape
CR-005 established for `pi_agent_cwd`/`cwd`:

1. **Service-wide model pin** — a config option (proposed `pi_agent_model`)
   that bob always passes as `--model <pattern>` on every `pi` invocation it
   spawns (worker pool and interactive `bob chat`), instead of relying on
   pi's own persisted last-selected model. This is the actual fix for the
   reported incident: pi's persisted settings survived a pi upgrade that
   removed the previously-selected model from the registry, and nothing
   forced a re-selection.
2. **Per-entry model override** — an optional `model` field on a schedule
   entry, surfaced as `--model <pattern>` on `bob schedule add`, overriding
   the service-wide pin for that one job — same precedence shape as `cwd`
   (per-entry → service-wide → today's behaviour, i.e. no `--model` passed
   at all, unset by default for backward compatibility).
3. **No preflight check.** Deliberately excluded (human decision, 2026-09-27):
   no `pi auth check` or other proactive validation call before a periodic
   fire. It's enough that bob is *able to pass* `--model` — if the resolved
   model is invalid, `pi` itself already fails fast and loud on it (confirmed
   live: `pi --model <invalid> --print "..."` exits 1 with `Error: Model
   "..." not found` before any provider request — no credentials needed to
   hit this path). Detection is reactive, off the resulting spawn/handshake
   failure, not a separate proactive check — see Context and Potential
   Impact for why this already has almost nowhere new to go: bob's periodic
   dispatcher already warns (and, for one of its two acquisition paths,
   already persists to the audit stream) on a session-acquisition failure
   today, for unrelated reasons (missing cwd, pool exhaustion). An invalid
   `--model` goes through the same `acquire_session` failure path — this CR
   only needs to make sure that path's existing warning is consistently
   audit-visible (see Possible Spec Amendments — S-005), not invent a new
   detection or audit mechanism.

**Interim mitigation (no code change):** `pi_agent_args` (`crates/bob/src/
config.rs:37`) is already a free-form `Vec<String>` passed straight to the
`pi` command line (`crates/pi-agent-supervisor/src/process.rs:65`), so an
operator can pin a model *today* by adding `--model <x>` to their own
`pi_agent_args` in `config.toml` — no bob code change required. This CR is
about making that the supported, validated, documented default rather than
an undocumented workaround, and about the auto-fail-loud behavior when the
pinned model itself later goes stale.

## Context

Filed from issue #104: the `daily-standup` scheduled job silently sent no
email after a pi upgrade changed the supported model registry. pi's
persisted settings still selected the old model name; the session received
one provider response and ended ~1s later with no tool call. bob's audit
stream recorded only ordinary-looking session lifecycle events — nothing
distinguished this from a normal successful dispatch.

The original issue framing ("bob's audit stream doesn't capture
provider-level failures") turned out to be the wrong shape for a fix:

- Investigating what `bob` could even capture, `AfterProviderResponseEvent`
  (pi's own extension event type, `@earendil-works/pi-coding-agent`'s
  `types.d.ts:462-466`) carries only an HTTP `status`/`headers` — it only
  fires if pi actually reaches the provider's HTTP layer. A client-side
  "model not in my registry" rejection inside pi may never produce this
  event at all (unverified from this repo; would need a live repro against
  real provider credentials or pi's own docs — both outside this repo's
  reach, matching #104's original diagnosis).
- Even where an event *does* fire, `MonitoringBackedHandle::record_event`
  (`crates/extension-ipc/src/multiplex.rs:104-114`) hardcodes
  `summary: None` for every forwarded event — discarding the entire
  `data` payload before persistence, not just for provider-response events.
  S-005's own "Schema beats blobs" design principle (and the CR-005
  precedent of adding `resolved_cwd` as a typed field rather than dumping
  payload content) argues against just starting to populate that blob;
  whatever gets captured should be a bob-defined structured field.
- Prevention beats detection here anyway: bob already fully controls the
  `pi` command line (see interim mitigation above) but never pins a model,
  so the actual gap is upstream of "what does the audit stream capture."

## Potential Impact

**Affected components / code:**

- **`config` (S-002):** new `pi_agent_model` config key + `BobConfig` field
  + default resolution, mirroring `pi_agent_cwd` (`crates/bob/src/
  config.rs:49`, validated at `config.rs:298-303`).
- **`pi-agent-supervisor` (S-002):** `WorkerProcessConfig`/
  `InteractiveProcessConfig` (`crates/pi-agent-supervisor/src/
  process.rs:15-17,273-275`) already carry a free-form `args: Vec<String>`
  passed to `Command::new(&cfg.command).args(...)` — resolving the model
  means appending `--model <pattern>` to that vec before spawn, not a new
  spawn-time mechanism.
- **`bob-core` (S-009):** `ScheduleEntry` (`crates/bob-core/src/types/
  schedule.rs:485-494`) gains an optional `model` field, same shape as the
  existing `cwd` field (schema evolution, unset omitted from serialization
  so old stores keep loading).
- **Periodic dispatch / `scheduler-adapter` (S-009):** the per-entry `cwd`
  resolution already threads the firing job's id through the inbound queue
  so the dispatcher can resolve live schedule-table state at fire time
  (ADR-013, `crates/scheduler-adapter/src/lib.rs` — `context_id: Some(job_id
  .clone())`); per-entry `model` resolution reuses this exact mechanism, no
  new ADR expected for data flow.
- **`admin-rpc` (S-009):** `schedule.add` accepts an optional `model` param;
  `schedule.list` emits it — same shape as the existing `cwd` param.
- **`bob` CLI (S-009):** `--model` flag on `schedule add`; a config surface
  for the service-wide pin.
- **`bob` periodic dispatcher — reuse existing failure handling, no new
  mechanism (S-005):** `crates/bob/src/serve.rs` already has two
  session-acquisition failure paths for a periodic fire:
  - `acquire_default_session_or_warn` (serve.rs:703-716, the plain
    `acquire_session` path a service-wide-only `--model` pin would use) logs
    `tracing::warn!` on failure today, but does **not** call
    `record_periodic_fire_skipped` — so it isn't visible in `bob audit tail`,
    only in raw service logs.
  - the per-entry-cwd path (`acquire_session_with_cwd` failure, serve.rs
    ~856-925) already calls **both** `tracing::warn!` *and*
    `record_periodic_fire_skipped` (serve.rs:627-655) — a generic function,
    already explicitly designed to avoid a new `AuditRecordKind` ("reuses the
    existing `Report`/`ExternalReportAuditPayload` shape... rather than
    introducing a new `AuditRecordKind`", serve.rs:622-624), keyed by
    `job_id` and a free-text `summary`.

  An invalid `--model` causes `RpcWorkerProcess::spawn`/the RPC handshake to
  fail the same way any other unusable worker does (pi exits immediately
  after printing its "Model not found" error and closing its pipes), which
  surfaces as a `ServiceError` from `acquire_session()` — the exact same
  failure shape `acquire_default_session_or_warn` already handles. **The only
  actual gap to close**, not a new design: call `record_periodic_fire_skipped`
  from `acquire_default_session_or_warn`'s failure arm too, so a bad model
  pin is as audit-visible as a bad cwd already is. No schema change, no new
  `AuditRecordKind`, no new function.

**Risks / migration:**

- **Default behaviour change.** As with CR-005's `pi_agent_cwd`, the least
  surprising default is **unset → no `--model` passed** (today's behaviour,
  pi's own persisted selection). Silently defaulting to a specific model
  would be a bigger behaviour change than this CR intends. `[TODO]` —
  requested human decision, same as CR-005's cwd default.
- **No preflight means the failure surfaces at the first real fire, not
  before.** A bad model pin isn't caught until a scheduled job actually tries
  to run (or an operator runs `bob chat`) — this is the explicit tradeoff of
  the "just log a warning, the operator fixes the config" decision above,
  not an oversight. Reactive, not proactive, by design.
- **Warm-pool workers spawned with a bad model die almost immediately.** Since
  `RpcWorkerProcess::spawn` doesn't wait for any readiness handshake (it
  returns `Ok` as soon as the OS starts the process), a warm-pool worker
  spawned with an invalid `--model` becomes unusable within moments of
  spawning, and the failure is only discovered on the next attempt to use it
  (send it a prompt). Whether the existing pool/reaper logic already notices
  and respawns a dead warm worker, or needs a small addition to do so, is
  `[TODO]` — worth a quick look during task breakdown, not a new design
  question.
- **Interactive `bob chat` validation failure UX.** `pi` itself already prints
  a clear, immediate error and exits nonzero for a bad `--model` (confirmed
  live) — whether bob's interactive spawn path already surfaces that
  cleanly to the `bob chat` caller or needs a small adjustment is `[TODO]`,
  to confirm during implementation rather than assumed here.

## Possible Spec Amendments

- **S-002 (bob service shell architecture):** add the `pi_agent_model` config
  option, its use on every spawned `pi` command line (worker pool and
  interactive), and the default/precedence rules — same shape as the
  existing `pi_agent_cwd` section.
- **S-009 (scheduler channel adapter and bob schedule CLI):** add the
  per-entry `model` field to the schedule-store schema, the `--model` CLI
  flag, and `schedule.list` output — same shape as the existing `cwd` field.
  No new fire-time validation step; a bad model is discovered the same way a
  bad cwd already is, by the acquisition/dispatch attempt itself failing.
- **S-005 (monitoring/audit):** no schema change. The only amendment is
  behavioural: `acquire_default_session_or_warn`'s existing failure path
  should also call the existing `record_periodic_fire_skipped` (today only
  the per-entry-cwd failure path does), so a session-acquisition failure —
  including a bad model pin — is as audit-visible as a bad cwd already is.
  Purely mechanical, no Architect design judgment expected here.
- **ADR-013 (inbound queue carries job id, dispatcher resolves live state):**
  no amendment expected — per-entry `model` resolution reuses the exact
  mechanism this ADR already established for `cwd`.
- **ADR-009 / ADR-012:** consulted as constraints (XDG layout; scheduler
  trust boundary), same as CR-005's own review — no amendment expected
  unless the Architect finds otherwise; a schedule entry's `model` field is
  operator-authored data in the same owner-only trusted store as `cwd`/
  `prompt`, not a new trust surface.
