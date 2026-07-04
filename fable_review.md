# Fable review — architecture docs vs specs vs ADRs

> **Resolution note (2026-07-04):** the findings below were addressed in the
> same-day reconciliation commit — `the-intern-architecture.md` updated to
> ADR-010/011/012, the roadmap archived to `project/docs/archive/`, README and
> CLAUDE.md corrected, S-001/S-004 open questions closed, and pi-agent version
> pins removed from ADRs (README is now the canonical version record). This
> file is retained as the review record.

Date: 2026-07-04. Sources reviewed: `project/docs/system_overview.md`,
`project/docs/the-intern-architecture.md`, `project/docs/roadmap.md`, all
active specs in `project/specs/` (S-001…S-007, S-009; archived S-008), all
ADRs in `project/decisions/` (ADR-001…ADR-012), `CLAUDE.md`, and `README.md`.
This review sticks to what these documents say; no source code was audited.

---

## 1. What the project is (my understanding)

### The product

**the-intern** is a persistent, always-on AI office assistant for a **single
user on a single machine** (ADR-008: the OS account is the entire trust
domain). The logical model (`system_overview.md`) defines five roles —
Requests Handler, Policy Control, Agent Harness, Actions, Monitoring — with
design principles of deterministic policy first, local-first privacy, least
privilege, modularity, replaceability, and traceability. Policy Control gates
both request entry and every agent-requested action; Monitoring records
everything.

The concrete architecture (`the-intern-architecture.md`, S-001, S-002) maps
this onto:

- **A single Rust binary, `bob`** (workspace in `the-intern/service/`), the
  only long-lived process. It hosts channel adapters, the Requests Handler and
  bounded inbound queue, Policy Control, Monitoring, persistence, and the
  pi-agent supervisor as actor subsystems, with domain types and port traits
  in the runtime-agnostic `bob-core` crate. Same binary is server
  (`bob serve`) and every client subcommand.
- **pi-agent child processes** as the Agent Harness — one per active session
  (isolating the single user's *concurrent contexts*, not different people),
  spawned from a warm pool, idle-reaped, prompts delivered over
  `runRpcMode()` JSON-RPC.
- **A JS extension (`bob.ts`)**, the only TypeScript, loaded into every
  supervised pi process via `pi --extension <path>` (fail-closed if missing,
  CR-003/S-003). It is a courier with no policy logic: it forwards pi events
  to Monitoring and hosts the blocking `tool_call` hook that asks the Rust
  service for an allow/block verdict (S-004).
- **Actions as external CLI tools** described to the agent via markdown
  skills and run through pi's `bash` tool — no MCP. Every invocation passes
  the `tool_call` gate; tools may self-report via `report.submit`. bob
  custodies no secrets; Actions use the user's own credential stores.

**Transports and trust.** Two Unix sockets: `admin.sock` (the local control
plane — JSON-RPC 2.0, newline-delimited per ADR-001, carrying operator
control, `audit.tail`, interactive-session control, and `report.submit`,
ADR-007) and `extension.sock` (session-tagged authz verdicts + event
forwarding). The connection gate is filesystem permissions only — a `0700`
parent directory, socket `0660`; `SO_PEERCRED` is an audit signal, not a gate
(ADR-005). Application-level identity is self-asserted inside requests and
honored because the gate vouches for the caller. Unix-likes only (Linux,
macOS); file layout follows XDG (ADR-009): config in `XDG_CONFIG_HOME`
(TOML via figment, ADR-002), extension in `XDG_DATA_HOME`, audit log
(`audit.jsonl`) and schedule store (`schedules.json`) in `XDG_STATE_HOME`,
sockets in `XDG_RUNTIME_DIR`.

**Request flow.** Ingress is local and pull-based; no inbound network
listener. Channel adapters normalize input into internal events typed by
**delivery kind** (`sync`/`async`/`periodic`, ADR-004) — the core never
enumerates channels — onto the shared queue consumed by the Requests
Handler, which applies each channel's **admission model**. Two channels have
carved-out admission exceptions:

- **Interactive chat** (CR-002, ADR-010, ADR-011): `bob chat` no longer feeds
  the queue at all. It asks the service to launch a supervised interactive
  `pi` session and passes the client's real terminal fds over `admin.sock`
  via `SCM_RIGHTS`. Its gates are socket access plus the `tool_call` action
  gate; pre-flight admission does not apply. The old admin-socket chat
  pipeline (S-006's chat adapter, S-008) is retired/superseded.
- **Scheduler** (S-009, ADR-006, ADR-012): cron jobs live inside bob (no
  system cron), persisted in versioned JSON at
  `$XDG_STATE_HOME/bob/schedules.json`, mutated only via `bob schedule` /
  `schedule.*` RPC. A job present in the trusted store is admitted for
  firing; scheduler-derived `UserId` admission was removed. `periodic`
  requests are fire-and-forget; missed ticks while bob is down are skipped.

Everything else that traverses the queue passes the S-004 pre-flight gate
(`admitted_users` allow-list) and, for every agent tool call, the
default-deny, allow-only, fail-closed action ruleset — one `PolicyEngine`,
one config source, one `policy.reload` path, evaluated inline over an
atomically swappable snapshot.

**Monitoring** (S-005): one canonical `AuditRecord` envelope for extension
events, policy verdicts, and external reports; append-only JSONL, durable
before acknowledged, flushed on shutdown; live `bob audit tail` with
view-only filters (filtering never affects persistence).

**Docs** (S-007): an mdBook user manual in `the-intern/docs/` for four
audiences, CLI reference generated from the live `bob` binary at build time,
built in CI and attached to every GitHub Release next to the binary.

### The process

The repo also contains the AI-team process that builds the product: role
definitions in `.claude/agents/` (mirrored in `.codex/agents/`), slash-skills
in `.claude/skills/`, lifecycle state as directories under `project/`
(specs, ADRs, tasks, bugs — moving a file is the state transition). Git
model: `main` human-only; `dev-agent` integration + lifecycle state;
`task/`/`bug/` branches for source work.

### Delivery state (as the documents tell it — they disagree; see §2.3)

S-001 defines seven implementation phases. Per the spec texts themselves:
Phases 1a/1b (shell, queue/handler/persistence), 2 (supervision), 3
(extension event forwarding) are complete; S-004 (policy), S-005
(monitoring), S-007 (docs), and S-009 (scheduler) are approved and — judging
by ADR-012's "today" description of live scheduler behaviour and the
README's feature list — largely implemented. Phase 7 (Actions/skills) is not
yet specified or implemented.

---

## 2. Inconsistencies found

Ordered by severity. "Stale" means a document was not updated after a
decision that other artifacts did absorb — the artifact set no longer
agrees.

### 2.1 `the-intern-architecture.md` contradicts CR-002 / ADR-010 / ADR-007 on interactive chat

The concrete-architecture doc still describes the **retired** admin-socket
chat pipeline:

- Its control-plane table lists the chat surface as **`chat.open`/`send`/
  `close` (+ `chat.message` notifications)**, while ADR-007's table for the
  same plane lists **`session.interactive.open` / attach lifecycle for a
  supervised pi session** (CR-002 / ADR-011).
- It states: *"`bob chat` is a transport into the chat channel adapter, not
  a bypass — a chat message still flows Requests Handler → Policy Control →
  Agent Harness like any other channel (S-008)"*. This is triply wrong under
  the current record: chat **does** bypass the queue (ADR-010 exempts it from
  pre-flight admission precisely because there is no enforcement point), the
  chat channel adapter was retired (S-006 amendment, 2026-06-23), and S-008
  is archived as superseded yet is cited as live support.
- "How channels trigger the agent" claims *"a chat message … follows the
  same path"* as email and scheduled tasks, and the component list names
  *"interactive chat over `admin.sock`"* as one of the channel adapters —
  both superseded by CR-002.
- The Rust-service diagram and Security-integration section carry no mention
  of the SCM_RIGHTS fd-passing spawn path (ADR-011), which is now the actual
  interactive-chat mechanism.

The doc is dated before the 2026-06-23 CR-002 wave and was never reconciled,
even though S-001, S-002, S-004, S-006, and S-007 all carry explicit CR-002
amendments.

### 2.2 `the-intern-architecture.md` contradicts ADR-012 on schedule state

The doc's "Configuration is live state" paragraph says: *"the `[schedule]`
section [of `bob.toml`] is the source of truth, and `bob schedule
add`/`remove` edits that file"*, citing ADR-006. ADR-012 (2026-06-30)
explicitly reversed this — schedules moved to
`$XDG_STATE_HOME/bob/schedules.json`; ADR-006, ADR-007, and ADR-009 were all
amended, and S-009 was amended accordingly. The architecture doc was not.

Related smaller staleness in the same doc: the open-design-item note on
session identity cites S-008 for `context_id` (S-008 is superseded), and the
security section still presents the scheduler's *derived
`UserId`/`ChannelId` per job* as its identity story without noting ADR-012
removed that identity's admission role (attribution-only now).

### 2.3 The three status accounts disagree: roadmap vs README vs specs/ADRs

- **`roadmap.md`** says *"Status: complete through Phase 1b"* and describes
  Phases 2–7 in future tense.
- **`README.md`** says the service *"currently runs through Phase 6 (chat
  channel)"*, with Policy Control (4), Monitoring (5), and the JS extension
  (3) implemented — but also that *"the remaining channel adapters (email,
  scheduler) … are not yet implemented."*
- **S-004's Purpose** states Phases 2 and 3 are complete; **ADR-012's
  Context** describes the scheduler's runtime behaviour as it exists
  *"today"* (derived-UUID pre-flight denials at firing time), which only an
  implemented scheduler can exhibit; and the README itself lists `schedule`
  among the available `bob` subcommands two paragraphs before saying the
  scheduler is not implemented.

Only one of these can be true at a time. The roadmap's status line is the
most out of date; the README is internally contradictory about the
scheduler.

### 2.4 README describes the pre-CR-002 chat and calls CI a placeholder — contradicting CLAUDE.md and itself

- **Chat:** README says `bob chat` *"opens a chat subscription and sends each
  stdin line as a `chat.send` call"*, with the interactive-chat adapter
  normalizing into the request queue *"where the requests-handler runs
  pre-flight admission"*, and lists the *"Interactive-chat adapter
  (Phase 6)"* as a shipped feature. All of that is the retired path:
  CR-002/ADR-010/ADR-011 replaced it with a supervised direct `pi` session
  exempt from pre-flight admission, and the S-006 chat adapter was removed
  from the active spec on 2026-06-23.
- **CI:** README says (twice — the repo-structure tree and the closing note)
  that `.github/workflows/` are *"placeholders today (echo-only)"*. CLAUDE.md
  describes a real CI: `build.yml` running format/build/rust-docs/user-docs/
  tests on PRs and pushes, and `deploy.yml` attaching the release binary and
  mdBook docs on tag pushes. The README even relies on that same pipeline
  elsewhere: its "Pre-built docs archive" section says every GitHub Release
  attaches a rendered docs archive — impossible with echo-only workflows.
  S-007's amendment log confirms the release-docs CI was in scope (T-083/084).

### 2.5 `roadmap.md` Phase 6 still lists chat as a channel adapter

Roadmap Phase 6: *"channel adapter integrations for chat, email, and
scheduler."* S-001's Phase 6 row was amended on 2026-06-23 to state that
interactive chat is *"a supervised, directly-launched `pi` session per
CR-002 / ADR-010 — no longer an `admin.sock` chat subscription"*, and S-006
now scopes the framework to non-chat adapters (scheduler first, S-009). The
roadmap was not updated.

### 2.6 S-001 internal staleness left behind by its own amendments

- The **System Diagram** still labels the service *"Rust service (single
  OS-agnostic binary)"* while the 2026-05-16 amendment narrowed Design
  Principles and Component 1 to *"Unix-likes (Linux and macOS)"* — the
  diagram was missed.
- **Open Questions** still asks for *"the OS-agnostic transport for the
  external-tool report interface (local HTTP endpoint vs. a reporting
  CLI)"* — contradicting the same spec's amended Component 1 (candidates
  narrowed to UDS-only: extend `admin.sock` or a `report.sock`) and the
  decision actually taken and shipped in S-005 (`report.submit` on
  `admin.sock`, dedicated socket explicitly excluded, ratified in ADR-007).
  The question is answered but never closed.
- The other two S-001 open questions (async blocking `tool_call` verdict;
  `runRpcMode()` as the prompt channel) remain marked `[TODO]` — and are
  repeated as open in `the-intern-architecture.md` and S-004 — although
  README and S-004's own Purpose describe Phases 2–4 as delivered, which
  those verifications were prerequisites for. Either the docs should record
  the verification outcome or the phases shipped with the question open;
  the record doesn't say which.

### 2.7 pi-agent version record is split

README's compatibility section states the bob extension is tested against
`@earendil-works/pi-coding-agent` **0.75.3 only**, with any other version
unsupported until the compatibility record is updated. ADR-011's Context
records interactive-pi behaviour *"verified during T-103 (pi **0.79.10**)"*.
If T-103 was executed against 0.79.10, either the compatibility record in the
README is stale or the supervised interactive path runs against an
officially unsupported pi version. The two statements need reconciling.

### 2.8 CLAUDE.md folder tree is behind the repo it describes

- `the-intern/extensions/` is annotated *"Future JS extension/plugin code
  area"*, but S-003 (approved, delivered per README) ships `bob.ts` there —
  it is present, load-bearing code (the S-004 authz membrane), not future.
- The tree omits `the-intern/docs/` entirely, although the same file's CI
  section describes the `user-docs` job that builds the mdBook from that
  directory, and S-007/README treat it as the shipped user manual.
- The `project/` tree omits `reports/`, which `project/CLAUDE.md` names as a
  standard artifact directory.

### 2.9 Minor tensions between the logical model and the concrete record (mostly acknowledged, listed for completeness)

- `system_overview.md`'s component diagram includes an **"MCPs or SKILLs"**
  node, while S-001 and the architecture doc categorically exclude MCP
  ("pi-agent has no MCP client"). ADR-008 deliberately leaves
  `system_overview.md` un-rewritten as the implementation-agnostic model, but
  "MCP" is an implementation-level term, so the diagram reads as endorsing
  an option the concrete record rejects.
- The logical model's layered view routes **every** request through
  "Monitoring and Policy control" before the Agent Harness. ADR-010 exempts
  interactive chat from the pre-flight half of that (retaining the per-action
  half). This is a recorded, reasoned narrowing — not an oversight — but a
  reader of `system_overview.md` alone would draw the wrong conclusion for
  the chat channel; a one-line pointer to ADR-010 would close the gap.
- `system_overview.md`'s desired channel list (email, IM, OS notifications,
  OS schedule, chat) is broader than the committed set in ADR-008 (chat,
  scheduler, email-by-polling). Consistent with its "desired" framing, but
  worth knowing the committed subset lives in ADR-008, not here.

---

## 3. Summary judgement

The **spec + ADR corpus is in good internal shape**: the amendment logs are
disciplined, CR-002 (interactive chat) and CR-004/ADR-012 (scheduler
admission and state) were propagated through S-001, S-002, S-004, S-005,
S-006, S-007, S-009 and cross-amended into ADR-005/006/007/008/009/010. The
inconsistencies are concentrated in the **narrative documents that sit
outside the amendment discipline** — `the-intern-architecture.md` (§2.1,
§2.2), `roadmap.md` (§2.3, §2.5), `README.md` (§2.3, §2.4, §2.7), and
`CLAUDE.md` (§2.8) — which were not swept when CR-002 (2026-06-23) and
ADR-012 (2026-06-30) landed. A single reconciliation pass over those four
files, plus closing S-001's answered open question (§2.6), would restore a
consistent artifact set.
