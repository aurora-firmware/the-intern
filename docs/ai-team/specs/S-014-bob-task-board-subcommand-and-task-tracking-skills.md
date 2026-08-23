---
title: bob task board subcommand and task-tracking skills
version: '0.1'
status: approved  # draft | review | approved | superseded
created: '2026-08-23'
author: planner
id: S-014
---

# bob task board subcommand and task-tracking skills

## Purpose

Nothing in bob records work that outlives a single session. A scheduled job or
chat session that starts something it cannot finish leaves no durable statement
of what is open, what it is waiting on, or what would make it finished: the
worklog skill (S-011) gives a per-day narrative of what each run *did*, which is
a different question from what is *outstanding*. An operator has the same gap
from the other side — no bob surface answers "what is still open, and why did it
stall". This matters now because the gap has already been filled locally by a
workspace-private script and a hand-written Claude skill, which proves the format
works but leaves it outside the product: not installed by bob, not reachable by a
pi session, and not documented for either audience. When this work is done, `bob
task` ships in the binary, a board of markdown task files can be created, listed,
moved, annotated, and read from any working directory with or without a running
service, every session bob spawns carries the skill that teaches the command,
and no hand-written page still describes a CLI or a workspace that no longer
matches the binary. Success is confirmed when a session started in a
directory with no board can file a task, a later session started in a sibling
directory reaches that same board rather than a second one, and every operation
succeeds while `bob serve` is stopped.

## Exclusions

What this specification explicitly does NOT cover:

- **A derived index cache.** The prototype maintains a JSONL index beside the
  task files, reconciled against modification times on every read. Considered
  and rejected: at the size a single operator's board reaches, reading the
  files directly is not a measurable cost, and the cache adds a drift
  reconciliation path and a git merge-conflict surface that buy nothing.
- **A service-side view of the board.** Exposing the board through an admin-RPC
  method was considered and rejected: it would make the board unreadable
  whenever bob is down, which is precisely when an operator most wants to know
  what is outstanding, and the board needs no coordination the filesystem does
  not already provide under ADR-008's single-user local scope.
- **Enforcement of task discipline.** Refusing a move to `blocked` without a
  stated reason, or to `done` with unticked Definition-of-Done items, was
  considered and rejected: a rule that can fail mid-run converts a documentation
  problem into a broken session. The skills state the discipline; the command
  does not enforce it.
- **Changes to the shipped worklog skill.** Moving the worklog's carry-forward
  of still-open items onto the board was considered and rejected. The board and
  the worklog are independent tools: neither requires the other, neither
  requires the other's directory to exist, and a run may use either, both, or
  neither.
- **A dedicated board crate.** Placing the board logic in its own workspace
  crate was considered and rejected on ADR-003's precedent — the feature has a
  single Rust consumer today, and extraction later is mechanical.
- **A normative statement of the file format in skill text.** Skill prose may
  describe the format but must not define it, so no skill can disagree with what
  the command actually writes.
- **A dedicated skill in the bob-companion plugin.** Considered and rejected:
  the board is bob's own working surface, and the command's operating
  instructions belong with the skills bob supplies to every session it spawns.
  A second skill teaching the same command to operator tooling would be a
  second description of one command, free to drift from the first. The
  companion plugin and the shipped manual are instead updated where they
  already enumerate the CLI and the workspace `bob init` produces.
- **`bob init` as a precondition.** `bob task` must work in a directory that
  `bob init` never touched. The scaffolding change (CR-009) is a convenience,
  not a dependency.
- **Task assignment, priority, due dates, dependencies, and ordering.** The
  board answers what is open and how it got there. Anything requiring a second
  axis of sorting is out of scope.
- **Multi-user, shared, or remote boards.** Board access is local filesystem
  access by one operator and the sessions that operator's service spawns, per
  ADR-008. No locking, merge, or synchronisation mechanism is in scope.

## Architecture

### Design Principles

- **Recording work must never depend on the service being up.** Every operation
  must complete successfully with no admin socket present and no `bob serve`
  process running.
- **A session's board must not depend on which subdirectory it runs in.**
  Resolution walks upward from the working directory to the nearest ancestor
  board, so a job running in a subdirectory of a workspace attaches to that
  workspace's board rather than starting a second one.
- **Writing must never be blocked by a missing board; reading must never invent
  one.** Task creation may bring a board into existence at the location it
  resolved. Every other operation must fail on a missing board, naming what it
  searched, rather than reporting an empty board and concealing a wrong working
  directory.
- **The markdown files are the only source of truth.** No state may exist that
  cannot be reconstructed by reading them, so a hand-edited, hand-created, or
  externally merged task file is a first-class input rather than a corruption.
- **The command is the normative definition of the file format.** The format is
  defined by what the command writes and refuses; every other description of it
  is derived and may not contradict it.
- **Validation is limited to what has exactly one correct answer.** Structural
  facts are enforced; anything requiring judgment is documented instead.
- **Board content is trusted pi context.** Task files are read by sessions under
  ADR-012 §7's trust relaxation, so they must carry the same owner-only
  protection S-012 requires of workspace files.
- **The board is work product, not service state.** ADR-009's state bucket holds
  state the service itself owns and rewrites — the audit log, and the schedule
  store ADR-012 deliberately moved there. A task board is authored by an
  operator and by sessions, is meaningful only in the context of the workspace
  it describes, and must stay reviewable and diffable beside that workspace's
  other content, exactly as S-011 requires of the worklog. It therefore lives in
  the working-directory tree and not under any XDG bucket.
- **The command's operating instructions ship with the session.** They belong to
  the skill set bob supplies through its extension, so any session bob spawns
  can use the command regardless of what tooling an operator happens to run.
  Operator tooling records that the command exists; it does not own how to use
  it.
- **Skill content must be intelligible without this repository.** Per S-011, no
  shipped skill may reference this project's specifications, decision records,
  tasks, or bugs.
- **The specification grants no new authority.** Every tool call a skill makes
  to run this command remains subject to the existing action-authorization gate.

### System Diagram

```
   Operator shell            pi session (chat / scheduled)
        │                              │
        │  bob task new|list|          │  bash: bob task …
        │  status|note|show            │  (subject to the action gate)
        └──────────────┬───────────────┘
                       │
                       ▼
              ┌──────────────────┐
              │  bob task (CLI)  │   argument parsing, validation,
              │                  │   human text or --json output
              └────────┬─────────┘
                       │
                       ▼
              ┌──────────────────┐
              │  Board resolver  │   walk up from cwd → nearest tasks/
              │                  │   create on write, owner-only modes
              └────────┬─────────┘
                       │
                       ▼
              ┌──────────────────┐
              │  Task file store │   one markdown file per task
              │   <board>/*.md   │   THE source of truth
              └──────────────────┘

              (no admin socket, no bob serve, no service state)

   Skill delivery (existing mechanisms, unchanged):

     canonical skills/tasks ──packaging──►  .pi/skills/tasks ─┐
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

     bob-companion plugin ──► updated where it already enumerates the CLI
                              and the workspace bob init produces
                              (no new skill)
```

### Responsibility Separation

| Component | Responsibility | Notes |
|---|---|---|
| `bob task` subcommands | Parse arguments, reject invalid input before touching the filesystem, render human-readable or JSON output | Consumes the board resolver and task file store; exposes the CLI surface |
| Board resolver | Locate the board by walking upward from the working directory, honour an explicit override, create the board on a write operation, apply owner-only permissions | Exposes a resolved absolute board path; consumes the working directory, the override flag, and the environment variable |
| Task file store | Read and rewrite task frontmatter, apply the file template, append dated log entries, derive an identifier from title and date, resolve a partial identifier to exactly one task | Owns the file format; consumes a resolved board path |
| Canonical `tasks` skill | State when work belongs on the board, how to describe a task so a cold reader can pick it up, and what each status means | Content lives once in the vendor-neutral skill source (S-011); defers to the command for the format |
| Existing packaging target | Deliver the canonical skill unchanged to the pi package | No new packaging mechanism; the skill list the scripts generate gains one entry. This makes the S-011 package a set of four skills; every S-011 principle, packaging target, and delivery path is unchanged, and its enumeration of the set needs amending on approval of this specification |
| Operator-facing documentation updates | Record that the subcommand exists, what its flags are, and what `bob init` now produces | Edits to the companion plugin's existing `bob-cli` and `bob-setup` skills and to the hand-written manual pages that enumerate the workspace layout; no new skill, and no second account of how to use the board. The manual's CLI reference is derived from `--help` at build time (S-007) and needs no hand-written prose |
| `bob init` scaffolding | Create the board directory in a fresh workspace | Change to approved S-012 behaviour; specified by CR-009 and gated on its approval |

## Components

### Component 1: Board resolver

**Purpose:** Turn a working directory, an optional explicit override, and the
operation's kind (read or write) into one absolute board path, creating the
board only for writes.
**Estimated size:** Small.
**Interfaces:** Exposes board resolution and creation; consumes the process
working directory, the directory override flag, and the directory environment
variable.

### Component 2: Task file store

**Purpose:** Own the on-disk task format — creating a task file from the
template, rewriting a single frontmatter field in place, appending a dated
entry to the log section, deriving identifiers, and resolving a partial
identifier.
**Estimated size:** Medium.
**Interfaces:** Exposes task creation, field update, log append, listing, and
identifier resolution; consumes a resolved board path.

### Component 3: `bob task` CLI subcommands

**Purpose:** Provide `new`, `list`, `status`, `note`, and `show` over the board,
with the same global JSON-output behaviour the rest of the CLI has.
**Estimated size:** Medium.
**Interfaces:** Exposes the CLI surface described under Configuration
Requirements; consumes the board resolver and task file store.

### Component 4: Canonical `tasks` skill

**Purpose:** Teach an agent when work belongs on the board, how to write a task
another run can pick up cold, what each status commits it to, and which
subcommand performs each of those moves.
**Estimated size:** Small.
**Interfaces:** Exposes skill content in the vendor-neutral source tree;
consumed unchanged by the existing packaging target and reaching sessions
through the shared install path the extension answers with.

### Component 5: Operator-facing documentation updates

**Purpose:** Bring every hand-written account of the CLI and of the workspace
`bob init` produces — in the companion plugin and in the shipped manual — back
in line with what the binary now does.
**Estimated size:** Small.
**Interfaces:** Consumes the command's behaviour and CR-009's workspace layout;
changes existing pages and skills rather than adding any.

## Workflow

Filing and advancing a task, from either surface:

```
Operator or pi session invokes bob task
  ↓
Arguments validated locally (status is a known value, title is non-empty)
  ↓
Board resolved: explicit override, else environment variable,
  else nearest ancestor tasks/ from the working directory
  ↓
  ├─ write operation, no board found → board created at the resolved location
  └─ read or move operation, no board found → fail, naming the directories searched
  ↓
Task file created from the template, or its frontmatter rewritten in place
  ↓
A dated entry is appended to the task's log section recording what happened
  ↓
Result reported as human-readable text, or as JSON when requested
```

Reaching a session, and keeping operator tooling accurate:

```
Canonical tasks skill written once in the vendor-neutral source
  ↓
The existing packaging script regenerates the pi target
  ↓
★ Human approves CR-009, so bob init installs the fourth skill tree
  ↓
bob installs the package at the shared install path (S-011 / ADR-014)
  ↓
bob's extension answers resource discovery with that path on every spawn
  ↓
Every session bob spawns carries the skill, whatever its working directory
  ↓
Separately, and adding no skill: every hand-written account of the CLI gains
the subcommand, and every hand-written account of the bob init workspace gains
the board directory and the fourth installed skill tree — the manual's CLI
reference needs no edit, being derived from --help at build time
```

## Configuration Requirements

### Board location

- **What must exist:** a way to point an invocation at a specific board, so a
  session whose working directory is outside any workspace can still reach one.
  This is required because working-directory resolution alone leaves such a
  session with no board.
- **Where it lives:** a command-line flag on the `task` subcommand and an
  environment variable, in that order of precedence, with upward search from
  the working directory as the fallback.
- **Constraints:** a filesystem path; relative input resolves against the
  current working directory to an absolute path before use.
- **Missing-value behaviour:** upward search from the working directory. If that
  finds no board, a write operation creates one and a read or move operation
  fails non-zero, naming the directory it searched upward from.

### No configuration-file key

- **What must exist:** nothing. Board location is deliberately *not* a key in
  bob's configuration file.
- **Why:** a configured default and an upward search are two mechanisms
  resolving the same question, and a stale configured path would silently
  redirect an operator's board. The flag and environment variable already cover
  the case a configured default would serve.
- **Missing-value behaviour:** not applicable.

### Filesystem protection

- **What must exist:** owner-only protection on everything the command creates,
  because task files are trusted context that sessions read.
- **Where it lives:** the created board directory and every task file.
- **Constraints:** on Unix platforms, created directories are mode `0700` and
  created files mode `0600`, matching what S-012 already requires of workspace
  files.
- **Missing-value behaviour:** the command does not weaken permissions on files
  or directories that already exist, and does not fail because an existing board
  is more permissive than it would have created; a warning is the appropriate
  response.

### Action rules admitting board tool calls

- **What must exist:** rules admitting the tool calls the shipped `tasks` skill
  makes — invocations of this command by a session. Without them the skill is
  present and inert, which is a silent failure rather than a visible one.
- **Where it lives:** the existing action ruleset, as ordinary operator
  configuration, exactly as S-011 requires for the worklog's writes and for
  reference reads at the install path.
- **Constraints:** a rule scoped to this command is stable across deployments,
  because the command's name does not vary with the working directory. The
  board path it writes to does vary, for the same reason S-011 accepted for
  worklog writes: a session journals into whatever directory it was started
  from. An operator narrowing the first-run profile must account for that.
- **Missing-value behaviour:** absent rules deny, as the action model already
  requires; a denied call is recorded by the skill and never worked around. The
  CR-007 bootstrap profile `bob init` generates permits `bash` with no matchers,
  so a fresh installation admits these calls without further configuration —
  an operator-usability exception, not the steady state.

### Output form

- **What must exist:** machine-readable output, because an agent is a
  first-class caller of this command.
- **Where it lives:** the existing global JSON flag on the CLI.
- **Constraints:** the JSON form carries the same facts as the text form for the
  same invocation; the text form is not required to match it field-for-field.
- **Missing-value behaviour:** human-readable text.

### Task file format (**Contract**)

These are the fixed properties every task file has. They are the contract
between the command and anything that reads a board; the command is what
enforces them.

- **Identity** is the file name without its extension, and begins with the
  creation date in `YYYY-MM-DD` form followed by a slug derived from the title.
  A partial identifier that matches exactly one task is accepted wherever an
  identifier is; one that matches none or several is an error naming the
  candidates.
- **Frontmatter** carries exactly two queryable fields: the one-line title, and
  the status. Creation date is deliberately absent — it is already the filename
  prefix, and a fact stored twice can contradict itself.
- **Status** is exactly one of `todo`, `doing`, `blocked`, or `done`. Any other
  value is rejected before the filesystem is touched. Completed tasks stay on
  the board rather than moving to an archive, so a task's location never
  changes; listings hide them by default and can be asked for them explicitly.
- **Body sections** are a description of what needs to happen and why, a
  Definition of Done as a checklist of observable conditions, and a log of dated
  entries recording how the task reached its current state. Every status change
  appends a log entry, whether or not the caller supplied a reason.

## Implementation Order

| Phase | What | Depends On |
|---|---|---|
| 1 | Board resolution and the task file store: a task file can be created from the template at a resolved board and read back, with correct permissions | Nothing |
| 2 | The full `bob task` surface — `new`, `list`, `status`, `note`, `show` — with text and JSON output and local validation of invalid input | Phase 1 |
| 3 | The canonical `tasks` skill, delivered to the pi package by the existing packaging script, so a session spawned by bob carries it. The binary embeds the generated pi package wholesale, so this phase also carries every expectation that pins the embedded or installed skill set to three skills | Phase 2 |
| 4 | Every hand-written account of the CLI updated for the new subcommand, and every hand-written account of the `bob init` workspace layout updated for the board directory and the fourth installed skill tree — in the companion plugin and in the shipped manual alike | Phase 2; the layout half also depends on Phase 5 |
| 5 | `bob init` creates the empty board directory in a fresh workspace, installs the fourth skill tree at the shared install path, and guarantees that `--force` never removes or replaces board content | Phase 1 and Phase 3, and CR-009 |

## Amendment Log

| Date | What changed | Why | Affected tasks |
|------|-------------|-----|----------------|
| 2026-08-23 | Phase 3 extended to cover every expectation pinning the embedded or installed skill set to three skills; Phase 5 extended to name the fourth skill tree's installation and the `--force` guarantee, and to depend on Phase 3. | The binary embeds the generated pi package wholesale, so adding a fourth skill breaks the exhaustive embedded-asset and install assertions in the same change rather than later; and CR-009's `--force` guarantee was recorded in the change-request but not in any phase. Found while checking what work CR-009 generates, before breakdown. | None yet (Gate 2 pending). |
| 2026-08-23 | The four places assuming two packaging targets now describe one; the exclusion ruling the package-directory rename out of scope is removed. | CR-011 removes the Claude packaging target, and CR-010 performs the rename the exclusion deferred, so both statements were about to become false. No change to how the `tasks` skill reaches a session. | Tasks TBD |
