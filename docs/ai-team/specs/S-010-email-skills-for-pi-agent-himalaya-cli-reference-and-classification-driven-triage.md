---
title: 'Email Skills for pi-agent: Himalaya CLI Reference and Classification-Driven
  Triage'
version: '0.2'
status: approved  # draft | review | approved | superseded
created: '2026-08-01'
author: planner
id: S-010
---

# Email Skills for pi-agent: Himalaya CLI Reference and Classification-Driven Triage

## Purpose

S-009 and the architecture overview already name "the himalaya skill" / "the
email skill" as the mechanism that turns a scheduler-fired prompt into actual
email handling — but that skill has never been built, and S-003 and S-004
both explicitly parked "agent skills" (S-001 Component 3's third bullet) as
deferred to a later spec. This is that spec. Today an operator can configure
`bob schedule add --id check-email --cron "*/15 * * * *" --prompt "Check
email..." --cwd <workspace>`, and bob will faithfully fire pi-agent on
schedule, but nothing in `<workspace>` teaches pi-agent how to use
`himalaya`, and even once it does, S-004's default-deny action gate blocks
every `bash` tool call until an explicit allow rule admits it — so the
wired-up polling path delivers no working email behaviour today. This
matters now because the human wants email handling to actually work: new
mail detected, classified, and either acted on or escalated, with continuity
across independent scheduler ticks. When this work is done, an operator can
point a scheduled job's per-entry `--cwd` at this shipped skill package, add
the required S-004 allow rule, and each firing will process unseen mail end
to end. Success is confirmed when a completed run leaves no unseen message
unclassified — every unseen message results in an action, an escalation, or
a recorded block — and a corresponding entry exists in that day's worklog
for every message processed.

## Exclusions

What this specification explicitly does NOT cover:

- **A new bob-side channel adapter or push ingress.** Email detection reuses
  the existing S-009 scheduler exactly as built. ADR-008 §4 already commits
  the channel set to interactive chat, scheduler, and "email-by-polling",
  naming "email via the scheduler driving a skill" as the intended shape —
  this spec fills that shape rather than revisiting it. A real-time
  IMAP-IDLE-watching adapter was considered and rejected in brainstorming.
- **Changes to `the-intern/bob-companion/claude` or this repo's own
  `.claude/skills`.** Those are, respectively, Claude Code dev-tooling for
  operating `bob` and this repository's own AI-team process tooling — neither
  is where pi-agent discovers its runtime skills. This package ships
  separately (see Configuration Requirements for its location).
- **himalaya account and manager-address setup.** Both skills assume a
  working himalaya IMAP/SMTP account and a configured manager escalation
  address already exist. Bootstrapping either is out of scope.
- **The S-004 action ruleset entries themselves.** This spec requires that an
  allow rule admitting this package's `bash`/himalaya invocations exists
  (Configuration Requirements), but authoring and maintaining that rule is
  ordinary S-004 operator configuration, not new work this spec delivers.
- **Exhaustive per-category business logic.** The starter taxonomy and its
  reference workflows are an initial, adjustable sketch, not committed final
  policy for every kind of email a user might receive.
- **Read-only scope.** A read-only "detect and summarize only" version was
  considered and rejected; this skill composes, sends, replies, and
  organizes mail, not just reports on it.
- **Reversibility- or allowlist-gated autonomy.** Two alternative autonomy
  models — gating on whether an action is externally visible/reversible, and
  gating on a sender/category allowlist — were considered and rejected in
  favor of confidence-gated autonomy (see Design Principles).
- **A skill-owned dedup state file.** A bespoke last-seen-message state file
  was considered and rejected in favor of relying on the mailbox's own
  `\Seen` flag, to avoid introducing a second, skill-owned persistence
  mechanism.
- **Reporting through `bob`'s audit trail as the work-tracking mechanism.**
  `report.submit` (S-005) was evaluated directly: it is a structured record
  (submitting tool/action name, outcome status, optional session id, optional
  human-readable summary) that explicitly excludes arbitrary tool-defined
  metadata, so it cannot hold a real day-by-day working record. This spec
  uses a local diary for that purpose and makes no `report.submit` calls.
  This is additive, not a loss of visibility: bob already records each
  scheduled firing as an `event` audit record carrying the resolved working
  directory (S-005, amended 2026-07-05), and every himalaya `tool_call` this
  package makes is already recorded as a `verdict` record by the existing
  S-004/S-005 path, independently of this skill.

## Architecture

### Design Principles

- **All triage logic stays on the pi-agent side.** This spec adds no bob
  channel adapter, admin-RPC method, or core type: what the skills *do* is
  decided entirely in skill content, not in the service. It no longer claims
  that skills require no bob-service change at all — S-011 and ADR-014 move
  skill delivery into bob, which resolves a skill install path and supplies it
  through its extension, so skills no longer depend on the working directory.
  This spec's scope remains the triage policy carried by that content.
- **New-mail detection relies on IMAP-native state, not a second persistence
  mechanism** — but classifying a message requires reading it, which sets
  `\Seen` regardless of outcome. The design must not introduce its own
  last-seen tracking file for detecting new mail, and must not rely on
  `\Seen` alone to represent "still needs attention": an escalated or
  blocked message is tracked as open exclusively through the worklog, not
  through its mailbox flag state.
- **Autonomy is gated on classification confidence for the specific message,
  not on the action's reversibility or a static allowlist.** Whether the
  skill acts or escalates must be determined per-message by how confident the
  classification is.
- **A request for guidance must resolve to an addressable artifact, never a
  blocking wait.** Because a `periodic` request has no caller to answer it
  (ADR-004), "escalate" must mean producing something a human can act on
  later (an email to a configured recipient), not pausing for a synchronous
  reply within the same run. If that escalation email itself is blocked by
  the S-004 action gate, the block must be recorded as an open item, and
  must never be treated as license to act on the message autonomously
  instead.
- **Continuity across independent firings must be reconstructable entirely
  from the job's own working directory, and must tolerate skipped ticks.**
  No bob-side session or queue state may be relied upon to persist between
  scheduler ticks. Bob being stopped at a tick (ADR-006), a missing per-entry
  `cwd` (S-009), or `max_processes` exhaustion preventing the dedicated
  worker a per-entry-`cwd` job requires (S-002) can all eliminate a given
  day's first run; the design must reconcile against the most recent worklog
  containing open items, not assume "yesterday" is always the last time the
  skill ran.
- **The CLI-reference skill stays free of any single job's triage policy.**
  Nothing escalation-specific or taxonomy-specific belongs in the generic
  himalaya skill, so any other pi-agent invocation that happens to run with
  this package's directory as its cwd — including an interactive `bob chat`
  session invoked from that same directory (`bob chat` uses its invocation
  cwd, not `pi_agent_cwd`, per S-002) — can use it without inheriting this
  job's escalation rules or taxonomy.
- **Every action this package takes remains subject to S-004.** The
  `email-triage` skill does not carry its own authorization model; every
  `bash` invocation it or the `himalaya` skill make — including the manager
  escalation send — passes through the existing default-deny action gate,
  and an admitting allow rule is a required deployment prerequisite, not
  something this spec grants implicitly.

### System Diagram

```
bob scheduler (S-009, unchanged)
   |  cron tick -> periodic InternalRequest
   |  prompt: "Check email..."   cwd: <workspace>
   v
pi-agent session (runs in <workspace>)
   |  discovers skills from cwd
   +--> himalaya skill (CLI reference: how to run each command)
   +--> email-triage skill (policy: what to do)
             |
             |  himalaya envelope list --flag unseen
             v
        mailbox (IMAP/SMTP, operator's own account)
             |
   +---------+----------+
   | confident           | not confident
   v                     v
 act per matched       send escalation email
 category workflow      to manager address
 (himalaya, via bash,   (himalaya, via bash,
  gated by S-004)        gated by S-004)
   |                     |
   +----------+----------+
              v
   append entry to <workspace>/worklog/<today>.md
              |
   (next executed run reads the most recent worklog
    entry with open items — not necessarily yesterday's)
```

### Responsibility Separation

| Component | Responsibility | Notes |
|---|---|---|
| `himalaya` skill | Teaches pi-agent the himalaya CLI's commands and flags | Generic; carries no email-specific policy; reusable outside this job |
| `email-triage` skill | Defines new-mail detection, classification, per-category action policy, escalation policy, and diary discipline | The only component that is triage-policy-aware |
| Category reference workflows | One file per taxonomy category describing what a confident match in that category should do | Referenced by the `email-triage` skill; the taxonomy is fixed per release, not a user extension point |
| Daily worklog | Record of what was done, what's left, and what's next per calendar day | Read at the start of each day's first executed run; appended to after every handled message |
| Manager escalation channel | The addressable "ask for guidance" path for low-confidence classifications | An email sent via himalaya to an operator-configured address, falling back to the mail account's own address when that configuration is missing or malformed; no synchronous response expected within the run |
| S-004 action ruleset (existing) | Default-deny allow-list gating every `bash` tool call this package makes | Unmodified by this spec; an allow rule admitting the package's himalaya invocations is a deployment prerequisite |
| bob scheduler (S-009, existing) | Fires the periodic pi-agent session that discovers and runs these skills | Unmodified; this spec adds no bob-core or bob-service changes |

## Components

### Component 1: `himalaya` skill

**Purpose:** Teaches pi-agent how to invoke every himalaya CLI operation the triage workflow needs — list/search envelopes, read, reply, forward, write/send, move/copy, delete, manage flags, attachments, multi-account.
**Estimated size:** Small — adapted from an existing, inspected reference package.
**Interfaces:** Exposes markdown instructions discoverable from a pi-agent session's `cwd`; consumes an already-configured himalaya CLI account.

### Component 2: `email-triage` skill

**Purpose:** Defines the end-to-end triage workflow: detect unseen mail, classify it, act or escalate per the Design Principles, and maintain the daily diary.
**Estimated size:** Medium.
**Interfaces:** Exposes markdown instructions discoverable from the same `cwd`; consumes the `himalaya` skill's CLI knowledge, the category reference workflows, and the local diary file; produces himalaya invocations and diary entries.

### Component 3: Category reference workflows

**Purpose:** One reference file per taxonomy category, describing the concrete steps to take once a message is confidently classified into that category.
**Terminal category:** Beyond the starter taxonomy, one category recognizes the skill's own escalation mail — a self-addressed escalation, produced by the fallback in Configuration Requirements, that arrives back in the same mailbox as unseen mail and re-enters triage on a later run. A confident match there is filed and neither replied to nor escalated again, so the fallback cannot re-escalate its own output indefinitely. Unlike the starter categories, this one is a structural guard on the escalation path rather than adjustable business policy: if filing it is blocked by S-004, the block is recorded as an open worklog item and the message is still never escalated.
**Estimated size:** Small per file; the starter taxonomy is a handful of files.
**Interfaces:** Referenced by the `email-triage` skill; the taxonomy is fixed at release time — adding or changing a category means shipping a new version of the package, because a deployed workspace's skill content is replaced on upgrade and local additions would not survive it.

### Component 4: Daily worklog

**Purpose:** A per-calendar-day markdown diary recording what was done, what's left, and what's next, and the sole record of anything left open by an escalation or an S-004 block once the underlying message is marked `\Seen`.
**Estimated size:** Small.
**Interfaces:** Appended to by the `email-triage` skill after each handled message; read by the `email-triage` skill at the start of each day's first executed run.

## Workflow

```
Wall clock reaches the configured cron tick (bob scheduler, S-009, unchanged)
  ↓
bob fires the periodic pi-agent session in the configured workspace cwd
  → tick missed while bob was stopped (ADR-006): skipped silently — no
    process, no warning, no monitoring record
  → cwd missing (S-009) or max_processes exhausted (S-002): skipped with a
    warning and a monitoring failure record
  → either way: no session runs, nothing below happens this tick
  ↓
pi-agent discovers the himalaya and email-triage skills from that cwd
  ↓
email-triage skill: is this the day's first executed run (the most recent
run may not have been yesterday, if ticks were skipped)?
  → yes: read the most recent worklog entry that has open items and
    reconcile against it, including any pending manager escalation
  → no: continue
  ↓
email-triage skill lists unseen envelopes via the himalaya skill's commands
  ↓
For each unseen message, classify against the taxonomy:
  → high confidence: act per the matched category's reference workflow via
    a himalaya `bash` call
    → S-004 blocks the call: record the block as an open worklog item;
      the message is not treated as handled
  → ★ low confidence: send an escalation email to the configured manager
    address via a himalaya `bash` call, describing the situation and the
    question; take no further action on this message this run
    → escalation configuration missing or its address malformed: send the
      same escalation to the mail account's own address instead, also
      stating that the configuration was missing and where it was
      expected; that mail returns as unseen mail on a later run, matches
      the terminal category, and is filed rather than escalated again
      → account's own address undeterminable: record it in the worklog
        and take no further action on this message this run
    → S-004 blocks the send: record the block as an open worklog item;
      never fall back to acting on the message autonomously because
      escalation failed
  ↓
Append a worklog entry for the message: what was done / what's left / next.
Reading the message already set its `\Seen` flag, so an escalated or
blocked message will not reappear as "unseen" on the next tick — the
worklog, not the mailbox, is what carries it forward as open.
  ↓
(no response path back to bob — periodic requests are fire-and-forget,
 ADR-004; the next tick repeats this workflow)
```

**How an open item closes.** Reconciliation happens only on each day's first
executed run, not on every tick — a `*/15`-style cron does not revisit the
open-item list intra-day. An item closes when its underlying cause resolves
on some later run: an escalation closes when the manager's reply arrives as
ordinary unseen mail and re-enters triage like any other message; an S-004
block closes once the required allow rule is in place. Until then, the item
is simply carried forward as still-open in each day's first-run
reconciliation.

## Configuration Requirements

- **S-004 action-ruleset allow rule.** An explicit allow rule in bob's
  existing action ruleset admitting the `bash` tool calls this package
  issues. **Why:** S-004's action gate is default-deny — a missing or empty
  action list denies all tool calls — so neither skill can act at all
  without one. **Where:** bob's existing S-004 action-ruleset configuration;
  this spec adds no new bob-side mechanism, only a required entry in it.
  **Constraints:** the rule must be scoped narrowly enough to admit this
  package's himalaya invocations without being a blanket `bash` allow.
  **Default behavior:** an unadmitted `bash` call is blocked by S-004; per
  the Workflow, the block is recorded in the day's worklog as an open item,
  never silently dropped.

- **Manager escalation address.** A single email address the skill sends
  low-confidence escalations to. **Why:** gives a fire-and-forget periodic
  run an addressable way to request guidance instead of blocking. **Where:**
  skill-local configuration within the job's `cwd`, not bob's TOML config —
  consistent with keeping channel/action specifics out of bob-core and with
  ADR-008 §5's precedent that actions use their own configuration.
  **Constraints:** must be a single well-formed email address. **Default
  behavior:** an escalation send blocked by S-004 is a hard stop for that
  message — the skill must record the block in the day's worklog and must
  never fall back to acting autonomously because escalation didn't go
  through. A missing configuration file, or an address that is absent or
  malformed, is *not* a hard stop: the run must still escalate, addressed
  instead to the mail account's own address, so the escalation surfaces in
  the mailbox the human already reads. That address must come from what
  the himalaya CLI already reports for the configured account — the
  `From:` header on the first line of the draft `himalaya template write`
  emits when invoked with no arguments — so this path requires no new
  configuration key. Like every other himalaya invocation this package
  makes, that call is subject to the S-004 action ruleset and an allow rule
  admitting it is a deployment prerequisite. An escalation sent this way
  must additionally state that the
  configuration was missing or malformed and name the directory where the
  file was expected, and this substitution applies to every message
  needing escalation for as long as the configuration stays missing or
  malformed. If the account's own address cannot be determined either, the
  skill must record that in the day's worklog and take no further action
  on that message this run — never hard-stopping the run, guessing an
  address, or acting on the message autonomously instead.

- **himalaya account.** A working IMAP/SMTP account already known to the
  himalaya CLI. **Why:** both skills assume himalaya can already read and
  send mail. **Where:** himalaya's own configuration, owned entirely outside
  this spec, per ADR-008 §5 ("bob custodies no secrets. Actions use the
  user's own existing credential stores under the same uid"). **Constraints:**
  out of scope here; assumed present. **Default behavior:** if himalaya is
  not configured, the first command fails and that failure is recorded in
  the day's worklog like any other run-ending problem.

- **Scheduled job working directory (per-entry `--cwd`, required).** The
  workspace a scheduled "check-email" job resolves to, set via S-009's
  per-entry `--cwd`. **Why:** the manager-address configuration and the
  daily worklog are read from and written to this directory. Per S-011 and
  ADR-014, skill *discovery* no longer depends on this directory — bob
  resolves a single shared install path for both skills and supplies it
  through its extension regardless of where a session runs — but the
  manager-address configuration and worklog diary remain per-job state and
  stay `--cwd`-scoped. `pi_agent_cwd` is not an acceptable alternative for
  that state: it is shared by every warm-pool worker (S-002), so routing it
  through there would leak one job's manager address and diary into
  unrelated sessions, contradicting this spec's isolation principle.
  **Where:** bob's existing schedule-entry
  configuration (S-009); this spec adds no new bob-side setting.
  **Constraints:** must be an absolute path, kept under the same owner-only
  permissions as `schedules.json` itself — ADR-012 §7 records the working
  directory as a trusted, unchecked input, so filesystem permissions are the
  only gate against another principal injecting content through it.
  **Default behavior:** unchanged from S-009 — a per-entry `cwd` that does
  not exist at fire time skips that fire with a warning and a monitoring
  failure record; because a per-entry-`cwd` job also requires a dedicated
  worker (S-002), exhaustion of `max_processes` produces the same
  skip-with-warning outcome.

- **Package location and installation.** The two skills ship as a versioned
  package within the product repository — the source of truth — separate
  from `bob-companion` and from this repo's own `.claude/skills` (for
  example a new top-level directory under `the-intern/`, sibling to
  `bob-companion`). **Why:** gives the package a stable, reviewable home
  shipped alongside `bob` itself, distinct from both the Claude Code
  dev-tooling plugin and the AI-team process tooling. **Where:** the
  repository holds the versioned source; per S-011 and ADR-014, bob installs
  that package once to a shared install path it resolves and supplies to pi
  through its extension, independent of any job's `--cwd` — not as a
  **deployed copy** placed inside each scheduled job's own working
  directory. The scheduled job's per-entry `--cwd` still holds the mutable
  runtime state scoped to that job (the skill-local manager-address
  configuration and the `worklog/` diary), which must be owner-only
  permissioned per the requirement above, but no longer needs to hold a copy
  of the skill content itself. **Constraints:** the job's `--cwd` is
  owner-only, matching the requirement above; the repository checkout is
  never used directly as bob's skill install path or as a scheduled job's
  `--cwd`. Per CR-005's resolved decision that "a pi working directory is
  agent content, not a bob-managed XDG bucket," ADR-009's XDG layout does
  not apply to the job's `--cwd` or to the diary it holds; the skill install
  path's own layout is S-011/ADR-014's concern, not this spec's.
  **Default behavior:** not applicable — this is a repository/deployment
  layout requirement, not a runtime setting.

## Implementation Order

| Phase | What | Depends On |
|---|---|---|
| 1 | Author and ship the `himalaya` skill (adapted CLI-reference package) as a standalone product artifact, at the package location defined above. | Nothing |
| 2 | Author the `email-triage` skill's core loop: unseen-mail detection via the `\Seen` flag, diary read/write with skip-tolerant reconciliation, and the escalation-to-manager path (including S-004-block handling), without the full category taxonomy (a single generic act-or-escalate behavior). | Phase 1 |
| 3 | Draft the starter category taxonomy and one reference workflow file per category; wire classification into the `email-triage` skill so it selects and follows the matched category's workflow. | Phase 2 |
| 4 | End-to-end validation against a real scheduled job (`bob schedule add` with a per-entry `--cwd` pointing at the shipped package, plus the required S-004 allow rule): confirm ticks produce worklog entries, escalations reach the manager address, blocks are recorded rather than dropped, and the next executed run picks up prior open items. | Phase 3 |
| 5 | Document operator setup — himalaya account, manager address, the S-004 allow rule (with a concrete worked example of the allow rule's argument-matcher shape, since S-004's own glob/argument-path syntax is still an open question there), and `bob schedule add --cwd` usage — in the S-007 operator guide. | Phase 4 |

## Alternatives Considered

- **A new push-based channel adapter.** A standalone process watching the
  mailbox (for example via IMAP IDLE through himalaya) and pushing an event
  into bob in real time. *Rejected:* it would require a new S-006 adapter and
  would revisit ADR-008's pull-only ingress stance; the existing S-009
  scheduler already provides the polling trigger this skill needs, with no
  bob-side change.
- **Read-only scope.** Detect and summarize new mail only, no side effects.
  *Rejected:* the human explicitly wants read-and-act — composing, sending,
  replying, and organizing mail, not just reporting on it.
- **Reversibility-gated autonomy.** Run read-only/internal actions
  autonomously; anything externally visible (sending, deleting) always
  escalates first. *Rejected* in favor of gating autonomy on classification
  confidence for the specific message.
- **Sender/category allowlist-gated autonomy.** Autonomy determined by
  whether the sender or category is on an explicit allowlist, regardless of
  the action taken. *Rejected* for the same reason: confidence in the
  classification is the chosen axis, not a static trust list.
- **A skill-owned last-seen state file.** Track a last-seen message UID or
  timestamp in a local state file to detect new mail across ticks.
  *Rejected* in favor of relying on the mailbox's own `\Seen` flag, avoiding
  a second, skill-owned persistence mechanism. Accepted limitation: another
  mail client toggling `\Seen` outside this skill's runs could cause a
  message to be missed or re-seen.
- **A single merged skill.** Combine the himalaya CLI reference and the
  triage policy into one skill file. *Rejected* in favor of two skills, so
  the CLI-reference skill stays reusable by other pi-agent invocations
  sharing this package's cwd (for example an interactive `bob chat` session
  invoked from that directory) without carrying this job's escalation rules
  or taxonomy.
- **Policy embedded in the scheduled prompt instead of a skill.** Ship only
  the generic himalaya skill and put all triage policy in the scheduled
  job's `--prompt`/`--file` text (as S-009's own worked example does).
  *Rejected:* this would ship no real triage behavior, only CLI knowledge,
  leaving every operator to author the whole workflow from scratch.
- **Reporting through bob's audit trail as the work-tracking mechanism.**
  Use `report.submit` over `admin.sock` (S-005) as the record of work done.
  *Rejected* after checking S-005 directly: it is a structured record (tool/
  action name, outcome status, optional session id, optional summary) that
  explicitly excludes arbitrary tool-defined metadata, so it cannot hold a
  real day-by-day working record. A local daily diary is used instead; this
  is additive to, not a replacement for, the existing audit trail — bob
  already records each scheduled firing as an `event` record and every
  himalaya `tool_call` as a `verdict` record independently of this skill.
- **A per-conversation worklog layout.** An earlier draft proposed
  `<date>/<conversation-id>_<email-from>/log.md`, one folder per email
  thread. *Superseded* by a simpler one-file-per-calendar-day diary that the
  skill appends to throughout the day and reads back on the next executed
  run.

## Amendment Log

| Date | What changed | Why | Affected tasks |
|------|-------------|-----|----------------|
| 2026-08-06 | The "No bob-core or bob-service changes" design principle replaced by "All triage logic stays on the pi-agent side": this spec still adds no channel adapter, admin-RPC method, or core type, but no longer claims skills require no bob-service change, since skill delivery moves into bob. | ADR-014 accepted 2026-08-06 / S-011. Skills are supplied by bob through its extension and no longer resolve from the working directory. | S-011 breakdown tasks (Gate 2 pending). |
| 2026-08-07 | Three escalation- and taxonomy-related changes: (a) the category taxonomy is no longer a user extension point — it is fixed per release (Component 3 and the Responsibility Separation row); (b) a missing or malformed escalation configuration no longer hard-stops the message — the run escalates to the mail account's own address, stating that the configuration was missing and where it was expected, and records the message in the worklog without further action only when that address is undeterminable, while an escalation send blocked by S-004 remains a hard stop (Workflow, Configuration Requirements); (c) the taxonomy gains a terminal category for the skill's own escalation mail, which is filed and never escalated again (Component 3). | CR-006 items 3, 5, and 6, driven by the PR #42 review. Skill content ships with releases, so invited local category edits would be overwritten on upgrade; an escalation must still reach a human when its address configuration is absent, rather than stopping every message that needs one; and the self-addressed escalation that creates would otherwise re-escalate itself indefinitely. | T-143, T-144, T-145, T-146 |
