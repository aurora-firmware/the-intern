---
id: CR-014
title: drop worklog left/next state tracking and require email-triage tasks to 
  carry full message context
status: pending
created: '2026-09-21'
---

# drop worklog left/next state tracking and require email-triage tasks to carry full message context

## Desired Changes

This is a direct follow-on to `CR-013` (`applied` 2026-09-17), which made
`bob task` the sole record of what is still outstanding for `email-triage`
but explicitly kept `bob worklog append`'s `Left`/`Next` fields unchanged as
descriptive text. This request finishes that separation and adds a content
requirement on the task side that CR-013 did not cover.

1. **`bob worklog append`/`list` drop the `Left`/`Next` fields.** An entry
   records only what was done for an item this run — nothing about what
   remains open or what will resolve it. Concretely: the command's flag
   surface narrows from `--item`/`--done`/`--left`/`--next` to `--item`/
   `--done`; the on-disk entry shape narrows from a header line plus three
   bullets (`Done`/`Left`/`Next`) to a header line plus one (`Done`). Naming
   a task filed or closed for this item stays part of `Done` ("escalated;
   filed task T-xxx" / "closed task T-xxx: manager replied, message
   forwarded") — that convention already exists today and does not change,
   it just stops having `Left`/`Next` alongside it. Same-day exact-duplicate
   suppression (added by CR-013) continues to apply, now compared on `Done`
   alone. Everything else CR-013 already settled — cwd-strict resolution,
   no cross-day reconciliation, `list --date` reading a prior day as-is —
   is unaffected by this request.

2. **A `bob task` filed by `email-triage` (`blocked` or `todo`) must carry
   enough for a cold reader in a different session to act on it without
   reopening the mailbox or asking anyone.** Concretely, the task's
   Description must fold in (per `S-014`'s own "fold that information into
   the description, or say explicitly where to find it" doctrine):
   - **A stable identifier for the source message** — the RFC `Message-ID:`
     header value (obtainable via `himalaya message read -H Message-ID
     <id>`), which stays valid even if the message is later moved to
     another folder.
   - **A locatable pointer for re-fetching it operationally** — folder,
     envelope `id` (from `himalaya envelope list -o json`), date, sender,
     and subject. Envelope `id` is only meaningful within its current
     folder, so this is a convenience pointer alongside the `Message-ID`,
     not a replacement for it.
   - **Enough of the message's own content to act on** — sender, subject,
     date, and a body excerpt/summary, at the same bar
     `references/escalation.md` already sets for the escalation email
     itself ("what the message is... enough that the manager can understand
     it without needing to open the mailbox").

   This applies to both task-filing points in the current loop: a `todo`
   task for an escalation awaiting a manager's reply, and a `blocked` task
   for an action the action-authorization gate refused.

3. **The escalation email's own content requirement is reaffirmed, not
   loosened.** `references/escalation.md` already requires "what the
   message is" (sender, subject, a summary or excerpt) in the escalation
   email; this request does not change that text, but the observed gap in
   practice (an escalation email going out without the original body) means
   the wording needs to be made unambiguous enough that a run reliably
   follows it — `[TODO: Architect/Planner to decide whether this needs
   stronger, more literal wording in escalation.md, or whether the gap was
   an execution issue orthogonal to this request's scope.]`

## Context

The worklog is meant to be a record of what a run actually did, not a
second place where an item's open/outstanding state is described in prose.
CR-013 already moved the *authoritative* state (is this item still open) to
`bob task`, but left `Left`/`Next` in the worklog format as free text
describing that same condition ("what remains open," "what will resolve
it" — see `references/entry-format.md`). In practice that still means the
same fact — this escalation is awaiting a reply, this action is still
blocked — gets written in two places on every run: the task board (which
is authoritative) and the worklog entry's `Left`/`Next` bullets (which is
not, and cannot be relied on to stay in sync with it). The worklog should
be narrowed to only ever answer "what happened this run," full stop.

Separately, reviewing the current escalation/task-filing flow against
`GitHub issue #66` surfaced that a filed task today only "names the
message" (per `SKILL.md` step 3 / `references/escalation.md`) rather than
folding in its substance, and the identifier convention it reuses
(`<subject> (from <sender>)`) is not guaranteed unique — two messages can
share subject and sender (a thread, a recurring sender). A task filed today
gives a different agent in a different session no reliable way to find or
reconstruct the original message's content on its own.

## Potential Impact

- **`S-015` is affected extensively.** The Contract's entry format
  (header + `Done`/`Left`/`Next`) narrows to header + `Done`; the
  `append`/`list` flag surface drops `--left`/`--next`; the same-day
  duplicate-suppression check (CR-013) compares on `Done` alone instead of
  all three fields; the text/JSON output shapes for both subcommands change
  accordingly. This is a Rust change in `service/crates/bob/src/worklog/`
  (flag parsing, entry writer, entry reader/parser for `list`), not a
  doc-only change, with matching test updates (`cargo test -p bob`, any
  worklog-related e2e coverage per `CLAUDE.md`'s `Test` section).
  **Breaking format change to on-disk entries already written** under the
  current three-bullet shape. `[TODO: Architect/Planner to decide whether
  `list` must still parse legacy three-bullet entries for backward reads,
  or whether this is a clean cutover with no migration — consistent with
  CR-013's own "No migration of existing on-disk worklog files" precedent,
  which would argue for the same treatment here.]`
- **The `worklog` skill**
  (`the-intern/bob-skills/skills/worklog/SKILL.md`,
  `references/entry-format.md`) needs rewriting to the narrower field
  shape and to drop the "Left"/"Next" description currently in
  `entry-format.md`.
- **`S-010` is affected.** `SKILL.md` step 4 and
  `references/worklog.md` (email-triage's own worklog notes) currently
  describe what to put in `Left`/`Next` for each outcome — this is rewritten
  around the one-field `Done` shape. Separately and additively,
  `SKILL.md` step 3 / `references/escalation.md`'s task-filing instructions
  (both the `todo` and `blocked` paths) gain the new task-content
  requirement from Desired Changes item 2 — likely as an extension of the
  existing "Open items live on the task board" section in
  `references/worklog.md`, or a new subsection in `references/escalation.md`
  next to the existing "If an action is blocked" section. `[TODO:
  Planner to decide exact placement during spec-breakdown.]`
- **`S-011`** — review for any description of the worklog entry shape or
  the task-naming convention that names `Left`/`Next` or the bare
  `<subject> (from <sender>)` identifier as sufficient; amend if so.
  `[TODO: confirm during Architecture Consistency Review.]`
- **`S-014` — likely `none`.** Its general doctrine ("fold information into
  the description, or say explicitly where to find it") already covers
  what this request asks of email-triage's task descriptions; this is a
  consuming skill applying that doctrine concretely, not a change to the
  board mechanism itself — same reasoning CR-013 used to leave `S-014`
  untouched on the adjacent question of who tracks open items.
  `[TODO: Architect to confirm during Architecture Consistency Review.]`
- **`himalaya` skill** — `references/command-reference.md` may need a
  documented example for retrieving `Message-ID` via
  `himalaya message read -H Message-ID <id>`, if one doesn't already exist,
  since `email-triage` now depends on it. `[TODO: confirm during task
  breakdown.]`
- **`ADR-014`, `ADR-015` — likely `none`.** Orthogonal to this request
  (action-rule breadth and worklog location resolution respectively), same
  conclusion CR-013 reached on both. `[TODO: confirm during Architecture
  Consistency Review.]`
- **Documentation.** The generated CLI reference
  (`the-intern/docs/book/cli-reference/worklog.html`) regenerates from
  `bob --help`/doc comments and needs no manual edit beyond source doc
  comments; the operator guide and `bob-skills/README.md` describe today's
  `Left`/`Next`-bearing format and task-naming convention and need review
  for now-stale passages. `[TODO: confirm exact stale passages during task
  breakdown.]`
- **Test suite.** Worklog-format unit/integration tests asserting the
  three-bullet shape need rewriting for the narrower shape; any
  email-triage-side fixtures or tests referencing `Left`/`Next` wording or
  the bare subject/sender task identifier need review.

## Possible Spec Amendments

- **`S-015`** — amend the Contract's entry format (drop `Left`/`Next`);
  amend the same-day duplicate-suppression clause CR-013 introduced to
  compare on `Done` alone; amend `append`/`list`'s documented flag surface
  and output shapes; amend any Workflow steps or examples that show
  `Left`/`Next` values.
- **`S-010`** — amend `SKILL.md` step 4 and `references/worklog.md`'s
  worklog-call guidance to the one-field shape; add the task-content
  requirement (message identity, retrieval pointer, body content) to the
  task-filing instructions in `SKILL.md` step 3 and
  `references/escalation.md`, for both the `todo` and `blocked` paths.
- **`S-011`** — amend only if review under Potential Impact finds it names
  the current `Left`/`Next` shape or the bare subject/sender identifier as
  the full convention; otherwise `none`.
- **`S-014`** — `none` expected; confirm during Architecture Consistency
  Review per the reasoning above.
- **`ADR-014`, `ADR-015`** — `none` expected; confirm during Architecture
  Consistency Review.
