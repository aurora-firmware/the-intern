# Architecture comparison & the `admin-rpc` component

**Date:** 2026-06-13
**Scope:** Compare the implemented Rust crate design (`the-intern/service/`) against
the initial logical architecture (`project/docs/system_overview.md`,
`project/docs/the-intern-architecture.md`), document each component's
responsibility, and answer specifically: **is `admin-rpc` necessary, and why was
it not considered in the initial architecture?**

**Sources:** the two architecture docs above; the live workspace at commit
`f588a6c` (11 crates); the `admin-rpc` JSON-RPC method table and the `bob` CLI
surface read directly from source.

---

## 1. Component responsibilities (as built)

The workspace is 11 crates. Each maps to one bounded responsibility.

| Crate | Responsibility | Layer (logical) |
|---|---|---|
| `bob` | The single binary / **composition root**: CLI parsing, config load, telemetry, and `serve` — which builds and supervises the whole subsystem tree. Owns process lifecycle and wiring. | Host |
| `bob-core` | **Shared kernel / architectural contract**: domain `types` (events, identifiers, audit records, schedule), the `error` taxonomy, `ports` (trait interfaces subsystems implement), and the `auth`/`PeerCred` primitive. Runtime-agnostic; depends on no peer crate. | Contract |
| `requests-handler` | **Requests Handler**: owns the inbound queue, consumes normalized events, attaches identity, runs pre-flight admission before any agent work. | Interface |
| `chat-adapter` | **Channel adapter** — interactive chat: normalizes chat into internal events and routes replies back. | Interface |
| `scheduler-adapter` | **Channel adapter** — scheduler: a cron actor that fires `periodic` internal events onto the same inbound path (S-009). | Interface |
| `policy-control` | **Policy Control**: deterministic authorization — pre-flight admission allow-list and per-action verdicts; reloadable at runtime. | Security |
| `monitoring` | **Monitoring**: append-only audit log (JSONL), live audit-tail subscriptions, and ingestion of externally-reported actions. | Security |
| `persistence` | **Storage layer**: durable backing for service state (session state, audit JSONL) that survives restarts. | Cross-cutting |
| `pi-agent-supervisor` | **Agent Harness — process side**: supervises pi-agent child processes (spawn / reap / warm pool). | Orchestration |
| `extension-ipc` | **Extension↔service channel**: Unix-socket server for the in-process JS extension — `tool_call` verdict round-trips and event forwarding, session-tagged. | Security/Interface |
| `admin-rpc` | **Local control / IPC plane**: JSON-RPC over a peer-credential-gated Unix domain socket, hosting operator commands, the Monitoring report interface, and the chat client channel (detailed in §3). | *(not named in the docs)* |

**Observation:** crates 3–10 are an almost 1:1 realization of the logical
components the docs name. `bob` and `bob-core` are implementation structure (host
+ shared contract). `admin-rpc` is the one crate with no counterpart in the
architecture — the subject of §3.

---

## 2. Comparison with the initial architecture

### 2.1 Where the code faithfully realizes the docs

| Design principle (system_overview) | How the crate design honors it |
|---|---|
| **Modularity** ("interface handling, policy, orchestration… remain separable") | One crate per logical role — separation is literal. |
| **Replaceability** ("components may change without changing the architectural contract") | `bob-core::ports` (trait interfaces) + `types` + `error` *are* that contract, in code; subsystems are injected as `Option<Handle>`. |
| **Deterministic policy first** | `policy-control` is a standalone crate on the request path; even scheduler-originated requests carry `sender`/`source` and pass pre-flight admission. |
| **Traceability** | `monitoring` is a structural crate, not an add-on — matching "every component writes to it." |
| **Single OS-agnostic binary** | `bob` composes all crates into one daemon, exactly the documented process topology. |

The recently delivered **scheduler (S-009) is on-architecture**: the docs list
"scheduled tasks / OS schedule" as a channel and state that "an emailed request,
a webhook, a scheduled task, and a chat message all follow the same path."
`scheduler-adapter → requests-handler` is precisely that.

### 2.2 Where the code is *behind* the docs (roadmap gaps, not divergences)

- **Agent Harness / Orchestrator is only partially realized.** The overview gives
  it role assignment, delegation to specialist agents, and per-task model
  selection. Today `pi-agent-supervisor` covers only process supervision; the
  richer orchestration is future work.
- **Channels are partial.** Chat and scheduler exist; email, IM, and OS
  notifications from the documented channel list are not yet built.

### 2.3 Where the code *extends beyond* the docs

- **`admin-rpc` (control plane)** — no counterpart in either document (see §3).
- **`bob-core` as a shared kernel** — an implementation pattern (ports & adapters)
  that the logical docs neither name nor should. It sits below their resolution.

---

## 3. Is `admin-rpc` necessary, and why was it absent from the initial architecture?

### 3.1 What `admin-rpc` actually is

It is **not** a logical component; it is a **local IPC transport** — JSON-RPC 2.0
framed over a Unix domain socket, access-gated by OS peer credentials
(`SO_PEERCRED` via `bob_core::auth::peer_cred_from_fd`). `bob serve` binds it; the
`bob` CLI subcommands connect to it. Several logically distinct interfaces are
*mounted onto* this one transport. Its full method table:

| Method(s) | Purpose | In the initial architecture? |
|---|---|---|
| `service.status` | Daemon health/version | ❌ No |
| `sessions.list`, `sessions.kill` | Inspect / terminate pi-agent sessions | ❌ No |
| `policy.reload` | Reload policy config at runtime | ❌ No |
| `schedule.add/remove/list/reload` | Runtime schedule management (S-009) | ❌ No |
| `audit.tail.subscribe/unsubscribe` | Stream the audit log to an operator | ⚠️ Implied by "audit log," but no interface specified |
| `report.submit` | External CLI tools register actions they took | ✅ **Yes** — "Monitoring's inbound interface… external tools call directly" |
| `chat.open/send/close` | Interactive-chat client channel | ✅ **Yes** — "interactive chat" is a named channel |

This is the key finding: **`admin-rpc` is a shared transport, and only *part* of
its surface is undocumented.** `report.submit` and `chat.*` realize architecture
elements that *were* specified (the Monitoring inbound interface and the chat
channel). What is genuinely new is the **operator control plane**:
`service.status`, `sessions.*`, `policy.reload`, `schedule.*`, and
`audit.tail.*`.

### 3.2 Is it necessary?

**The capability is necessary; the crate is a justified way to provide it.**

1. **Two documented needs already require a local client↔daemon channel.** The
   Monitoring inbound interface (`report.submit`) and the interactive-chat client
   (`chat.*`) both need external processes to talk to the running service. The
   architecture mandates these interfaces but never says *how* they are reached —
   `admin-rpc` is that "how." Remove it and two documented features have no
   transport.

2. **A long-lived daemon is not operable without a control plane.** The
   architecture itself states the system is "a long-lived service rather than a
   per-session program" and "supervises the pi-agent processes." Operating such a
   process — checking it is alive (`service.status`), seeing and killing stuck
   sessions (`sessions.*`), reloading policy without downtime (`policy.reload`),
   managing schedules at runtime (`schedule.*`), and tailing the audit log
   (`audit.tail.*`) — requires a request/response control channel. The `bob` CLI
   subcommands (`bob status`, `bob sessions list`, `bob schedule …`, `bob audit
   tail`) are *defined entirely in terms of these calls*; without `admin-rpc` they
   cannot function.

3. **A separate crate is the right structure for it.** It is one cohesive concern
   — wire protocol + socket + request routing — reused by every CLI verb and
   testable in isolation. Folding it into `bob` would entangle transport with the
   composition root.

**Nuance / minor concern.** `report.submit` is an *external-tool* interface
sharing the same peer-cred-gated socket as the *operator* commands. Today both
are same-uid local callers, so this is acceptable; if external Actions and human
operators ever need different trust levels, splitting the report interface onto
its own socket (or adding per-method authorization) would be the cleaner shape.
Worth noting, not blocking.

### 3.3 Why it was not in the initial architecture

Not an oversight in the data-plane design — a **scope boundary**:

1. **The docs model the data plane and logical responsibilities, not day-2
   operability.** `system_overview.md` enumerates *functional* components
   (Requests Handler, Policy Control, Orchestrator, Actions, Monitoring) and how a
   request flows to an effect. "How does an operator inspect or steer the running
   process" is an **operational/management** concern, orthogonal to that flow. It
   was abstracted away because it is not load-bearing for the conceptual design.

2. **`the-intern-architecture.md` specified only the channels it foresaw.** Its
   tech stack names a Unix socket for the *extension*-to-service channel and
   `runRpcMode()` for prompt delivery — but no *operator*-to-service channel. The
   operator surface had not been enumerated yet.

3. **The operator surface accreted from implementation specs, not the
   architecture.** `service.status`/`sessions.*` (running the shell), the audit
   tail (S-005), runtime schedule management (S-009) — each arrived as a concrete
   feature needed an interface, and they converged onto one transport. This is the
   normal pattern: a control plane emerges once you actually have to run, debug,
   and administer the thing.

In short: the architecture described **what the system does**; `admin-rpc`
answers **how you operate the system that does it** — a question the logical docs
deliberately did not ask.

---

## 4. Recommendations

Prioritized and actionable. Items 1–3 close the `admin-rpc` documentation gap
this report identifies; items 4–5 are related design questions raised in the same
review thread, recorded here so they are not lost.

| # | Recommendation | Why | Suggested artifact | Priority |
|---|---|---|---|---|
| 1 | Add a **"Control plane / operability"** section to `the-intern-architecture.md` | The architecture record trails the code; the operator surface is undocumented | Doc edit (new section) | High |
| 2 | Record an **ADR for the control plane** | Capture the decision deliberately rather than by accretion | `ADR: local control plane over a peer-cred-gated JSON-RPC socket` | High |
| 3 | Track the **`report.submit` trust-separation** question | An external-tool interface shares the operator socket; fine now, not forever | Open question inside ADR #2 | Low / deferred |
| 4 | Decide the **`bob-core` config-persistence boundary** | `write_schedule_entries` put the first config-format-aware filesystem write in the shared kernel | `ADR: where config persistence lives` (or a dedicated config crate) | Medium |
| 5 | Note that **scheduler identities are deliberately derivable** | UUIDv5-from-job-id is predictable by design; harmless today, must stay non-authoritative | One line in the S-009 design record / future identity-&-role spec | Low |

**Details:**

1. **Control-plane section.** Document `admin-rpc` as the local JSON-RPC control
   channel: the `SO_PEERCRED` trust boundary, the operator method set
   (`service.status`, `sessions.*`, `policy.reload`, `schedule.*`,
   `audit.tail.*`), and the fact that it also carries the already-documented
   Monitoring `report.submit` and `chat.*` interfaces. This stops the architecture
   record from trailing the code.
2. **Control-plane ADR.** Decision: one JSON-RPC-over-UDS transport, peer-cred
   gated, shared by operator + report + chat. Alternatives to record and reject
   with reasons: separate sockets per concern; HTTP/gRPC; no control plane at all
   (config-file edits + signals only).
3. **`report.submit` separation (deferred).** If external Actions and human
   operators ever need different trust levels, split the report interface onto its
   own socket or add per-method authorization. No action while all callers are
   same-uid local — track it as an open question under ADR #2.
4. **`bob-core` config-persistence boundary.** Either accept `bob-core` as the
   shared low-level home (consistent with `peer_cred_from_fd` already living
   there) or move the writer to a dedicated config/persistence crate that both
   `bob` and `admin-rpc` depend on, keeping `bob-core` to types/ports/OS
   primitives. Reversible either way; decide on purpose rather than by inertia.
5. **Scheduler-identity note.** Record that scheduler `ChannelId`/`UserId` are
   intentionally derived from the job id (so operators can allow-list them stably
   across restarts) and therefore must be treated as non-secret by any future
   identity/role spec — a guessable identity must never confer authority.

### Bottom line

The crate design is a faithful, modular realization of the logical architecture.
`admin-rpc` is necessary — two documented interfaces depend on it and the daemon
is not operable without it — and it is absent from the initial architecture
because that architecture deliberately scoped itself to the data plane and the
functional components, leaving the operator/control plane unspecified. The gap is
in the **documentation**, not the design; the fix is to write the control plane
into the architecture record (and an ADR), not to remove the component.
