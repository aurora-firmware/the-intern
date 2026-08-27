---
title: bob worklog subcommand — append, list, and automatic first-run 
  reconciliation
version: '0.3'
status: review  # draft | review | approved | superseded
created: '2026-08-26'
author: planner
id: S-015
---

# bob worklog subcommand — append, list, and automatic first-run reconciliation

## Purpose

The `worklog` skill's entry and reconciliation mechanics are entirely prose
today: a session must hand-run an exact shell append, and hand-run a
separate carry-forward procedure on a day's first run, getting both exactly
right every time. This has already produced two fixed defects on the same
mechanism — `B-039` (no instruction to look up the real time at all) and its
successor GitHub #64 (the fix for `B-039` introduced a hand-transcribed
`<NOW>` placeholder that was itself routinely transcribed wrong) — and two
currently open ones: #62 (carry-forward has no dedup rule, so a still-open
item accumulates one extra copy every day it stays open) and #63 (the file
is append-ordered, not time-ordered, under concurrent scheduled runs, and
nothing says so). `bob` already has a working precedent for replacing
exactly this kind of prose-executed-by-an-LLM mechanism with a real command
— `bob task` (S-014) — so this spec applies the same move to the worklog.
When this work is done, a session writes and reads worklog entries through a
`bob worklog` command instead of a raw shell recipe, first-run reconciliation
happens automatically and correctly on every invocation rather than
depending on a session getting a multi-step procedure right, and #62 and #63
are closed as fixed by construction rather than left open in prose.

## Exclusions

What this specification explicitly does NOT cover:

- **A standalone `reconcile` subcommand.** Considered during brainstorming
  and explicitly rejected: reconciliation is triggered unconditionally and
  internally by both `append` and `list`, with no separate entry point. This
  was chosen specifically to remove "did I remember to reconcile first" as a
  failure mode; a standalone command would reintroduce it as an optional
  step someone could still forget to run.
- **Upward directory search for the worklog location, mirroring `bob
  task`'s board resolver.** This is this specification's own decision, not
  a restatement of an existing rule: `S-011`'s actual constraint (§"Skill-local
  configuration and worklog storage") is that the skill-local configuration
  file and the daily worklog "remain relative to the session's own working
  directory", reinforced by `ADR-014` §5 ("a scheduled job's continuity is
  still reconstructable entirely from its own working directory") — neither
  states an isolation guarantee against a directory-searching resolver. The
  human confirmed cwd-strict resolution explicitly during brainstorming, as
  this spec's own divergence from `bob task`'s board (which does search
  upward, and is not thereby considered to have moved the board "out of" the
  working directory under `S-011`'s own exclusion, §Exclusions, "Moving
  worklog storage out of the working directory"). Because
  this sets a resolution convention a future filesystem-only subcommand
  might otherwise assume applies universally, the divergence is recorded as
  its own ADR at Gate 1 approval rather than left as an unexplained spec
  bullet.
- **Keeping the existing raw-shell append/reconciliation prose as a
  documented fallback.** Rejected: the mechanics are fully replaced by the
  command, matching how `bob task` (S-014) replaced its own hand-written
  prototype outright rather than carrying two descriptions of one mechanism
  that could drift apart.
- **Computing "what is still open" at `list`-time without ever writing
  carried-forward copies to the file.** Considered: it would fix #62 by
  construction, since nothing would ever be duplicated. Rejected: today's
  worklog file is the durable record of what was known-open on that
  specific day; computing this at read time would break that guarantee
  without also reading backward through prior days on every query — a
  larger semantic change than requested.
- **Changes to the `email-triage` skill beyond pointing it at the new
  command.** Its detection, classification, and act-or-escalate logic are
  unrelated to how the diary is written; `S-011` already scoped
  `email-triage` to delegate all diary mechanics to `worklog`.
- **A dedicated Rust crate for the worklog logic.** Rejected on the same
  `ADR-003` precedent `bob task` (S-014) already applied: a single Rust
  consumer exists today, and extraction into its own crate later is
  mechanical.
- **Task assignment, priority, or any second organizing axis beyond
  chronological order and per-item identity.** The worklog answers what
  happened and what remains open for a given item; anything requiring a
  second sorting axis is out of scope, mirroring `bob task`'s own exclusion
  of the same idea.
- **File-locking or an atomic-transaction guard against two truly
  simultaneous first invocations of the day.** Following `S-014`'s own
  precedent of excluding locking/merge/sync mechanisms under `ADR-008`'s
  single-operator scope: the idempotency rule below (Design Principles)
  bounds the exposure to at most one duplicate carried-forward entry in that
  narrow race window, rather than eliminating the race entirely. That bound
  is still a strict improvement over #62's current unbounded growth.
- **Extending `S-012`'s `tasks/`-style "`--force` never removes or replaces
  anything inside it" guarantee to `worklog/`.** `worklog/` has never carried
  that guarantee and this spec does not regress it, but granting it is a
  separate, independently decidable change to `S-012`, not part of this
  spec.

## Architecture

### Design Principles

- **Recording or reading a worklog entry must never depend on `bob serve`
  being up.** Every operation completes with no admin socket present and no
  service process running, exactly as `bob task` already guarantees for the
  board, per `ADR-007`'s amended invariant that a subcommand needing nothing
  from the service uses nothing.
- **A session's worklog must depend only on its own working directory.**
  The command must never search outward for one; two sessions with
  different working directories must never be able to see or extend the
  same diary. This is this specification's own decision (see Exclusions).
- **A missing `worklog/` directory must never be silently invented by a
  read.** `list` fails, naming the directory it looked for, rather than
  reporting an empty day and concealing a wrong working directory — the same
  guarantee `bob task`'s board resolver gives reads (S-014 Design
  Principles: "reading must never invent one"). `append`, being a write, may
  still create `worklog/` and today's file when neither exists.
- **Ensuring the day is reconciled must never be a step a caller can skip
  or forget.** Every entry point that touches today's file performs
  reconciliation first, unconditionally, before doing its own work.
- **Carrying a still-open item forward must be idempotent by
  item-identifier, tested by presence, not by a separate marker.** An item
  is carried forward into today's file if and only if (a) today's file does
  not already contain an entry for that item-identifier, and (b) the most
  recent *prior worklog file that exists* — regardless of whether that file
  currently shows anything else as open — has an entry for that
  item-identifier whose `Left` field is not `nothing` per the Contract's
  comparison rule. Condition (b) is deliberately "the nearest prior file
  that exists", not "the nearest prior file with open items": filtering on
  "has open items" at the whole-file level is wrong — a day that closes
  every item it mentions is real information and must not be skipped past
  in favor of an older file that never learned of that closure, which would
  wrongly resurrect a genuinely closed item. This makes repeated
  reconciliation attempts naturally idempotent — a second attempt finds the
  entry already present under condition (a) and does nothing — with no "has
  today been reconciled" flag to keep in sync separately. However many days
  an item has stayed open, at most one carried-forward copy of it can exist
  in any single day's file under this rule, outside the narrow
  concurrent-first-run race excluded above.
- **A day's presented order must reflect actual entry time, not physical
  file position.** Concurrent writers make write order an unreliable proxy
  for chronological order; anything that presents a day's entries must sort
  by the entry's own timestamp.
- **The command is the normative definition of the entry format, and that
  format must stay intelligible without this repository.** Skill prose may
  describe the format but must not redefine it; every other description of
  it is derived and may not contradict what the command actually writes.
  Because this command's rewrite of the shipped `worklog` skill text is
  itself shipped content, it carries `S-011`'s and `S-014`'s existing
  constraint that skill content must be readable without access to this
  project's specs, decisions, tasks, or bugs.
- **The on-disk file must remain plain, human-readable markdown
  independent of the command.** An operator, or a session with no access to
  `bob worklog`, must still be able to read a day's file directly.
- **Every tool call the command makes remains subject to the existing
  action-authorization gate.** This specification grants no new authority.

### System Diagram

```
   Operator shell            pi session (chat / scheduled)
        │                              │
        │  bob worklog append|list     │  bash: bob worklog append ...
        └──────────────┬───────────────┘   (subject to the action gate)
                        │
                        ▼
              ┌───────────────────────┐
              │   bob worklog (CLI)   │   argument parsing, validation,
              │                       │   human text or --json output
              └───────────┬───────────┘
                           │
                           ▼
              ┌───────────────────────┐
              │  Reconciliation step  │   runs first, unconditionally:
              │ (presence-tested,     │   per item, iff today's file holds no
              │  idempotent)          │   entry for it yet AND the nearest
              │                       │   prior existing file shows it open
              └───────────┬───────────┘
                           │
                           ▼
              ┌───────────────────────┐
              │   Entry file store    │   parse/write <cwd>/worklog/
              │                       │   <date>.md — THE source of truth
              └───────────────────────┘

        (no admin socket, no bob serve, no service state,
         no upward directory search — strictly <cwd>/worklog/;
         list fails if worklog/ itself is missing, never invents one)

   Skill delivery (existing mechanisms, unchanged):

     canonical skills/worklog ──packaging──►  .pi/skills/worklog ─┐
                                                                    │ installed by
                                                                    │ bob init at the
                                                                    │ shared path
                                                                    v
                                                 bob extension answers
                                                 resources_discover with
                                                 that path (ADR-014)
                                                                    │
                                                                    v
                                                 every session bob spawns
```

### Responsibility Separation

| Component | Responsibility | Notes |
|---|---|---|
| `bob worklog` subcommands | Parse arguments, reject invalid input before touching the filesystem, render human-readable or JSON output | Consumes the reconciliation step and the entry file store; exposes the `append` and `list` CLI surface |
| Reconciliation step | Carry forward, into today's file, exactly one entry per item-identifier that is open per the nearest prior *existing* worklog file and absent from today's file | Runs unconditionally at the start of both `append` and `list`; presence-tested per item so repeat runs are idempotent; not independently callable; also reports today's full carried-forward set on every call (see Contract) |
| Entry file store | Read and write `<cwd>/worklog/<date>.md`; own the entry format (the Contract below); supply the real `HH:MM`/`YYYY-MM-DD` values | Owns the file format; strictly scoped to the invoking working directory; never creates `worklog/` itself on a read |
| Canonical `worklog` skill, updated | State when and how a session uses `bob worklog`; teach the item-identifier convention | Content lives once in the vendor-neutral skill source (`S-011`); defers to the command for the format, the same way `tasks` already defers to `bob task` |
| Existing packaging target | Deliver the updated canonical skill | No new packaging mechanism |
| Action-authorization gate (existing) | Gate every `bash` invocation of `bob worklog` | Unmodified; admitting rules are an operator deployment concern (`S-004`) |

**Approved-spec and accepted-ADR amendments this specification forces on
approval** (applied at Gate 1, not deferred):

- `S-011`'s `worklog` skill row and Component 4 currently state the skill
  itself "owns the entire diary discipline: …entry format, creation,
  first-run detection, reconciliation…" — after this spec that ownership
  moves to the command, and the skill defers to it, exactly as `S-011`
  already describes `tasks` deferring to `bob task`. `S-011`'s "Action rules
  admitting skill tool calls" section describes worklog rules in terms of
  "directory checks, reads, and appends" and an accepted risk that the rule
  "must be broad enough to cover arbitrary working directories" — after this
  spec the working directory never appears in the command text at all, so
  that accepted risk is retired for worklog writes specifically (see
  Configuration Requirements below), not merely restated.
- `S-002`'s enumeration of `bob init` as *the* filesystem-only subcommand
  needing nothing from the service is stale since `bob task` and becomes a
  third stale instance with `bob worklog`; `S-002` gains an amendment
  generalizing the claim in `ADR-007`'s already-amended terms (a subcommand
  needing the service uses `admin.sock` and only `admin.sock`; one needing
  nothing from the service uses nothing).
- `ADR-014`'s Alternative C records, as a consequence of the always-active
  skill set, that "the rule admitting those writes must be correspondingly
  broad". That clause described the worklog's raw-shell append; after this
  spec it is no longer true for worklog writes specifically (same retirement
  as above), though the surrounding observation — an always-active skill set
  means an interactive session journals wherever it was invoked — remains
  the accurate reason the two-set alternative was rejected.
- `S-010`'s Workflow (the "is this the day's first executed run?" branch),
  Component 4's Interfaces, the Daily-worklog Responsibility row, and the
  "How an open item closes" paragraph all describe `email-triage` itself
  performing first-run detection and a backward file walk. After this spec
  the command performs reconciliation automatically on every call and
  reports today's carried-forward set in its response (see Contract below);
  the skill no longer decides "is this my first run" or walks files itself.
  `S-010`'s Design Principle "the design must reconcile against the most
  recent worklog **containing open items**, not assume 'yesterday'" and its
  Workflow diagram's matching comment use the same "containing open items"
  phrase this spec's Design Principles correct (a whole-file filter that can
  wrongly skip a day that closed every item it mentions); both are amended
  to "the most recent worklog **that exists**" to match.

## Components

### Component 1: Reconciliation step

**Purpose:** Carry forward, into today's file, exactly one entry per
item-identifier that the nearest prior *existing* worklog file shows open
and that today's file does not yet have; report today's full carried-forward
set to the caller.
**Estimated size:** Medium — the core logic fixing #62; a presence-tested
pass per item over the nearest prior existing file.
**Interfaces:** Exposes an "ensure reconciled, then report today's
carried-forward set" operation invoked internally by `append` and `list`;
consumes the entry file store.

### Component 2: Entry file store

**Purpose:** Own the on-disk entry format — creating the day's directory
and file if missing on a write, refusing to invent `worklog/` on a read,
appending a new entry, and reading back a day's entries.
**Estimated size:** Small–medium — largely a direct port of the existing
entry-format contract into code.
**Interfaces:** Exposes entry creation and entry listing; consumes a
resolved `<cwd>/worklog/` path and the real time/date source.

### Component 3: `bob worklog` CLI subcommands

**Purpose:** Provide `append` and `list` with named-flag arguments, local
validation, and the CLI's existing text/JSON output convention.
**Estimated size:** Small — thin argument parsing and dispatch over
Components 1 and 2, mirroring `bob task`'s CLI layer.
**Interfaces:** Exposes the CLI surface described under Configuration
Requirements; consumes the reconciliation step and entry file store.

### Component 4: Canonical `worklog` skill, updated

**Purpose:** Replace the raw shell append/reconciliation prose with
instructions to call `bob worklog append`/`list`, retaining the
item-identifier and per-item conventions the skill already teaches.
**Estimated size:** Small — a rewrite of `references/entry-format.md` and
`references/reconciliation.md`, not new content.
**Interfaces:** Exposes updated skill content through the existing
vendor-neutral packaging pipeline; consumed unchanged by the existing
packaging target.

### Component 5: Operator-facing documentation updates

**Purpose:** Bring every hand-written account of the CLI and of the
worklog's action rules back in line with what the binary now does, by name —
this is exactly the class of gap that produced `B-044` (the CLI-reference
preprocessor's hardcoded subcommand list omitted `bob task`) and its
companion `B-042` (the `bob-companion` plugin's CLI reference had the same
omission); this spec must not repeat it.
**Estimated size:** Small.
**Interfaces:** Consumes the command's behaviour; changes the CLI-reference
preprocessor's subcommand list, the `bob-companion` plugin's `bob-cli` and
`bob-setup` skills, and the shipped mdBook operator guide's live-validated
worklog action-rule set and prose (`the-intern/docs/src/operator-guide/
index.md` — the eight worklog-specific `[[policy.action_rules]]` entries and
the surrounding "now live-validated" prose, plus the `bob task` section's
cross-reference to "the same guidance already given for the `worklog`
skill's writes") — no new skill or documentation surface.

## Workflow

Writing an entry, end to end:

```
Session invokes bob worklog append --item ... --done ... --left ... --next ...
  ↓
Arguments validated locally (all four fields present and non-empty)
  ↓
Reconciliation step runs unconditionally
  → find the nearest prior worklog file that exists (regardless of whether
    it currently shows anything open)
  → for each item-identifier that file's own last entry shows open:
    today's file already has an entry for it → skip; otherwise → carry it
    forward
  ↓
worklog/ and today's file created if missing
  ↓
New entry appended with a real HH:MM from the command's own time lookup
  ↓
Result reported as human-readable text, or JSON when requested —
  including today's full carried-forward item-identifier set, regardless of
  which invocation actually performed the carry-forward write
```

Reading a day, end to end:

```
Session or operator invokes bob worklog list [--date ...]
  ↓
worklog/ itself missing → fail, naming the directory searched for
  ↓
Reconciliation step runs unconditionally for today's file
  (a --date in the past is read as-is, never reconciled retroactively)
  ↓
Entries read back and sorted by HH:MM (ties broken by file order), not raw
file position
  ↓
Result reported as human-readable text, or JSON when requested —
  including today's full carried-forward item-identifier set, regardless of
  which invocation actually performed the carry-forward write
```

Reaching a session, and keeping the skill accurate:

```
Canonical worklog skill rewritten once in the vendor-neutral source
  ↓
The existing packaging script regenerates the pi target
  ↓
bob installs the package at the shared install path (S-011 / ADR-014)
  ↓
Every session bob spawns carries the updated skill, whatever its cwd
  ↓
An operator running the CR-007 bootstrap profile (a no-matcher bash rule)
needs no migration at all — it already admits bob worklog's invocations.
★ An operator who has already narrowed past bootstrap removes the eight
  worklog-specific rules the operator guide documents (the reference-content
  reads and the raw-shell append/check rules) and adds one new rule matching
  bob worklog's invocation text, since none of the old rules match this
  command's invocation text.
```

## Configuration Requirements

### Worklog location

- **What must exist:** nothing — a deliberate absence. `append` and `list`
  always resolve to exactly `<cwd>/worklog/<date>.md` relative to the
  invoking process's working directory. No explicit override (flag,
  environment variable, or config key) exists in this version: the human
  confirmed during brainstorming that cwd-strict resolution with no
  exception was the intended shape, and no operator-convenience override
  was raised as a requirement.
- **Why:** `S-011` (§"Skill-local configuration and worklog storage") and
  `ADR-014` §5 both require worklog continuity to remain relative to the
  session's own working directory; this spec's own choice not to add any
  search or override keeps that property absolute rather than
  best-effort.
- **Where it lives:** not applicable — no flag, environment variable, or
  config-file key names an alternate location.
- **Constraints:** not applicable.
- **Missing-value behaviour:** not applicable — there is no missing-value
  case, since the location is never optional input.

### `bob init` is not a precondition

`bob worklog` must work in a directory `bob init` never touched, the same
guarantee `S-014` states for `bob task`. `S-012` already creates
`<workspace>/worklog/` as part of workspace scaffolding, but that is a
convenience, not a dependency: `append` creates `worklog/` itself if it is
missing, in any directory.

### Entry format and reconciliation (**Contract**)

These are the fixed properties every worklog entry and every reconciliation
pass has. They are the contract between the command and anything that reads
a worklog, including a human, `email-triage`, or any future consuming
skill; the command is what enforces them.

- **Entry shape** is unchanged from today's format: a header line `##
  <HH:MM> — <item-identifier>`, a blank line, then `- Done: …`, `- Left: …`,
  `- Next: …` bullets, each exactly as `worklog/references/entry-format.md`
  already documents.
- **An item is still open** if and only if its most recent entry's `Left`
  field is not equivalent to `nothing`. This sentinel is this
  specification's own definition — inherited from the shipped
  `entry-format.md`'s existing prose, not stated as a literal comparison
  rule anywhere today — made precise here because the command must execute
  it exactly: `Left` is compared to `nothing` case-insensitively, after
  trimming surrounding whitespace and at most one trailing period, so
  entries already on disk written as `nothing`, `Nothing`, or `Nothing.`
  under today's non-normative prose all classify as closed. `S-010`
  separately requires that open-ness live in the worklog rather than in
  mailbox flag state; this sentinel is how the worklog itself expresses
  that, not a rule `S-010` states directly.
- **A carried-forward entry** copies its source entry's `Left` and `Next`
  fields verbatim — the command has no domain policy to re-author `Next`
  the way a skill previously could by hand — with a `Done` field stating
  that the item was carried forward and naming the source file. When the
  source file holds more than one entry for the same item-identifier, the
  chronologically last one is the source.
- **A caller must be able to learn today's full carried-forward set,
  regardless of which invocation actually performed the carry-forward
  write.** Because reconciliation is presence-tested (Design Principles),
  only the invocation that finds an item's entry still absent actually
  writes it; every other invocation that same day is a no-op for that item.
  If `append`/`list` reported only what *that call* wrote, a caller that is
  not the first to touch the file that day would see an empty set even
  though the item is sitting in today's file, carried forward earlier by
  someone else — an operator's `bob worklog list`, or an interactive `bob
  chat` session sharing the same cwd (a real scenario `ADR-014`'s
  Alternative C records, not a hypothetical). So both `append` and `list`,
  in text and JSON output, report every item-identifier whose most recent
  entry in **today's file** is both a carried-forward entry (identifiable by
  construction: its `Done` field states it was carried forward) and still
  open per the open test above — so an item closed later the same day drops
  out of the reported set once its closing entry is written, and the report
  reflects today's current state regardless of whether this call's own
  reconciliation pass wrote the carry-forward entry or found it already
  present. This is
  required because `S-011` (`email-triage` "retains retry of a
  carried-forward blocked action") and `S-010` (reconciling "against it,
  including any pending manager escalation") both depend on a consuming
  skill discovering today's carried-forward items on whichever call it
  happens to make first each day, not only on a call that coincides with
  the moment reconciliation actually wrote them.

### Action rules admitting worklog tool calls

- **What must exist:** for a deployment still running the `bob init`
  CR-007 bootstrap profile (a no-matcher `bash` rule), nothing — it already
  admits `bob worklog`'s invocations, exactly as it already admits `bob
  task`'s (S-014). For a deployment that has narrowed past bootstrap, one
  operator-authored rule admitting `bash` calls whose `command` field
  matches `bob worklog append`/`bob worklog list`.
- **Why:** without an admitting rule on a narrowed deployment the skill is
  present and inert — a silent failure, not a visible one, exactly as
  `S-011` and `S-014` both already require for their own commands.
- **Where it lives:** the existing action ruleset (`S-004`), as ordinary
  operator configuration.
- **Constraints:** `S-004`'s rule model matches a `bash` call's `command`
  field against a glob — it has no per-flag-value matcher, so
  `--item`/`--done`/`--left`/`--next` values are not separately
  expressible; the admitting rule is a single matcher on `command`,
  prefix-anchored on `bob worklog append` or `bob worklog list` with a
  wildcard tail, which is stable regardless of the free-text argument
  values or how they are quoted (the same shape reasoning that makes `bob
  task`'s rule stable, and the reason `B-037`'s literal-substring fragility
  — a doubly-wildcarded `*>> worklog/*.md*` pattern broken by a single
  quote character — does not recur here: the matched prefix contains no
  caller-supplied text). This spec **retires**, for worklog writes, `S-011`'s
  accepted risk that the admitting rule "must be broad enough to cover
  arbitrary working directories" — the working directory never appears in
  the command text at all under this design, which is a genuine narrowing
  this spec delivers, not a restatement of that risk.
- **Missing-value behaviour:** absent rules deny, as the action model
  already requires; a denied call is recorded and never worked around. Only
  a narrowed (post-bootstrap) deployment needs a new rule; the bootstrap
  profile needs none.

### Output form

- **What must exist:** machine-readable output, since an agent is a
  first-class caller of this command.
- **Where it lives:** the existing global JSON flag on the CLI, consistent
  with `bob task`.
- **Constraints:** the JSON form carries the same facts as the text form
  for the same invocation, including the carried-forward item-identifiers
  the Contract above requires.
- **Missing-value behaviour:** human-readable text.

### Filesystem protection

- **What must exist:** owner-only protection on the `worklog/` directory
  and every file it creates, since worklog content is trusted context
  sessions read under `ADR-012` §7's trust-relaxation rationale (the
  working directory is a trusted, un-checked input; operators MUST keep it
  owner-only).
- **Where it lives:** the created directory and files.
- **Constraints:** on Unix platforms, created directories mode `0700`,
  created files mode `0600`.
- **Missing-value behaviour:** the command does not weaken permissions on
  an existing, more permissive `worklog/` directory; a warning is the
  appropriate response, matching `bob task`'s own precedent.

## Implementation Order

| Phase | What | Depends On |
|---|---|---|
| 1 | Entry file store: an entry can be written to and read back from `<cwd>/worklog/<date>.md` per the Contract, with correct permissions and with `list` refusing to invent a missing `worklog/`, and with no reconciliation logic yet. | Nothing |
| 2 | Reconciliation step: presence-tested, idempotent, per-item carry-forward from the nearest prior existing file, reporting today's full carried-forward set regardless of which call wrote it. | Phase 1 |
| 3 | The `bob worklog append` and `bob worklog list` CLI surface, with text and JSON output (including carried-forward reporting) and local validation of invalid input. | Phases 1, 2 |
| 4 | The canonical `worklog` skill rewritten to call the command instead of prescribing the raw shell recipe; delivered to the pi package by the existing packaging script. | Phase 3 |
| 5 | Operator-facing documentation updated: the CLI-reference preprocessor's subcommand list, the `bob-companion` plugin's `bob-cli`/`bob-setup` skills, and the action-rule migration note for narrowed deployments; #62 and #63 closed, referencing this work. | Phase 3; the documentation half also depends on Phase 4 |

## Amendment Log

<!-- Optional. Use when an approved spec is amended after tasks are in flight.
| Date | What changed | Why | Affected tasks |
|------|-------------|-----|----------------|
| YYYY-MM-DD | Description of change | Reason for amendment | T-XXX, T-YYY |
-->
