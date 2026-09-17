---
id: CR-013
title: remove the bob worklog reconciliation and cross-day carry-forward
status: applied
created: '2026-09-17'
---

# remove the bob worklog reconciliation and cross-day carry-forward

## Desired Changes

`bob worklog append` and `bob worklog list` stop performing any cross-day
reconciliation. Concretely:

- `append` writes exactly the entry it was given (`--item`/`--done`/`--left`/
  `--next`), stamped with the current time, into `<cwd>/worklog/<today>.md`.
  Nothing else is read or written.
- `list` reads back exactly the entries physically present in the requested
  day's file (today's by default, or a prior day via `--date <date>`), sorted
  by each entry's own `HH:MM`. Nothing else is read or written.
- Neither subcommand inspects, reads, or copies entries from any other day's
  file. No entry is ever written to today's file that was not explicitly
  appended today by a caller.
- Neither subcommand computes or reports a "carried-forward set." That
  concept is removed entirely, since nothing is ever carried forward.
- **New: same-day exact-duplicate suppression, scoped to today's own file
  only.** If `append` is called for an item-identifier whose most recent
  entry already in today's file has identical `Done`, `Left`, and `Next`
  values to the entry being appended, it does not write a second, redundant
  entry — the existing one already reflects that state. This is a same-day,
  exact-match check only; it never reads any other day's file, and it never
  suppresses an entry that carries real new information (a different
  `Done`, `Left`, or `Next` for the same item, even later the same day, is
  written as its own entry). This behavior does not exist today — see
  Context below — and is introduced by this change-request alongside the
  removal of cross-day carry-forward.

So this request does two things to reconciliation, not one: it removes the
cross-day part entirely (carry-forward, and everything built to support it),
and it adds a same-day part that did not exist before (exact-duplicate
suppression within one file).

What stays unchanged: the entry format (header line plus `Done`/`Left`/`Next`
bullets), cwd-strict resolution with no upward search or override
(`ADR-015`, untouched by this request), `list` refusing to invent a missing
`worklog/`, `append` creating `worklog/` and today's file when missing,
sorting a day's presented entries by timestamp rather than file position,
the text/JSON output forms, and the created-file/directory permissions.

`bob worklog list --date <YYYY-MM-DD>` already reads a prior day's file
as-is with no reconciliation performed against it (S-015's own Workflow
already states "a `--date` in the past is read as-is, never reconciled
retroactively") — this request does not add a new capability for reading
prior days, it removes the automatic *writing* behavior that currently runs
before it on every call. This becomes the sanctioned way for a consuming
agent or skill to look at a previous day's worklog itself, when it decides
it needs to.

Whether a domain item is still "open" across days, and what if anything to
do about that, stops being a `bob worklog` concern altogether. That
responsibility moves entirely to whatever agent or skill calls the command;
`bob worklog` itself only ever records and reads back what actually
happened on a given day.

**`email-triage`'s own continuity mechanism changes as a direct
consequence.** Today `S-010` relies entirely on `bob worklog`'s cross-day
reconciliation to retry an escalation awaiting a manager's reply or an
action blocked by the S-004 action-authorization gate. Once that
reconciliation is removed, `email-triage` is updated so that any item it
cannot fully resolve this run — an escalation just sent, or a blocked
action — is filed as a `bob task` (`S-014`, status `blocked` or `todo` as
appropriate) instead of being tracked as an open worklog item. The worklog
keeps doing only what this request says it should: recording what the run
did, including "filed task `<id>` for this escalation." The task board
becomes the sole record of what is still outstanding and why. A later run
discovers what needs retrying by listing its own filed tasks (`bob task
list`), not by reading any prior day's worklog file. When the underlying
condition resolves — the manager's reply arrives and the run acts on it, or
the S-004 block is lifted and the retried action succeeds — that run closes
the task (`bob task status <id> done`) and records the outcome in that
day's worklog entry for the item.

## Context

The worklog is meant to be a record of the work actually done on a given
day — not a rolling tracker of pending or blocked items across days.
`S-015` built the opposite: it made `bob worklog` the sole durable state
store for "is this item still open," and its reconciliation step
(Component 1) runs unconditionally on every `append`/`list` call, silently
writing copies of a prior day's still-open items into today's file so a
consuming skill never has to look at yesterday's file itself
(`reconcile.rs`'s `carry_forward_open_items`).

The practical effect: a day's file can contain entries nobody wrote that
day, present only because the command decided an item was still open. That
mixes two things that should stay separate — a log of what happened today,
and the separate question of what is still outstanding from before — inside
one automatically-mutated file.

`S-015`'s own Purpose section frames this as fixing two bugs from the prior
hand-run-prose mechanism: #62 (a still-open item accumulated a duplicate
copy every day it stayed open) and #63 (the file is append-ordered, not
time-ordered, under concurrent runs). Removing reconciliation entirely makes
#62 moot by construction — nothing is ever carried forward, so nothing can
duplicate. #63 is unrelated to carry-forward and stays fixed independently
by the unchanged principle that a day's presented entries sort by their own
timestamp rather than physical file position.

The replacement for cross-day continuity, per direction from the human: the
calling agent inspects previous days' worklog files itself, if and when it
needs to know what was left outstanding — it is not something `bob worklog`
does automatically on the agent's behalf.

Separately, the human wants one thing kept alongside this removal: a
same-day exact-duplicate entry should not be written twice. This does **not**
exist in today's implementation — `reconcile.rs`/`store.rs` today have no
same-day dedup logic at all; every `append` call unconditionally writes a
new block, and the only "duplicate" concept anywhere in `S-015` is the
cross-day carried-forward-entry race named in its Exclusions, which is
removed along with the rest of carry-forward. So same-day duplicate
suppression is new behavior introduced by this change-request, not an
existing part of reconciliation being preserved unchanged — it just happens
to replace the reconciliation step's one retained responsibility once the
cross-day part is stripped out.

This also resolves the open question the Architecture Consistency Review
raised against the first draft of this request: rather than either (a)
`email-triage` regaining its own backward worklog-file walk, or (b) silently
losing the continuity guarantee `S-010` currently states, escalation/blocked
-item continuity moves to the task board (`S-014`) instead. This is
consistent with, not a reversal of, `S-014`'s Exclusion "Changes to the
shipped worklog skill" — that exclusion rejected building carry-forward
semantics *into the board mechanism itself* as a generic feature ("moving
the worklog's carry-forward... onto the board"), and explicitly kept both
tools independent so "a run may use either, both, or neither." A single
consuming skill (`email-triage`) choosing to call `bob task` instead of
relying on worklog carry-forward for its own open items is exactly that
freedom being exercised, not a contradiction of it — `bob task` and
`bob worklog` both stay exactly as independent as `S-014` requires; only
`email-triage`'s own choice of which one to lean on for which purpose
changes.

## Potential Impact

- **`S-015` is affected extensively.** Component 1 ("Reconciliation step")
  is replaced by a much narrower same-day-only duplicate-suppression check:
  removed are the "Carrying a still-open item forward must be idempotent…"
  and "Ensuring the day is reconciled must never be a step a caller can
  skip" Design Principles (the second may be partly retained, reworded for
  duplicate suppression instead of carry-forward), the System Diagram's
  reconciliation box (replaced by a same-day dedup box with no cross-day
  arrow), the Responsibility Separation row for the reconciliation step
  (reworded), most of the "Entry format and reconciliation" Contract (the
  "item is still open" test, the "carried-forward entry copies its source
  entry's `Left`/`Next`" rule, and the "caller must be able to learn today's
  full carried-forward set" requirement all go; a new clause defining
  exact-match same-day duplicate suppression is added), the cross-day
  reconciliation steps in both Workflow sections (replaced with a same-day
  dedup check), and the cross-day-specific parts of Phase 2 of the
  Implementation Order. The spec's own title ("…and automatic first-run
  reconciliation") stops being accurate and needs retitling — `[TODO:
  Architect/Planner to propose, e.g. "append, list, and same-day duplicate
  suppression".]`
- **`S-010` is affected extensively, resolved direction: pending/blocked
  continuity moves to `bob task`.** `S-010`'s Design Principle "Continuity
  across independent firings must be reconstructable... the design must
  reconcile against the most recent worklog that exists" needs to become "...
  reconcile against the task board", not simply be deleted. Component 4
  ("Daily worklog")'s Purpose currently calls the worklog "the sole record of
  anything left open by an escalation or an S-004 block" — that sentence
  moves to a (new or extended) task-board component. The Workflow's
  `bob worklog list` step, its "response names today's full carried-forward
  item-identifier set" line, and the "How an open item closes" paragraph are
  all rewritten around `bob task list`/`bob task status` instead of the
  worklog. Implementation Order Phase 4's acceptance criterion "the next
  executed run picks up prior open items" is kept as a requirement but now
  means "...picks them up from the task board." None of this is optional
  documentation cleanup — it is `S-010` gaining a real new dependency on
  `S-014` it does not have today.
- **`S-011` needs matching amendment.** The Responsibility Separation row for
  `email-triage` ("Delegates all diary mechanics to `worklog`; retains retry
  of a carried-forward blocked action") and Component 5's Interfaces
  ("Consumes the `worklog` skill's discipline, the `himalaya` skill's CLI
  knowledge...") both need to add the `tasks` skill as something
  `email-triage` now consumes, and drop the carried-forward-specific
  language. The Workflow's closing line, "A later session reconciles
  carried-forward open items from that same directory," is rewritten around
  discovering open tasks instead.
- **`S-014` is NOT contradicted — see Context above.** Its Exclusion
  rejected a generic board/worklog merge, not a consuming skill's own choice
  to use `bob task` for its open items. No amendment needed to `S-014`
  itself on this point.
- **New risk, not present in the original draft of this request: `bob
  task`'s board resolver walks upward from the working directory (`S-014`
  Design Principles: "resolution walks upward... so a job running in a
  subdirectory of a workspace attaches to that workspace's board"), unlike
  `bob worklog`'s strict no-upward-search resolution (`ADR-015`), which
  exists specifically because an upward search "lets an invocation in a
  subdirectory silently adopt a diary that is not its own." The same hazard
  now applies to `email-triage`'s task filing: two scheduled jobs whose
  working directories share an ancestor could converge on one task board
  instead of each getting its own, unless `email-triage` always resolves its
  board explicitly rather than relying on the upward search. `[TODO:
  Architect/Planner to decide the mitigation — e.g. `email-triage` always
  passes `bob task`'s explicit board flag/environment-variable override
  scoped to its own working directory, rather than depending on upward
  search, or this is accepted as low-risk because `bob init` (S-012)
  already scaffolds a `tasks/` directory at each job's own workspace root,
  so the resolver finds it there before walking further in a normal
  deployment.]`
- **`ADR-015` is NOT affected.** It governs *where the worklog* resolves to
  (cwd-strict, no upward search, no override) — orthogonal to reconciliation
  and untouched by this request. (`ADR-015` says nothing about `bob task`'s
  own, pre-existing and unchanged, upward-search resolver — see the new risk
  above.)
- **`ADR-014` is NOT affected.** Confirmed during Architecture Consistency
  Review: its continuity claim (§5) is about location, not an automatic
  reconciliation mechanism, and its action-rule-breadth amendment depends
  only on the command's invocation text never carrying the working
  directory — unchanged by this request either for `bob worklog` or for
  `email-triage`'s new `bob task` calls (`bob task`'s own admitting rule is
  already scoped by `S-014`, independent of this request).
- **The `worklog` skill**
  (`the-intern/bob-skills/skills/worklog/SKILL.md`,
  `references/reconciliation.md`, `references/entry-format.md`) currently
  teaches reconciliation as automatic command behavior and tells a run to
  call `bob worklog list` at the start of a run to receive "today's
  carried-forward set." This needs rewriting; `references/reconciliation.md`
  may no longer be needed in anything like its current form. `[TODO: Planner
  to decide during spec-breakdown whether it is deleted or repurposed to
  describe how a skill inspects prior days on its own initiative.]`
- **`email-triage`'s worklog reference**
  (`the-intern/bob-skills/skills/email-triage/references/worklog.md`) and its
  category reference workflows currently rely on `bob worklog list`'s
  carried-forward reporting to know which blocked or escalated items to
  retry each run. This is rewritten, not merely trimmed: the skill needs new
  content teaching when and how to file a `bob task` for an unresolved item
  (referencing the canonical `tasks` skill for the command's own mechanics,
  the same way it already defers to the `worklog` skill), and the escalation
  and S-004-block category workflows that currently say "record the block as
  an open worklog item" are rewritten to say "file it as a `bob task`." No
  longer flagged as a functional regression — resolved by routing this
  continuity through `bob task` instead, per the human's direction.
- **Rust implementation.** In
  `the-intern/service/crates/bob/src/worklog/reconcile.rs`, the cross-day
  functions (`nearest_prior_existing_date`, `carry_forward_open_items`,
  `report_carried_forward`, and their tests) are deleted; `reconcile_today`
  either goes with them or is repurposed to hold the new same-day
  duplicate-suppression check instead (an implementation choice for the
  Developer). `store.rs`'s `item_open_state` helper is no longer needed —
  exact-match duplicate suppression compares an incoming entry's `Done`,
  `Left`, and `Next` literally against the item's most recent entry already
  in today's file; it does not classify anything as open or closed. `[TODO:
  Developer to confirm the exact module shape during task breakdown.]`
- **Documentation.** The generated CLI reference page
  (`the-intern/docs/book/cli-reference/worklog.html`) regenerates from `bob
  --help`/doc comments at build time and needs no manual edit beyond the
  source doc comments; the operator guide's worklog action-rule listing and
  `bob-skills/README.md` describe today's reconciliation-aware behavior and
  need review for now-stale claims. `[TODO: confirm exact stale passages
  during task breakdown.]`
- **No migration of existing on-disk worklog files.** Carried-forward
  entries already written under the current behavior are historical fact;
  this request does not rewrite or delete them.
- **Test suite.** `reconcile.rs`'s `#[cfg(test)] mod tests` and any
  worklog-related end-to-end coverage (per `CLAUDE.md`'s `Test` section)
  that asserts cross-day carry-forward behavior are removed or rewritten to
  assert its absence. New coverage is needed for same-day duplicate
  suppression, which has no existing tests since the behavior is new:
  at minimum, an exact-repeat `append` for the same item the same day writes
  nothing further, and an `append` with any field changed (even
  `Left`/`Next` unchanged but `Done` different) still writes a new entry.

## Possible Spec Amendments

- **`S-015`** — amend Purpose to drop the cross-day reconciliation framing;
  rewrite Component 1 from "Reconciliation step" to a same-day-only
  duplicate-suppression step scoped strictly to today's file; remove the
  cross-day Design Principles, System Diagram box, Responsibility
  Separation wording, and Contract clauses (open-item test, carried-forward
  entry shape, carried-forward-set reporting requirement), replacing the
  Contract with a new clause defining exact-match same-day duplicate
  suppression (compare incoming `Done`/`Left`/`Next` against the item's most
  recent entry in today's file only; identical on all three → no write);
  remove the cross-day reconciliation steps in both Workflow sections and
  replace with the same-day check; adjust Phase 2 of the Implementation
  Order to the narrower scope; retitle the spec (the current title ends in
  "…and automatic first-run reconciliation").
- **`S-002`** — `none`. The amendment `S-015` forced (generalizing "needs
  nothing from the service" to include `bob worklog`) is independent of
  reconciliation and stays correct regardless of this change.
- **`S-010`** — amend the continuity Design Principle, Component 4
  ("Daily worklog")'s Purpose, the Workflow's reconciliation step and
  carried-forward-set reporting, the "How an open item closes" paragraph, and
  Implementation Order Phase 4's acceptance criterion so each now describes
  discovering and retrying open items via `bob task` (`S-014`) rather than
  via `bob worklog` reconciliation. This is a substantive redesign of how
  `email-triage` tracks outstanding work, not a wording pass — `S-010` gains
  a real dependency on `S-014` it does not have today, and the Architect
  should confirm the board-resolution isolation risk noted in Potential
  Impact is addressed as part of this amendment.
- **`S-011`** — amend the `email-triage` Responsibility Separation row and
  Component 5's Interfaces to name the `tasks` skill as something
  `email-triage` now consumes alongside `worklog`, and rewrite the Workflow's
  closing "reconciles carried-forward open items" line around task
  discovery instead.
- **`S-014`** — `none`. Confirmed during Architecture Consistency Review:
  its Exclusion rejected building carry-forward semantics into the board
  mechanism generically, not a consuming skill choosing to use `bob task`
  for its own open items — this request is the latter, and does not
  contradict the former.
- **`ADR-014`** — `none`; confirmed during Architecture Consistency Review.
- **`ADR-015`** — `none`; its subject (location resolution) is untouched by
  this request.

## Resolution (applied 2026-09-17)

Amendments applied in place to `S-015` (v0.5), `S-010` (v0.3), and `S-011`
(v0.2); each carries an Amendment Log entry naming this change-request.
`S-014`, `ADR-014`, `ADR-015`, and `S-002` were confirmed unaffected and left
untouched. The two decisions this request left open were resolved as follows.

- **Spec retitle (`S-015`).** The title becomes "bob worklog subcommand —
  append, list, and same-day duplicate suppression". The filename keeps its
  original slug so existing references to the file stay valid; the divergence
  between filename and title is recorded in the Amendment Log.
- **Board-resolution isolation (`S-010`).** Resolved as a requirement, not as
  an accepted risk: `email-triage` must name its board explicitly on every
  `bob task` call, at the job's own working directory, rather than relying on
  `S-014`'s upward search. `bob init`'s scaffolding was judged insufficient on
  its own, because it makes isolation an artefact of how the workspace was
  created and degrades quietly for a `--cwd` one level inside a workspace, an
  uninitialized directory, or a removed board. `S-010`'s own principle that
  continuity stay reconstructable from the job's working directory is absolute,
  and the board is now what carries that continuity. This uses `S-014`'s
  existing explicit board selection and adds no new mechanism. The rejected
  alternative is recorded in `S-010`'s Alternatives Considered.

Still open for the task breakdown, as this request already flagged: the fate of
the shipped worklog skill's reconciliation reference content, the `email-triage`
reference and category-workflow rewrites, the Rust module shape, and the exact
stale documentation passages. No implementation file was touched by this pass.
