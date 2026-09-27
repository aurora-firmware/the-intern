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
explicit, audit-visible failure instead of a silent no-op. Two parts, mirroring
the service-wide + per-entry shape CR-005 established for `pi_agent_cwd`/`cwd`:

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
3. **Pre-dispatch validation** — before a periodic (scheduled) job fires,
   resolve its effective model (per-entry → service-wide → none) and, when
   set, run `pi auth check --model <pattern> --json` (confirmed real command;
   see Context). A `status` other than `"ready"` skips the fire — reusing the
   same fail-gracefully-with-a-warning pattern S-009 already uses for a
   missing/invalid `cwd` — and records a structured, audit-visible failure
   (see Possible Spec Amendments — S-005) instead of silently no-op'ing.
   `bob chat` (interactive) hits the same validation synchronously and
   surfaces the failure directly as a CLI error, since there is a caller to
   report it to and no fire-and-forget audit path is needed there.

**Open scope question:** should pre-dispatch validation run on every periodic
fire (adds one `pi auth check` subprocess per fire — latency/cost scales with
cron frequency), or be cached/rate-limited? Flagging for the Architect/human
rather than deciding here.

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
- **`pi-agent-supervisor` — pre-dispatch validation:** a new step (likely in
  or alongside `start_periodic_dispatcher`, `crates/bob/src/serve.rs:827`)
  that runs `pi auth check --model <pattern> --json` before acquiring a
  session for a fire whose resolved model is set, and skips + warns on a
  non-`"ready"` status — mirroring the existing missing/invalid-`cwd`
  skip+warn pattern.
- **`admin-rpc` (S-009):** `schedule.add` accepts an optional `model` param;
  `schedule.list` emits it — same shape as the existing `cwd` param.
- **`bob` CLI (S-009):** `--model` flag on `schedule add`; a config surface
  for the service-wide pin.
- **`bob-core` / `monitoring` (S-005):** a structured, audit-visible record
  of a pre-dispatch validation failure. **Open question (Architect):**
  `ExtensionEventAuditPayload` (`crates/bob-core/src/types/records.rs:54-64`)
  represents a *forwarded extension event* — a validation failure happens
  entirely inside pi-agent-supervisor/scheduler-adapter, before any pi
  process or extension exists, so it doesn't naturally fit that payload
  shape. Candidates: (a) a new `AuditRecordKind` variant with its own
  structured payload (`job_id`, `provider`, `model`, `status`, `reason` —
  matching `pi auth check --json`'s own output shape, confirmed live:
  `{"status":"invalid","provider":"...","reason":"invalid_state"}`), which
  S-005's Component 1 currently says is *not* introduced ("the record-kind
  set stays `event`/`report`/`verdict`") — this CR would change that; or
  (b) reuse `report`, which is semantically for *external* tool reports, not
  scheduler-internal state. Leaving the exact shape as `[TODO]` for the
  Architect/Planner rather than inventing it here.

**Risks / migration:**

- **Default behaviour change.** As with CR-005's `pi_agent_cwd`, the least
  surprising default is **unset → no `--model` passed** (today's behaviour,
  pi's own persisted selection). Silently defaulting to a specific model
  would be a bigger behaviour change than this CR intends. `[TODO]` —
  requested human decision, same as CR-005's cwd default.
- **`pi auth check` cost/latency per fire.** See the open scope question in
  Desired Changes — every periodic fire with a resolved model would spawn an
  extra `pi` subprocess before dispatch unless this is rate-limited/cached.
- **Unverified failure-mode coverage.** This CR's validation step confirms
  the model is *currently* auth-ready; it's still unconfirmed whether the
  originally reported failure mode (persisted-but-now-invalid model) would
  have produced a `pi auth check` failure specifically, versus some other
  status. No live repro was possible here (no real provider credentials in
  this environment). This CR should still resolve the *category* of failure
  (stale model reference surviving an upgrade) even if the exact reported
  incident's `pi auth check` output can't be confirmed in advance.
- **Interactive `bob chat` validation failure UX.** Needs a clear, synchronous
  CLI error message shape — `[TODO]`, not designed here.
- **New `AuditRecordKind` variant (if chosen)** touches `AuditFilterKind`,
  `bob audit tail`'s renderer, and S-005 Component 1's explicit "no new kind"
  language — larger than a typical CR-005-style field addition. Flagging for
  the Architect to size/scope, possibly recommending a split (config+pin as
  one CR, validation+audit as a second) the way CR-005 itself was offered a
  split and the human chose to combine.

## Possible Spec Amendments

- **S-002 (bob service shell architecture):** add the `pi_agent_model` config
  option, its use on every spawned `pi` command line (worker pool and
  interactive), and the default/precedence rules — same shape as the
  existing `pi_agent_cwd` section.
- **S-009 (scheduler channel adapter and bob schedule CLI):** add the
  per-entry `model` field to the schedule-store schema, the `--model` CLI
  flag, `schedule.list` output, and fire-time behaviour: resolve the
  effective model, run `pi auth check`, skip + warn on failure (mirroring
  the existing missing/invalid-`cwd` fire-time handling).
- **S-005 (monitoring/audit):** record a structured pre-dispatch validation
  outcome. Exact shape (new `AuditRecordKind` vs. reusing an existing kind)
  is `[TODO]` — see Potential Impact above; this is the amendment most
  likely to need Architect judgment rather than being a mechanical follow of
  the CR-005 precedent.
- **ADR-013 (inbound queue carries job id, dispatcher resolves live state):**
  no amendment expected — per-entry `model` resolution reuses the exact
  mechanism this ADR already established for `cwd`.
- **ADR-009 / ADR-012:** consulted as constraints (XDG layout; scheduler
  trust boundary), same as CR-005's own review — no amendment expected
  unless the Architect finds otherwise; a schedule entry's `model` field is
  operator-authored data in the same owner-only trusted store as `cwd`/
  `prompt`, not a new trust surface.
