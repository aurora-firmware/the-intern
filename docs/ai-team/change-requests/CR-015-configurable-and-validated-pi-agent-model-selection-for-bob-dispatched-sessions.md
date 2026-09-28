---
id: CR-015
title: Configurable and validated pi-agent model selection for bob-dispatched 
  sessions
status: applied
created: '2026-09-27'
---

# Configurable and validated pi-agent model selection for bob-dispatched sessions

## Desired Changes

Make bob's own configuration the single place where the pi-agent model for
bob-dispatched sessions is set, so a stale model fails loudly instead of
being silently replaced, and make that failure visible in bob's logs.

1. **One config key owns the model (S-002).** A new optional key,
   `pi_agent_model` — a flat top-level `snake_case` key (ADR-002), alongside
   `pi_agent_command`, `pi_agent_args`, and `pi_agent_cwd`. When set, bob
   passes its value verbatim to pi as `--model <value>` on **every** pi
   process it spawns: warm pool workers, dedicated per-entry-cwd workers, and
   interactive `bob chat` sessions. Unlike `pi_agent_cwd`, which governs only
   the RPC worker pool, `pi_agent_model` also applies to `bob chat`. bob does
   not interpret, enumerate, or default the value; any pattern pi accepts for
   `--model` (for example `provider/id`, optionally with a thinking suffix)
   is valid. The `--model` argument is built in one shared place that every
   spawn path uses, not separately per path — the drift risk ADR-014 cited
   when it rejected per-path construction of skill arguments applies here
   too.
2. **No second way to set it (S-002).** `pi_agent_args` — today defined only
   in code — becomes a specified key: an argument list passed verbatim to RPC
   pool workers only (default `--mode rpc`), never applied to `bob chat`.
   Config load rejects it if it contains any model-selecting pi flag
   (`--model`, `--models`, `--provider`), with a configuration error that
   names `pi_agent_model` as the place to set the model. There is no
   per-schedule-entry model and no `--model` flag on `bob chat` or `bob
   schedule add`.
3. **Unset is allowed but warned clearly (S-002).** When `pi_agent_model` is
   unset, bob passes no `--model` and pi chooses from its own saved settings
   (today's behaviour). bob logs one warning at startup that states exactly
   what is missing and why it matters: that `pi_agent_model` is not set in
   the service configuration, that pi will therefore choose the model from
   its own saved settings, that those settings can change and can fall back
   to a different model without notice, and how to set the key. `bob init`
   is unchanged: the configuration it generates leaves the key unset and it
   prints nothing new; the startup warning is the only prompt.
4. **Worker stderr reaches bob's logs (S-002, S-003).** The supervisor reads
   each RPC pool worker's stderr and records it in bob's service log at
   warning level, tagged with the worker's session. An invalid
   `pi_agent_model` therefore shows up in the service log as pi's own error
   message. This also makes the bob extension's existing stderr warnings
   (S-003) visible for pool workers. Interactive `bob chat` sessions are
   unchanged: pi writes to the user's own terminal, so the user sees the
   error directly.
5. **No proactive validation, no audit change.** bob runs no check before a
   fire and adds no audit record for this failure. A worker started with an
   invalid model logs its error and exits immediately. A fire handed that
   worker fails at prompt delivery; the periodic dispatcher logs a warning and
   kills the session at once, as it already does for any prompt-delivery
   failure. A dead warm worker stays in the pool until a fire picks it up and
   meets the same outcome — the reaper does not check liveness and the warm
   pool is only filled at service start — so at most the warm-pool size of
   them exist at once and none leak. No dispatched-fire record is written,
   because the prompt was never accepted.
6. **The bob-companion plugin teaches verification (documentation).** The
   `bob-setup` skill documents `pi_agent_model` as the one place to set the
   model — including in its list of notable config keys — and instructs the
   agent to verify a chosen value before relying on it: `pi --list-models
   <search>` to confirm the model exists and see its exact `provider/id`, and
   `pi auth check --provider <p> --json` to confirm that provider's
   credentials are ready. The `bob-troubleshooting` skill covers the failure
   symptoms — a scheduled job that ran but did nothing, a "model not found"
   line in the service log, the startup warning about an unset
   `pi_agent_model`, or a config-load error about model flags in
   `pi_agent_args` — and points to the same two checks. Both skills describe
   the checks' limits (see Context) as observed pi behaviour, not as a stable
   contract, so the agent does not over-trust them.

## Context

Filed from GitHub issue #104. The `daily-standup` scheduled job silently sent
no email after a pi upgrade changed the supported model registry. pi's saved
settings still named the old model; the session received one provider
response and ended about a second later with no tool call. bob's audit
stream showed only ordinary lifecycle events, so the fire looked like a
normal successful dispatch.

The issue's original framing — "the audit stream doesn't capture
provider-level failures" — was the wrong shape for a fix. pi's
`after_provider_response` extension event carries only an HTTP status and
headers, pi exposes no "model invalid" event, and persisting raw event data
would go against S-005's "Schema beats blobs" principle. The actual cause is
upstream: how pi picks a model when bob does not give it one.

**How pi chooses a model** (verified against the installed pi's model
resolver and live runs; no provider credentials needed; the tested version is
recorded in `README.md`, not here):

1. An explicit `--model` on the command line wins. If it does not resolve,
   pi prints `Error: Model "<x>" not found. Use --list-models to see
   available models.` and exits 1 before any provider request — in both
   `--print` and `--mode rpc` (the mode bob's workers use).
2. Otherwise pi uses the model saved in its own settings file — but only if
   that model still resolves and its provider has credentials.
3. Otherwise pi **silently** falls back to a built-in default or the first
   available model with credentials. No warning is printed.

Case 3 is the #104 incident. Two properties rule out pi's settings file as
the place to set bob's model:

- **It fails silently.** A stale saved model is replaced without notice.
- **It is shared, mutable state.** pi rewrites its saved model whenever a
  model is selected or cycled in any session. A `bob chat` user switching
  models would change the model every scheduled job then runs on.

`pi_agent_args` is also unsuitable as the place: it is only passed to pool
workers — interactive `bob chat` sessions are spawned with no extra
arguments — and it carries worker-only flags such as `--mode rpc`.

**Worker stderr is currently discarded.** Pool workers' stderr is piped but
never read, so pi's "model not found" error from a worker never reaches
bob's logs today. Item 4 closes that gap.

**Verification commands: for operators and their agents, not for bob.** pi
offers `pi auth check --provider <p> --json` (machine-readable provider
credential status; observed: `ready` exits 0, `not_ready` exits 1, `invalid`
exits 2) and `pi --list-models [search]` (available models). bob itself does
not call either — no proactive check (item 5) — because neither is a
reliable automated gate: `auth check` validates provider credentials only,
not whether a model exists (an unknown model under a configured provider
still reports `ready`, and a model given without its provider prefix is
misread as a provider name), and `--list-models` prints a human-readable
table with no JSON mode, uses fuzzy matching, and exits 0 when nothing
matches. They are, however, the right tools for a person or agent confirming
a configuration by hand, which is why item 6 documents them in the
bob-companion plugin. The reliable model check remains pi's own `--model`
refusal (case 1 above).

## Potential Impact

**Affected areas.**

- **Config (S-002):** new `pi_agent_model` key; `pi_agent_args` specified
  and restricted; startup warning when `pi_agent_model` is unset.
- **pi-agent-supervisor (S-002, S-003):** one shared builder adds `--model`
  to the argument list of warm workers, dedicated per-entry-cwd workers, and
  interactive sessions — no new spawn mechanism. Pool workers gain a stderr
  reader that forwards lines to the service log.
- **Interactive sessions:** the interactive spawn configuration, which today
  passes no extra arguments to pi, gains `--model` when the key is set. The
  interactive-session protocol (ADR-011) is unchanged.
- **Operator documentation:** the bob-companion `bob-setup` and
  `bob-troubleshooting` skills (item 6); the user manual's configuration
  reference, operator guide, and quickstart, which must document the new
  key, the rejected `pi_agent_args` flags, and a migration note for
  configurations that already put `--model` in `pi_agent_args`. Shipped
  skill and manual text follows `coding-guidelines-skills.md`: no internal
  task, bug, spec, ADR, or issue IDs; no pi version; no
  environment-specific model or provider names presented as defaults —
  examples use clearly placeholder values.
- **`README.md`:** the pi compatibility section is updated to the pi version
  this CR's behaviour was verified against (the current section predates the
  upgrade behind #104).

**Testing.** Each spawn path — warm pool worker, dedicated per-entry-cwd
worker, interactive session — needs a test showing `--model` is present when
`pi_agent_model` is set and absent when unset; config-load tests cover each
rejected `pi_agent_args` flag; a supervisor test shows worker stderr lines
reach the service log.

**Behaviour of an invalid model.** Warm pool workers are spawned ahead of
any fire, and spawning does not wait for pi to become ready. A worker
started with an invalid model logs pi's error (item 4) and exits within
moments. Session acquisition does not check worker liveness, so a fire can
still be handed that worker; the fire then fails at prompt delivery, the
dispatcher logs a warning and kills the session. A dead warm worker waits in
the pool until a fire picks it up this way; later fires start fresh workers
that fail and are killed the same way. The job does not run until
an operator fixes `pi_agent_model` — explicit failure is the intended
outcome; the setting does not self-heal.

**Risks and migration.**

- **Existing configs using `--model` in `pi_agent_args`** will fail to load
  after this change. The error message names `pi_agent_model`, and the
  operator guide carries a migration note.
- **Default unchanged.** Leaving `pi_agent_model` unset keeps today's model
  behaviour; the only difference is the startup warning, which every fresh
  `bob init` install will show until the key is set. This is intended.
- **Stderr volume.** Forwarding worker stderr into the service log could add
  noise if pi writes routinely to stderr (for example with tracing
  enabled). `[TODO]` Confirm during breakdown whether pi writes anything to
  stderr in normal RPC operation, and whether forwarded lines need rate
  limiting. Reading the pipe also removes a latent hazard: a never-read
  stderr pipe that fills up blocks the writing process.

## Possible Spec Amendments

- **S-002 (bob service shell architecture):**
  - Configuration section: add `pi_agent_model` next to `pi_agent_cwd` (what
    it is, where it lives, that it applies to every spawned pi including
    `bob chat`, unset behaviour and the content of the startup warning); add
    `pi_agent_args` as a specified key (pool-only passthrough, default
    `--mode rpc`, not applied to `bob chat`, must not contain `--model`,
    `--models`, or `--provider`).
  - Component 7 (interactive chat): state that `pi_agent_model`, unlike
    `pi_agent_cwd`, applies to the interactive session.
  - Interactive chat workflow: add `--model <pi_agent_model>` (when set) to
    the list of what the supervised pi child is started with.
  - Responsibility table, Pi-agent Supervisor row: add passing `--model` on
    every spawn and forwarding pool-worker stderr to the service log.
  - Component 6 (warm pool): add the outcome "prompt not accepted (for
    example an invalid `pi_agent_model`) → service-log warning only, session
    killed; no dispatched-fire record".
  - Deliverables: the operator-documentation updates (item 6; the manual's
    configuration reference, operator guide with migration note, and
    quickstart) and the `README.md` pi compatibility update, following the
    precedent S-014 and S-015 set for bob-companion updates.
- **S-003 (JS extension for pi-agent event forwarding):** wherever it lists
  what the supervisor puts on every pi child — the system diagram, the
  Responsibility table's supervisor row, Component 2's "Produces", and the
  spawn workflow — add `--model <pi_agent_model>` (when set) and the
  pool-worker stderr reader. Note that the extension's stderr warnings now
  reach the service log for pool workers.
- **S-009 (scheduler channel adapter and bob schedule CLI):** text-only.
  Add to the cron-tick workflow the branch "prompt not accepted by the pi
  worker (for example an invalid `pi_agent_model`) → service-log warning
  only; no dispatched-fire record; the entry fires again next tick". No
  schedule-store or CLI change.
- **S-010 (email skills):** text-only. Add the same branch to its Workflow's
  list of ways a periodic fire ends without running.
- **S-005 (monitoring, audit log, and external action reporting):** none. No
  new or changed audit records.
- **S-012 (`bob init`):** none, by decision — no new output and no new key
  in the generated configuration.
- **ADR-002 (flat config keys):** consulted as a constraint; no amendment.
- **ADR-011 (interactive session protocol):** consulted — the interactive
  spawn gains an argument, but the decision is unchanged; no amendment.
- **ADR-014 (skill delivery):** consulted — its reasoning against per-path
  argument construction is applied to `--model` (item 1); no amendment.
- **Out of scope, filed separately:** S-002 Component 6 and S-010 promise a
  monitoring failure record when a fire is refused at `max_processes`, but
  the code only logs a warning. This pre-existing drift is tracked as its
  own ai-team bug, not fixed by this CR.

## Architecture Consistency Review (2026-09-28)

Reviewed by the Architect against the full binding set (16 accepted ADRs, 14
approved specs). **Verdict: consistent with findings** — no blocking
contradictions. No approved spec or accepted ADR requires an audit record for
a prompt-delivery failure, forbids bob from selecting the model, defines
`pi_agent_args` as an unconstrained passthrough, or limits the arguments the
interactive spawn may carry (ADR-011). Findings, all resolved in the text
above or in the applied amendments:

1. S-002 needed more than a config entry: Component 7, the interactive-chat
   workflow, and the supervisor's Responsibility row all describe what a pi
   process is started with. — Resolved by restructuring S-002's
   Configuration around a single "pi-agent process settings" table that the
   other passages now refer to.
2. S-003 restated the full pi command line in four places. — Resolved by
   limiting S-003 to the extension wiring it owns and pointing to S-002 for
   the rest.
3. `pi_agent_args` was restricted without being specified anywhere. —
   Specified in S-002 (with `pi_agent_command`) before being restricted.
4. S-009, S-010, and S-002 listed fire outcomes as always carrying a
   monitoring failure record. — S-009's cron-tick workflow gains the missing
   dispatch step and is now the complete list; S-010 refers to it.
5. `README.md` still records a pi version older than the upgrade behind
   #104. — Recorded as a deliverable; specs and shipped skills name no
   version.
6. Shipped-skill rules for item 6 (describe check limits as observed
   behaviour, no issue IDs, update `bob-setup`'s notable keys and the
   quickstart). — Incorporated into item 6 and S-002's operator
   documentation note.
7. ADR-014's argument against per-path argument building applies to
   `--model`. — One shared builder required (item 1, S-002).
8. The dead-worker cleanup was misdescribed, and "release notes" had no
   owner. — Corrected (the next fire meets the dead worker; see item 5); the
   migration note moved to the operator guide.
9. `bob init` would leave the key unset. — Human decision: no `bob init`
   change; the startup warning must name exactly what is missing.
10. Pre-existing drift: the `max_processes` skip promises a monitoring
    record the code does not write. — Filed separately as B-055.

## Resolution (applied 2026-09-28)

Approved by the human on 2026-09-28 and applied to:

- **S-002** (v0.2): Configuration restructured into general settings and a
  "pi-agent process settings" subsection with one table of which keys reach
  pool workers and which reach interactive sessions; `pi_agent_command`,
  `pi_agent_args`, and `pi_agent_model` specified; `pi_agent_args` rejects
  model-selecting flags; one startup warning when `pi_agent_model` is unset;
  pool-worker stderr forwarded to the service log; Component 6 gains the
  "worker never accepts the prompt" outcome and the precise dead-warm-worker
  behaviour; Component 7 and the workflows refer to the settings table;
  operator-documentation deliverables recorded.
- **S-003** (v0.2): spawn descriptions limited to the extension wiring this
  spec owns, pointing to S-002 for the rest of the command line; stderr
  forwarding noted where the extension's warning surfaces. Also reconciled
  stale `the-intern/extensions/` paths to `the-intern/pi-extension/`.
- **S-009** (v0.2): cron-tick workflow gains the dispatch step and its
  outcomes, becoming the complete list of how a fire ends.
- **S-010** (v0.5): periodic-fire workflow and continuity principle refer to
  S-009's list. Also reconciled the stale "skills discovered from that cwd"
  step to the shared skill install path (ADR-014).

Not amended: S-005 (no audit change), S-012 (no `bob init` change), and all
ADRs (ADR-002, ADR-011, ADR-014 consulted only).

Remaining work goes to spec breakdown: implementation of the S-002 changes,
the bob-companion `bob-setup` and `bob-troubleshooting` updates, the user
manual (configuration reference, operator guide with migration note,
quickstart), and the `README.md` pi compatibility update. The stderr-volume
`[TODO]` under Potential Impact is to be settled during breakdown.

