---
title: bob worklog subcommand — append, list, and same-day duplicate
  suppression
version: '0.6'
status: approved  # draft | review | approved | superseded
created: '2026-08-26'
author: planner
id: S-015
---

# bob worklog subcommand — append, list, and same-day duplicate suppression

## Purpose

The `worklog` skill's entry mechanics are entirely prose today: a session
must hand-run an exact shell append, and hand-run a separate cross-day
carry-forward procedure on a day's first run, getting both exactly right
every time. This has already produced two fixed defects on the same
mechanism — `B-039` (no instruction to look up the real time at all) and its
successor GitHub #64 (the fix for `B-039` introduced a hand-transcribed
`<NOW>` placeholder that was itself routinely transcribed wrong) — and two
currently open ones: #62 (the hand-run carry-forward procedure has no dedup
rule, so a still-open item accumulates one extra copy every day it stays
open) and #63 (the file is append-ordered, not time-ordered, under
concurrent scheduled runs, and nothing says so). `bob` already has a working
precedent for replacing exactly this kind of prose-executed-by-an-LLM
mechanism with a real command — `bob task` (S-014) — so this spec applies
the same move to the worklog. When this work is done, a session writes and
reads worklog entries through a `bob worklog` command instead of a raw shell
recipe; a day's file holds exactly what was appended to it that day and
nothing else, because the carry-forward procedure is retired rather than
carried into the command; #62 is closed as moot by construction, since
nothing is ever copied forward and so nothing can accumulate copies; and #63
is closed as fixed by construction, since a day's entries are presented in
their own timestamp order rather than file order. Whether a domain item is
still outstanding across days becomes the calling agent's or skill's
question, answered with whatever record that caller keeps, never something
the worklog command decides on the caller's behalf.

## Exclusions

What this specification explicitly does NOT cover:

- **A standalone `reconcile` or de-duplication subcommand.** Considered
  during brainstorming and explicitly rejected: `append` and `list` are the
  only entry points, and the same-day duplicate check below happens inside
  `append` itself rather than as a step a caller invokes. This was chosen
  specifically to remove "did I remember to run the other command first" as
  a failure mode; a standalone command would reintroduce it as an optional
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
  its own decision, `ADR-015`, accepted at this spec's Gate 1 approval,
  rather than left as an unexplained spec bullet.
- **Keeping the existing raw-shell append/reconciliation prose as a
  documented fallback.** Rejected: the append mechanics are fully replaced
  by the command and the carry-forward procedure is retired outright, so
  neither survives as a second, hand-run description — matching how `bob
  task` (S-014) replaced its own hand-written prototype rather than carrying
  two descriptions of one mechanism that could drift apart.
- **Any command-side notion of whether an item is still open, in either
  direction.** Two shapes were considered and both are rejected: writing
  carried-forward copies of a prior day's still-open items into today's file
  on every call, and computing the same set at `list`-time without writing
  it. Either makes the command the arbiter of a domain question it has no
  policy for, and the first also lets a day's file fill with entries nobody
  wrote that day. Whether something is still outstanding belongs to the
  caller and to whatever record the caller keeps for it — `email-triage`
  keeps that record on its own `bob task` board (`S-010`), not in the
  worklog. A caller that wants to see what a previous day recorded reads
  that day explicitly with `list --date`.
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
  happened, full stop — not what remains open for a given item, which is
  `bob task`'s question alone (`CR-014` retires the `Left`/`Next` fields
  that described it here); anything requiring a second sorting axis is out
  of scope, mirroring `bob task`'s own exclusion of the same idea.
- **File-locking or an atomic-transaction guard against two truly
  simultaneous appends of the same entry.** Following `S-014`'s own
  precedent of excluding locking/merge/sync mechanisms under `ADR-008`'s
  single-operator scope: the same-day duplicate check below reads today's
  file and then writes without holding a lock, so two genuinely simultaneous
  appends of an identical entry can each find no match and each write. The
  exposure is bounded at one redundant entry in that narrow race window
  rather than eliminated, which is still a strict improvement over #62's
  current unbounded growth.
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
  same diary. This is this specification's own decision (see Exclusions;
  recorded as `ADR-015`).
- **A missing `worklog/` directory must never be silently invented by a
  read.** `list` fails, naming the directory it looked for, rather than
  reporting an empty day and concealing a wrong working directory — the same
  guarantee `bob task`'s board resolver gives reads (S-014 Design
  Principles: "reading must never invent one"). `append`, being a write, may
  still create `worklog/` and today's file when neither exists.
- **A day's file must contain only what was appended to it that day.** No
  entry may ever appear in a day's file that a caller did not explicitly
  append on that day, and neither `append` nor `list` may read from, copy
  from, or write to any day's file other than the one the invocation names.
  Whether an item is still outstanding across days is the calling agent's or
  skill's question, answered against whatever record that caller keeps for
  it, and the command takes no part in it.
- **Suppressing a redundant same-day repeat must never be a step a caller
  can skip or forget.** `append` performs the duplicate check below itself,
  on every call, before writing — it is neither an option a caller passes
  nor a separate command a caller can omit. The check is scoped strictly to
  the file being appended to, so it never becomes a reason to open another
  day's file.
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
              │  Same-day duplicate   │   append only, before writing:
              │  check                │   incoming Done identical to this
              │  (today's file only)  │   item's most recent entry already
              │                       │   in today's file → write nothing
              └───────────┬───────────┘
                           │
                           ▼
              ┌───────────────────────┐
              │   Entry file store    │   parse/write <cwd>/worklog/
              │                       │   <date>.md — THE source of truth
              └───────────────────────┘

        (no admin socket, no bob serve, no service state,
         no upward directory search — strictly <cwd>/worklog/;
         list fails if worklog/ itself is missing, never invents one;
         no day's file is ever read or written except the one the
         invocation names — nothing is carried across days)

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
| `bob worklog` subcommands | Parse arguments, reject invalid input before touching the filesystem, render human-readable or JSON output | Consumes the same-day duplicate check and the entry file store; exposes the `append` and `list` CLI surface |
| Same-day duplicate check | Compare an incoming entry's `Done` against that item-identifier's most recent entry already in today's file, and suppress the write when it matches (see Contract) | Runs inside `append` only, before the write; scoped strictly to the file being appended to; never opens another day's file; not independently callable |
| Entry file store | Read and write `<cwd>/worklog/<date>.md`; own the entry format (the Contract below); supply the real `HH:MM`/`YYYY-MM-DD` values | Owns the file format; strictly scoped to the invoking working directory; never creates `worklog/` itself on a read |
| Canonical `worklog` skill, updated | State when and how a session uses `bob worklog`; teach the item-identifier convention | Content lives once in the vendor-neutral skill source (`S-011`); defers to the command for the format, the same way `tasks` already defers to `bob task` |
| Existing packaging target | Deliver the updated canonical skill | No new packaging mechanism |
| Action-authorization gate (existing) | Gate every `bash` invocation of `bob worklog` | Unmodified; admitting rules are an operator deployment concern (`S-004`) |

**Approved-spec and accepted-ADR amendments this specification forces on
approval** (applied at Gate 1, not deferred):

- `S-011`'s `worklog` skill row and Component 4 currently state the skill
  itself "owns the entire diary discipline: …entry format, creation,
  first-run detection, reconciliation…" — after this spec the entry format
  and the same-day duplicate check belong to the command and the skill
  defers to it, exactly as `S-011` already describes `tasks` deferring to
  `bob task`, while first-run detection and cross-day reconciliation stop
  being anyone's responsibility in this mechanism at all (`CR-013`).
  `S-011`'s "Action rules
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
  "How an open item closes" paragraph originally described `email-triage`
  itself performing first-run detection and a backward worklog file walk.
  Neither the skill nor the command does that now: the command never reads a
  day's file other than the one an invocation names (Design Principles
  above), and `S-010` tracks anything left open by an escalation or an
  `S-004` block as an entry on its own `bob task` board (`S-014`) instead of
  as an open worklog item. The division is that the worklog records what a
  run did and the board records what is still outstanding; `S-010`'s
  continuity Design Principle, System Diagram, Workflow, Component 4, and
  "How an open item closes" paragraph are amended to that shape (`CR-013`).
- `S-010`'s Daily-worklog Responsibility row, Component 4 Purpose, and
  Workflow step still describe the entry as recording "what each run did,
  what it left, and what it intends next" — a restatement of the `Left`/
  `Next` fields this spec now retires (below). Those are amended to
  describe only what a run did, naming any task filed or closed, and
  `S-010` separately gains a Design Principle requiring `email-triage`'s
  item-identifier to carry a stable per-message discriminator, so that
  narrowing same-day suppression to `Done` alone cannot collide two
  distinct messages into one entry (`CR-014`).

## Components

### Component 1: Same-day duplicate check

**Purpose:** Before `append` writes, compare the incoming entry's `Done`
against that item-identifier's most recent entry already in today's file,
and suppress the write when it is identical.
**Estimated size:** Small — one comparison against a single already-parsed
file, with no cross-day logic of any kind.
**Interfaces:** Exposes a "would this be a redundant repeat of this item's
last entry today?" decision invoked internally by `append`; consumes the
entry file store for the day being appended to and for no other day.

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
Requirements; consumes the same-day duplicate check and the entry file
store.

### Component 4: Canonical `worklog` skill, updated

**Purpose:** Replace the raw shell append and hand-run carry-forward prose
with instructions to call `bob worklog append`/`list`, retaining the
item-identifier and per-item conventions the skill already teaches, and
state plainly that a day's file holds only what that day's runs appended —
a session that needs to know what an earlier day recorded asks for that day
explicitly, and a session that needs to track something as still outstanding
keeps that record elsewhere.
**Estimated size:** Small — a rewrite of the existing reference content, not
new content; the reference material describing cross-day reconciliation is
either retired with the behaviour it described or repurposed to describe
deliberate prior-day inspection, decided during task breakdown.
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
**Interfaces:** Consumes the command's behaviour. The CLI-reference
preprocessor (`the-intern/docs/preprocessors/cli-reference/src/main.rs`)
derives its subcommand list from `bob --help` at build time and needs no
change — the requirement is only to verify a `bob worklog` page is
generated. The `bob-companion` plugin's `bob-cli` skill (`SKILL.md` body
and frontmatter, and `references/command-reference.md`) gains a `bob
worklog` account; its `bob-setup` skill needs no change (its worklog
mentions are `bob init` scaffolding, still accurate). Both hand-written
worklog action-rule listings — the shipped mdBook operator guide
(`the-intern/docs/src/operator-guide/index.md`) and the `bob-skills`
package `README.md` — are migrated the same way: of the ten worklog-driven
`[[policy.action_rules]]` entries in each (the two install-path
reference-content reads for `worklog/SKILL.md` and `worklog/references/*.md`;
the relative `worklog/*.md` read; six raw-shell `bash` rules for
`find`/`ls`/`test -f`/`cat`/`mkdir -p`/`>>` against `worklog`; and
`date +%H:%M*`), the two install-path reads are **kept** (`S-011` still
requires them for the rewritten skill's own reference reads) and the other
eight are **removed and replaced by one** `bash` rule prefix-anchored on
`bob worklog append`/`bob worklog list`. The prose around each listing is
brought in line: the "now live-validated" narrative, its quotation of
`S-011`'s now-retired arbitrary-cwd rule-breadth clause, the operator
guide's later instruction to keep the removed relative `worklog/*.md`
matcher for cross-day continuity, and the `bob task` section's two stale
claims — its cross-reference to "the same guidance already given for the
`worklog` skill's writes", and its claim that `bob task`, "along with
`init`, [is] the only bob subcommand" needing nothing from the service,
which `bob worklog` also falsifies (the same stale-enumeration class this
spec already forces `S-002` to correct). Historical validation-outcome
records describing what past live runs observed are left as-is. No new
skill or documentation surface, and no change to the packaging mechanism.

## Workflow

Writing an entry, end to end:

```
Session invokes bob worklog append --item ... --done ...
  ↓
Arguments validated locally (both fields present and non-empty; --left/
  --next are rejected as unknown arguments, not silently accepted)
  ↓
worklog/ and today's file created if missing
  ↓
Same-day duplicate check, against today's file and nothing else
  → this item-identifier's most recent entry in today's file has identical
    Done → nothing is written
  → otherwise (no entry for this item today, or Done differs) → a new entry
    is appended with a real HH:MM from the command's own time lookup
  ↓
Result reported as human-readable text, or JSON when requested — stating
  whether the call wrote an entry or suppressed a redundant repeat
```

Reading a day, end to end:

```
Session or operator invokes bob worklog list [--date ...]
  ↓
worklog/ itself missing → fail, naming the directory searched for
  ↓
Exactly one day's file is read — today's by default, or the day a --date
  names — as it physically stands; no other day's file is opened, and
  nothing is written by a read
  ↓
Entries read back and sorted by HH:MM (ties broken by file order), not raw
file position
  ↓
Result reported as human-readable text, or JSON when requested
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
★ An operator who has already narrowed past bootstrap keeps the two
  install-path reference-content read rules (the rewritten skill still needs
  them), removes the other eight worklog-specific rules the operator guide
  documents (the relative worklog/*.md read, the six raw-shell append/check
  rules, and the date +%H:%M lookup rule — obsolete now the command supplies
  its own time), and adds one new rule matching bob worklog's invocation
  text.
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

### Entry format and same-day duplicate suppression (**Contract**)

These are the fixed properties every worklog entry and every `append` call
has. They are the contract between the command and anything that reads
a worklog, including a human, `email-triage`, or any future consuming
skill; the command is what enforces them.

- **Entry shape** narrows to a header line `## <HH:MM> — <item-identifier>`,
  a blank line, then a single `- Done: …` bullet, exactly as
  `worklog/references/entry-format.md` documents once rewritten (`CR-014`
  retires the `Left`/`Next` bullets that described the item's outstanding
  state — that state is `bob task`'s (`S-014`) alone). `append` takes
  `--item` and `--done` only; a call that still passes `--left` or `--next`
  fails with an unknown-argument error rather than accepting and silently
  discarding them, so a caller written against the prior three-field
  surface breaks visibly instead of writing a silently truncated entry.
- **A day's file contains exactly the entries appended to it on that day.**
  No entry is ever written to a day's file that a caller did not explicitly
  append that day, and neither subcommand reads, copies from, or writes to
  any day's file other than the one the invocation names. Reading an earlier
  day is something a caller asks for explicitly with `list --date`, never
  something the command does on a caller's behalf, and such a read is
  reported as it physically stands. Nothing in this command classifies an
  item as open or closed: a consuming skill that needs to know what is still
  outstanding keeps that record itself — `email-triage` keeps it on its own
  `bob task` board (`S-010`).
- **A redundant same-day repeat is suppressed, by exact match, within one
  day's file only.** When `append` is called for an item-identifier that
  already has at least one entry in that day's file, the incoming `Done`
  value is compared against that item-identifier's chronologically last
  entry in that same file. If it matches, no entry is written — the entry
  already present records exactly that state, so a second copy would add
  nothing. If it differs, the entry is written as its own new entry, however
  similar it is to an earlier one and however late in the day it arrives.
  The comparison is against that one most recent entry only — an earlier
  entry the same day that happens to match is not consulted — and it never
  opens another day's file, so an identical entry appended on a later day is
  always written. Matching is literal on the field value as the command
  would write it, after the same trimming of surrounding whitespace it
  applies before writing a field, with no case-folding and no other
  normalisation. A caller must be able to tell from the response, in both
  the text and JSON forms, whether the call wrote an entry or suppressed a
  redundant repeat, so that a suppressed write is never indistinguishable
  from a failed one. On a day's file that already holds entries written
  under the prior three-bullet shape (from before this narrowing), the
  comparison reads only that legacy entry's `Done` value — its `Left`/`Next`
  lines are neither read nor written by the command and stay in the file
  exactly as written, readable as plain markdown like any other historical
  text (per the Design Principles above); a legacy entry can therefore
  suppress a new `append` whose `Done` repeats it, bounded to files written
  before this change. No migration of existing on-disk worklog files is
  performed.

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
  `--item`/`--done` values are not separately expressible; the admitting
  rule is a single matcher on `command`,
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
  for the same invocation, including whether an `append` wrote an entry or
  suppressed a redundant repeat, as the Contract above requires.
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
| 1 | Entry file store: an entry can be written to and read back from `<cwd>/worklog/<date>.md` per the Contract, with correct permissions and with `list` refusing to invent a missing `worklog/`, and with no duplicate-suppression logic yet. | Nothing |
| 2 | Same-day duplicate suppression inside `append`: an exact repeat of an item-identifier's most recent entry's `Done` in that day's file writes nothing, a differing `Done` writes a new entry, and no file for another day is opened by either subcommand. | Phase 1 |
| 3 | The `bob worklog append` and `bob worklog list` CLI surface, with text and JSON output (including whether an `append` wrote or suppressed) and local validation of invalid input. | Phases 1, 2 |
| 4 | The canonical `worklog` skill rewritten to call the command instead of prescribing the raw shell recipe; delivered to the pi package by the existing packaging script. | Phase 3 |
| 5 | Operator-facing documentation updated: the `bob-companion` plugin's `bob-cli` skill, a verification that the self-deriving CLI-reference preprocessor emits a `bob worklog` page, and the worklog action-rule migration across both hand-written listings (the operator guide and `bob-skills/README.md`); #62 and #63 closed, referencing this work. | Phase 3; the documentation half also depends on Phase 4 |

## Amendment Log

| Date | What changed | Why | Affected tasks |
|------|-------------|-----|----------------|
| 2026-08-30 | Component 5 corrected in three ways while breaking S-015 into tasks: (a) the CLI-reference preprocessor no longer has a hardcoded subcommand list (removed by `B-044`) — it derives the list from `bob --help`, so the work is to verify a `bob worklog` page is generated, not to edit a list; (b) the `bob-companion` `bob-setup` skill is not an affected surface — its only worklog mentions are `bob init` scaffolding, which S-015 preserves; (c) the worklog action-rule listing is duplicated in `bob-skills/README.md` as well as the operator guide, and the operator guide has a later paragraph telling operators to keep the relative `worklog/*.md` matcher — both are inside Component 5's stated Purpose ("every hand-written account … of the worklog's action rules") and are now named explicitly. No requirement changed; the delivered behaviour is identical. | Found by the Gate 2 spec-breakdown review of the S-015 task plan. | T-197, T-198 |
| 2026-09-17 | Cross-day reconciliation is removed from this specification entirely, and a narrower same-day behaviour replaces it. Gone: the carry-forward idempotency and "ensure the day is reconciled" Design Principles, the reconciliation box in the System Diagram, the reconciliation Responsibility row and Component 1, the cross-day steps in both Workflow blocks, and three Contract clauses (the "an item is still open" test, the carried-forward entry shape, and the carried-forward-set reporting requirement). Added: a Design Principle that a day's file holds only what was appended to it that day, a same-day duplicate check as Component 1, and a Contract clause defining exact-match suppression — an `append` whose `Done`, `Left`, and `Next` all match that item-identifier's most recent entry in the same day's file writes nothing, any differing field writes a new entry, and the caller can tell from the response which happened. The Purpose, Exclusions, forced-amendment notes, Output form, and Phases 1–3 follow. The spec title becomes "…and same-day duplicate suppression"; the filename keeps its original slug so existing references stay valid. | CR-013. A day's worklog is meant to record what that day's runs did, not to be silently mutated into a rolling tracker of what is still outstanding; that question moves to whatever record a consuming skill keeps (`email-triage` keeps it on its own `bob task` board, per the matching S-010 amendment). Same-day duplicate suppression is new behaviour introduced alongside the removal, not a retained part of reconciliation. | Tasks TBD (the S-015 breakdown is revised against this amendment) |
| 2026-09-21 | The entry format narrows further, from three fields (`Done`/`Left`/`Next`) to one (`Done`): the Exclusions clause "answers what happened and what remains open" becomes "answers what happened, full stop"; the Same-day duplicate check's Responsibility row, System Diagram box, and Component 1 Purpose drop `Left`/`Next` from the comparison; both Workflow blocks, the Contract's entry-shape and duplicate-suppression clauses, the action-rule Constraints enumeration, and Implementation Order Phase 2 are updated to match. Two clauses are added to the Contract rather than merely trimmed: `append` still passed `--left`/`--next` fails with an unknown-argument error instead of silently discarding them, and same-day suppression against a day's file holding pre-narrowing three-bullet entries compares only the legacy entry's `Done` — its `Left`/`Next` lines are inert but remain in the file, readable as plain markdown. No migration of existing on-disk worklog files. A forced-amendment note is added recording the matching `S-010` amendment (below). | CR-014, its Architecture Consistency Review (2026-09-21). `Left`/`Next` restated the item's open/outstanding state in prose even though the command never acted on it, which is exactly the ambiguity `CR-013` moved the authoritative version of that state to `bob task` (`S-014`) to remove; keeping a second, non-authoritative description of it in the worklog invited the two to drift. The Architecture Consistency Review found this narrowing would otherwise let two distinct messages sharing a subject and sender collide into one suppressed entry under `email-triage`'s current identifier convention — resolved by the matching `S-010` amendment requiring a stable per-message discriminator in the item-identifier, not by weakening this narrowing. | Tasks TBD (breakdown pending) |
