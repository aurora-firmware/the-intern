# AI Review Report — S-003 Phase 1–4 (T-037 → T-040)

**Date:** 2026-05-19
**Branch reviewed:** `dev-agent` (post-merge of T-037, T-038, T-039, T-040)
**Reviewers:** four parallel subagents — Developer (code), Reviewer (task ACs), Architect (spec compliance), Architect (project architecture / SRP).

This is a read-only audit of the implementation that just shipped, plus a wider structural audit of the workspace. No code was changed.

---

## 1. Code analysis (Developer)

### High severity

- **`pi-agent-supervisor/src/process.rs:225` — `child_termination_deadline: 50ms` in the test helper is the root cause of the `terminate_requests_graceful_shutdown_before_deadline` flake.** The test spawns `sh -c "trap 'exit 0' TERM; while :; do sleep 1; done"` and asserts the child terminates cooperatively inside 50 ms. Under concurrent test load (39 tests in the supervisor binary post-T-039), shell startup + signal delivery + scheduler latency reliably blow that budget. Observed failure rate: 3/10 full runs of `cargo test -p pi-agent-supervisor`; 5/5 passes in isolation.
  - T-039's *spawn-level* tests (`spawn_sets_bob_session_id_…`, `spawn_sets_bob_extension_sock_path_…`, `spawn_omits_…`) use short-lived `printf` children and do not exercise the deadline path.
  - T-039's *pool-level* tests (`reap_idle_and_surplus_*`, `actor_shutdown_*`, `idle_reaper_*`, `sessions_list_reports_same_id_…`) all spawn `trap … sleep 1` workers with the same 50 ms budget and directly add race sites.
  - Not a production regression — the deadline is test config only.
- **`extension-ipc/src/lib.rs:103-168` — `run_connection` couples write back-pressure to inbound reads.** `out_rx.try_recv()` runs inside the inbound frame loop; a blocked write stalls all further inbound processing. Correct for single-connection use but undocumented and fragile.
- **`bob.ts:103-117` — `socket.write()` return value is never checked.** When the bob service is slow to drain, Node accepts frames into its internal buffer without bound → silent memory growth. The code only checks `socket.destroyed`.

### Medium

- **`multiplex.rs:116-121` — `route_for_session` permanently caches the default route under an unknown session id.** Future calls for the same unknown session use the stale cached route rather than the live default. No test covers the "unknown session after default route close" path.
- **`bob/src/serve.rs:191-197` — TOCTOU race on admin socket existence check** after `admin_rpc::start()`. The actor binds asynchronously; the synchronous existence check races. Tests pass only because `sh -c exit 0` workers are fast.
- **`bob.ts:168-184` — `warn()`'s `ctx.ui.notify()` branch has zero test coverage.** Every test passes `{} as ExtensionContext`, so only the stderr path is exercised.

### Low / clarity

- `process.rs:303` — POSIX `${VAR+x}` substitution idiom used without a comment.
- `extension-ipc/lib.rs:63-65` — `Command::SendMessage` / `Handle::send_message` always return `NotImplemented`; dead code that hints at a wrong extension point.
- `multiplex.rs:97-100` — `Authz` arm hardcodes literal string `"policy not implemented"`. Should be a named constant if it might leak.
- `bob.test.ts:334-396` — fixed `setTimeout` waits in AC-4 tests; `waitUntil` (already in the file) would be tighter.

### Summary

Overall code health is reasonable: error handling is explicit, the actor/handle pattern is applied consistently, and test coverage for the new env-var plumbing is thorough. The principal risk is timing-sensitivity in `process.rs` tests, and the unchecked `socket.write()` return value in `bob.ts`.

---

## 2. Task acceptance audit (Reviewer)

All four tasks **PASS** every written acceptance criterion literally.

### T-037 — Scaffold extensions Node project
- AC-1: `package.json` has only `devDependencies` (`@earendil-works/pi-coding-agent`, `@types/node`, `typescript`, `vitest`). PASS.
- AC-2: `tsc --noEmit` exits 0; `env.d.ts` provides a valid input for the otherwise empty project. PASS.
- AC-3: `npm test` runs `vitest run` with `passWithNoTests: true`. PASS.
- AC-4: README contains the bob service / bob extension naming section, env-var contract section, and both install paths. PASS.

### T-038 — bob.ts event forwarding
- AC-1: `PI_EVENTS` (29 entries) sourced from `types.d.ts`; every entry is registered. PASS.
- AC-2: `buildFrame()` emits `{kind:"event", session, payload:{event, data}}\n` exactly; tests assert each field and that two events produce two lines. PASS.
- AC-3: Early-return guard logs one warning and registers zero handlers; three tests (each absent-env-var combo) assert `toHaveBeenCalledTimes(1)`. PASS.
- AC-4: Connect failure and mid-session peer close both reach `markDead`, which calls `warn()` once and sets `transportDead`. PASS. Caveat: only stderr branch is tested, not `ctx.ui` (acceptable — "exactly one" is enforced structurally by `markDead`).

### T-039 — BOB env vars on pi spawn
- AC-1: `cmd.env("BOB_SESSION_ID", …)` unconditional in `spawn()`. PASS.
- AC-2: `cmd.env("BOB_EXTENSION_SOCK_PATH", …)` when path non-empty. PASS.
- AC-3: Empty path → spawn proceeds without the env var; verified by reading the actual child env. PASS.
- AC-4: `WarmWorker.session_id` is the same id `list_sessions` returns; end-to-end test spawns a real `sh` child that writes `$BOB_SESSION_ID` to disk and asserts equality. PASS.
- Permitted scope expansions confirmed: `acquire_session` API shape change (allowed by task); `admin-rpc/src/dispatch.rs` edits are test-only (production dispatch unchanged).

### T-040 — TracingMonitoringHandle
- AC-1: `TracingMonitoringHandle` defined in `extension-ipc/src/multiplex.rs`, re-exported from `lib.rs`. PASS.
- AC-2: One `tracing::info!(session, event)` per call; `info_lines.len() == 1` literally asserted. Optional `tracing::debug!` payload is spec-permitted. PASS.
- AC-3: `serve.rs` constructs `extension_ipc::Config { monitoring_handle: Arc::new(TracingMonitoringHandle), .. }`; `NoopMonitoringHandle` no longer active. PASS.

---

## 3. Spec compliance (Architect)

**Verdict: Aligned** with two micro-deviations.

### Cross-checks against S-003
1. **Wire frame shape** — `bob.ts::buildFrame` matches `InboundFrame::Event` exactly. Aligned.
2. **Env-var contract** — `BOB_SESSION_ID` always set; `BOB_EXTENSION_SOCK_PATH` set only when non-empty; no spawn failure when absent. Aligned.
3. **Bob service vs bob extension naming** — Rust identifiers (`extension_sock_path`, `extension-ipc`, `BOB_EXTENSION_SOCK_PATH`) and JS file (`extensions/bob.ts`, `[bob]` warn prefix) never collide. Aligned.
4. **Warm-worker session-id model** — `SessionId` allocated inside `spawn_warm_worker` before `pi` execs; `acquire_session` returns that pre-allocated id. Matches the spec principle that the bob service owns the session id; the bob extension does not generate one. Aligned. The T-039 API shape change (`acquire_session -> SessionId`) is consistent with that principle.
5. **Failure-mode contract** — `bob.ts` warns once and sets `transportDead` on missing env vars, connect failure, write failure, and peer close. No retries, no backoff. Aligned with "quiet degradation, loud once."
6. **Sink contract** — `TracingMonitoringHandle::record_event` emits one INFO with structured fields plus an optional DEBUG payload. Aligned.

### Micro-deviations and risks

- **`pendingFrames` is an in-memory buffer with no cap.** Spec says "lost-connection windows are dropped silently." The queue is a *pre-connect* window (single-digit ms in practice), not a retry buffer — defensible, but an unbounded synchronous burst can grow memory without bound. Recommend a small cap (e.g. 64 frames) with one warn-then-drop, and documenting the connect-window-vs-retry-buffer distinction in the extensions README.
- **`PI_EVENTS` is sourced from `@earendil-works/pi-coding-agent@0.75.3` types.d.ts, not the live docs.** Defensible (types are the machine-readable surface) and the choice is documented in the source, but a drift risk on package upgrades. Optional follow-up: auto-derive at build/test time or pin a verification step against the live docs.
- **`pi.on(...)` is invoked via an `unknown` cast in `bob.ts`** because the package overloads are per-event-name. A typed call-through (one overload per known event) would be more verbose but type-safe.
- **Operator-facing installation docs** (Component 4 in the spec) were out of audit scope and should be cross-checked separately.

---

## 4. Architecture / SRP audit (Architect)

### Architecture snapshot

Three concentric layers in code:
1. **Core** — `bob-core` (types, ports, `ServiceError`).
2. **Subsystem actors** — `persistence`, `policy-control`, `monitoring`, `requests-handler`, `pi-agent-supervisor`, `extension-ipc`, `admin-rpc`. Each crate is one tokio actor exposing `Config / Handle / start()`.
3. **Composition root** — `bob` (CLI, config loading, `serve::start_subsystems`, shutdown protocol).

The actor pattern is consistent; coupling between (2) and (3) is currently flat — every subsystem is wired by hand in `bob::serve`.

### Top SRP / convolution findings

**F1 — `bob::serve::try_start_subsystems` is a monolithic composition root.**
`crates/bob/src/serve.rs:84-244`. It directly constructs seven actors, builds an inline `MonitoringAuditSink` adapter (`AuditSink → monitoring::Handle::record_event` as a debug-formatted string — no test, loses `AuditKind` typing), threads `Arc<dyn …>` plumbing into the requests-handler closure, and manages two sockets plus phase-3/4 shutdown sequencing. Adding any new subsystem means editing this function and the `Runtime` struct.
*Re-cut:* introduce a `bob-runtime` crate (or `bob/src/runtime/`) with one `SubsystemBuilder` per actor, a typed `MonitoringAuditSink` in `monitoring`, and a `Runtime::start(cfg)` returning typed handles. `serve.rs` should shrink to ~50 lines: build runtime, wait for signal, run protocol.

**F2 — `pi_agent_supervisor::SessionPool` conflates four responsibilities.**
`crates/pi-agent-supervisor/src/pool.rs`. It owns (a) the warm-pool spawning policy, (b) the active-session ↔ worker map and timestamps, (c) the prompt JSON-RPC protocol through `RpcWorkerProcess`, and (d) reaper selection. `send_prompt` blocks every other pool operation through the actor's single `mpsc`; the warm-id-equals-session-id rule is encoded implicitly; tests have to spawn `sh` to exercise pool semantics because the protocol layer is not separable.
*Re-cut:* split into `WorkerLifecycle` (spawn/terminate/warm-pool), `SessionRegistry` (id ↔ worker handle, timestamps), and `WorkerRpc` (prompt protocol, owned per-session, driven concurrently). Supervisor becomes a router.

**F3 — `admin-rpc` carries three crate-sized concerns.**
`crates/admin-rpc/src/{lib.rs,dispatch.rs,subscriptions.rs}`. `lib.rs` contains an unused command-actor scaffold (`Actor`/`Handle::ping → NotImplemented`) alongside the real `run_connection`/`read_loop`/`write_loop`/`audit_forwarder` state machine. `dispatch.rs` is the method table (cleanly factored). `subscriptions.rs` is a generic fan-out bus already piggy-backed on by `chat.open`. The bus is not admin-rpc-specific.
*Re-cut:* extract `subscription-bus` as its own crate; delete the dead `Actor`/`Handle::ping` scaffold; rename the concept from "admin-rpc actor" to "admin-rpc listener" — that is what it actually is.

**F4 — Identity and authorisation model is fragmented across three crates.**
`bob-core::types::UserId` (UUID) is the inbound-path identity; `admin-rpc::peer_cred::PeerCred` is `u32` uid; `extension-ipc::peer_cred::PeerCred` is a literal duplicate; `extension-ipc::framing::InboundFrame::Authz.user` is a third `String` form. No single answer to "who is making this request."
*Re-cut:* hoist `PeerCred` and `is_allowed` into a new `bob-ipc-common` (or `bob-core::auth`) crate, reconcile `Authz.user` with `UserId`, make `RequestContext` the only authenticated identity surface.

**F5 — `Config`/`Handle`/`Actor`/`start()` is a copy-pasted template that hides which actors are real.**
`monitoring`, `policy-control`, and `extension-ipc::Actor` ship a non-functional `Handle::method → NotImplemented` plus a one-variant command enum whose handler only `tracing::debug!`s. They compile, link, and pretend to be functional.
*Re-cut:* collapse to `Config + pub fn start(cfg) -> JoinHandle<()>` until they have real behaviour. Annotate as `#[doc = "scaffold — see roadmap phase X"]`.

### Lower-priority observations

- `bob::serve` requires both `admin_sock_path` and `extension_sock_path` to be non-empty, but `BobConfig::default()` initialises them empty — production default is unbootable. Make the field non-empty by construction.
- `SubscriptionId` is `Uuid` in `bob-core` but `u64` in `admin-rpc::subscriptions`. Two unrelated types share a name.
- `ServiceError` blends domain errors (`PolicyDenied`, `Persistence`) with transport errors (`Shutdown`, `Timeout`, `ChildProcess`). `map_service_error` in `admin-rpc/dispatch.rs` reveals the mismatch — six of nine variants map to `-32601`. Consider a two-tier split.
- `requests-handler::start_with_preflight` is wired with `context = None` only; tests assert deny-all. Fine as scaffolding, but where `RequestContext` is *supposed* to come from is the highest-risk architectural gap for the next spec.
- `extension-ipc::Actor::Handle::send_message` is vestigial — the real work happens in `run_connection`, never through the handle.

### What is healthy

- The `Config → start() → (Handle, JoinHandle)` actor convention is consistent across every subsystem; failure modes in `bob::serve` are mechanical rather than ad-hoc.
- `bob-core` is a clean foundation crate: no upward reaches, only types + ports + errors, with `async_trait` ports the rest of the workspace depends on.
- `bob::serve::run_shutdown_protocol` is genuinely well-engineered — phased, deadline-aware, supervisor-join-aware, drop-order-disciplined. Should be the template when F1 is unpacked.

---

## 5. Triage — mistakes vs. incomplete-by-design

Each finding above is classified below. A **mistake** is a real correctness, hygiene, or test-quality bug that nothing in the roadmap defers. **Incomplete / deferred** means the current state is the intentional shape of an unfinished phase or a future spec — not a regression and not "wrong" today.

### Mistakes (real bugs / oversights to fix)

| Finding | Why it's a mistake |
|---|---|
| `process.rs:225` 50 ms test deadline → flaky `terminate_…` test | Test-config error. Nothing defers it; the deadline is just too tight to absorb scheduler jitter. |
| `bob.ts:103-117` — `socket.write()` return value unchecked | Real correctness bug. Spec says "no buffering"; unchecked `write()` lets Node's internal kernel buffer grow without bound when the peer is slow. |
| `pendingFrames` has no length cap | Same class. The connect-window queue is defensible, but unbounded growth violates the spec's "no buffering" intent. Trivial cap + warn-then-drop fixes it. |
| `multiplex.rs:116-121` — `route_for_session` permanently caches `default_route` for unknown sessions | Stale default route survives default-sender close. Wrong behaviour, not deferred design. |
| `bob/src/serve.rs:191-197` — TOCTOU on admin socket existence after `admin_rpc::start()` | Race in startup verification. Should await the bind, not synchronously check. |
| Inline `MonitoringAuditSink` adapter in `serve.rs` debug-formats `AuditKind` into a string, untested | Loses typing the rest of the system carries. Real adapter bug, not incompleteness. |
| Duplicate `PeerCred` literally copy-pasted between `admin-rpc` and `extension-ipc` | Pure code duplication — no design reason for two copies. |
| `SubscriptionId` is `Uuid` in `bob-core` but `u64` in `admin-rpc::subscriptions` | Name collision on unrelated types; one should be renamed. |
| `BobConfig::default()` produces a non-bootable runtime (empty `admin_sock_path` / `extension_sock_path`) | Default that doesn't work is an API mistake; non-empty should be enforced by type or by `defaults_with_runtime_root`. |
| `bob.test.ts` — `ctx.ui.notify()` branch has zero coverage | Implementation exists, test doesn't exercise it. Trivial test gap. |
| `multiplex.rs` — "unknown session after default-route close" path uncovered | Missing test for a path the code actually has. |

### Incomplete / deferred to later phases (not mistakes)

| Finding | Why it's incomplete, not wrong |
|---|---|
| `monitoring`, `policy-control`, `extension-ipc::Actor` all ship `Handle::method → NotImplemented` (F5) | These crates are placeholders the roadmap fills in later phases. The placeholders themselves are by design; only the *missing `#[doc = "scaffold"]` marker* is a minor hygiene gap. |
| `multiplex.rs:97-100` — `Authz` hardcoded `allow: false` with `"policy not implemented"` | `policy-control` isn't implemented yet. This is the "deny until implemented" placeholder. |
| `extension-ipc::Handle::send_message` returns `NotImplemented` | Vestigial actor surface; the real ingest path is `run_connection`. Cleanup is a future tidy-up. |
| `admin-rpc::Handle::ping` returns `NotImplemented` | Unused scaffold from an earlier shape. |
| `requests-handler::start_with_preflight` always passes `context = None`; tests assert deny-all | The "where does `RequestContext` come from" question is itself a future spec. Current state is intentional. |
| **F1** — `bob::serve` is a monolithic composition root | Acceptable for 7 actors. Will need a `bob-runtime` extraction as it grows, but it isn't *wrong* today — just an SRP smell trending in one direction. |
| **F2** — `SessionPool` conflates pool + registry + RPC + reaper | T-039 deliberately consolidated session-id allocation into the pool. Splitting into `WorkerLifecycle` / `SessionRegistry` / `WorkerRpc` is a refactor for a future spec, not a bug. |
| **F3** — subscription bus is inside `admin-rpc` | Only one transport uses it. Extraction becomes worthwhile only when a second consumer arrives. |
| **F4** — fragmented identity model (`UserId` UUID vs uid u32 vs `Authz.user: String`) | The auth story is itself unfinished. The three representations exist because three transports were built before identity was unified — future spec, not regression. |
| `ServiceError` blends domain and transport errors | Architectural debt accumulated as the project grew. Real, but the fix is a workspace-wide refactor scoped to its own ADR/spec. |
| `extension-ipc::run_connection` couples write back-pressure to inbound reads | Intentional for single-connection use today. Only the *missing comment* is a small hygiene mistake; the design itself is fine. |
| `PI_EVENTS` sourced from `types.d.ts` instead of live docs | Defensible workaround for a non-machine-readable docs page. Verification-mechanism question, not behaviour mistake. |
| `pi.on(...)` `unknown` cast in `bob.ts` | Forced by the upstream package's per-event-name overloads. Type ergonomics, not a defect. |

### Headline

- **Ship-blocking nothing.** The real correctness mistakes are the unchecked-write / unbounded-queue pair in `bob.ts`, the stale-default-route cache in `multiplex.rs`, and the startup TOCTOU in `serve.rs`. Two bug tickets cover them.
- **Test-suite quality blocker** is the 50 ms deadline flake — file as a bug; it makes integrate runs unreliable.
- **Everything in section 4's F1–F4** is debt to track, not bugs to fix this week.

---

## 6. Suggested next actions

Priorities reflect the triage above: mistakes go first as bugs, deferred-by-design items become tracking ADRs/tasks for the appropriate future phase.

### Now — file as bugs

| Action | Vehicle | Status |
|---|---|---|
| Raise `child_termination_deadline` from 50 ms to ~500 ms in `spawn_config` / `test_config` (fix the flake) | `/new-bug` | **B-002 — resolved 2026-05-19** (raised to 2000 ms after 500 ms still flaked; 20× verification clean) |
| Cap `bob.ts` `pendingFrames` (e.g. 64) with one warn-then-drop; check `socket.write()` return value and stop pushing when it returns `false` | `/new-bug` | **B-003 — resolved 2026-05-19** (`PENDING_FRAMES_CAP = 64`; `markDead` on write `false`; 2 regression tests; 11/11 passing) |
| Stop caching `default_route` permanently for unknown sessions in `multiplex.rs::route_for_session` | `/new-bug` | **B-004 — resolved 2026-05-19** (live default-route fallback; regression test; 29/29 passing) |
| Await admin-socket bind in `bob/src/serve.rs` instead of synchronously checking `cfg.admin_sock_path.exists()` | `/new-bug` | **B-005 — resolved 2026-05-19** (diagnosis reframed: bind is synchronous; real defect was swallowed bind error. `admin_rpc::start` now returns `Result<…, io::Error>`; `exists()` check removed; regression test added) |
| Replace the inline `MonitoringAuditSink` in `serve.rs` with a typed adapter living in `monitoring` (no debug-format strings) and cover it with a test | `/new-bug` | **B-006 — resolved 2026-05-19** (`audit_kind_to_event_name` exhaustive match + `MonitoringAuditSink` typed adapter in `monitoring`; exhaustive variant test; inline adapter removed from `serve.rs`) |

### Now — small tasks

| Action | Vehicle |
|---|---|
| Deduplicate `PeerCred` between `admin-rpc` and `extension-ipc` (single source — `bob-core::auth` or a small shared crate) | `/new-task` |
| Rename one of the two `SubscriptionId` types to break the collision | `/new-task` |
| Make `BobConfig`'s socket-path fields non-empty by construction (or have `Default` route through `defaults_with_runtime_root`) | `/new-task` |
| Cover `ctx.ui.notify()` branch in `bob.test.ts` | `/new-task` |
| Cover the "unknown session after default-route close" path in `multiplex.rs` tests | `/new-task` |
| Add a one-line note in `the-intern/extensions/README.md` distinguishing the transient connect-queue from forbidden retry-buffering | `/new-task` |
| Annotate `monitoring`, `policy-control`, and `extension-ipc::Actor` placeholders with `#[doc = "scaffold — see roadmap phase …"]` | `/new-task` |
| Document the inbound-write back-pressure coupling in `extension-ipc::run_connection` with a short comment | `/new-task` |

### Later — architectural debt

| Action | Vehicle |
|---|---|
| ADR + follow-up tasks: extract a `bob-runtime` crate for the composition root (F1) | `/new-adr` |
| ADR: decompose `SessionPool` into `WorkerLifecycle` / `SessionRegistry` / `WorkerRpc` (F2) | `/new-adr` |
| ADR: extract `subscription-bus` from `admin-rpc` once a second consumer needs it (F3) | `/new-adr` |
| ADR: unify the identity model — one authenticated `RequestContext` surface across all transports (F4) | `/new-adr` |
| ADR: split `ServiceError` into a domain tier and a transport tier | `/new-adr` |
| Spec: where does `RequestContext` come from on the inbound path? — current `context = None` deny-all is intentional but needs a real wiring story | `/new-spec` |
| Task: keep `PI_EVENTS` in sync — either auto-derive from `@earendil-works/pi-coding-agent` types at build/test time, or pin a verification step against the live docs | `/new-task` |
| Task: remove vestigial scaffolds once their replacements land (`extension-ipc::Handle::send_message`, `admin-rpc::Handle::ping`) | `/new-task` |
