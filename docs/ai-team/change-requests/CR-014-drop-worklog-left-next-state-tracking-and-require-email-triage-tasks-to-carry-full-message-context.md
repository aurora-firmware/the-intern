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

## Architecture Consistency Review (2026-09-21)

Reviewed against the full binding set — 14 approved specs (`S-001`–`S-007`,
`S-009`–`S-015`; `S-008` is archived and not binding) and 15 accepted ADRs
(`ADR-001`–`ADR-015`) — not only the artifacts this request names.

**Verdict: consistent in intent, not yet complete as written.** Neither
desired change contradicts an accepted ADR, and item 2 turns out to be
*already binding* rather than new (finding D). Two corrections are required
before the amendments are applied: the enumerated amendment sets for `S-015`
and `S-010` are incomplete (findings A and B), and narrowing the duplicate
check to `Done` alone breaks a guarantee `S-010` states today unless
`email-triage`'s item-identifier convention is fixed in the same pass
(finding C). All corrections are inside the amendments this request already
opens, so no human escalation is required.

### Findings

**A. The `S-015` amendment set is under-enumerated.** Beyond the Contract,
the duplicate-suppression clause, the flag surface, and the output shapes
this request already names, these `S-015` passages also assert the
three-field shape and go stale on application:

- *Exclusions*, "Task assignment, priority, or any second organizing axis" —
  "The worklog answers what happened **and what remains open for a given
  item**". That second clause becomes false; the worklog answers what
  happened, full stop.
- *Responsibility Separation*, the "Same-day duplicate check" row — compares
  "`Done`, `Left`, and `Next` … and suppress the write when all three
  match".
- *System Diagram*, the duplicate-check box — "incoming Done/Left/Next
  identical to …".
- *Component 1* Purpose — "compare the incoming entry's `Done`, `Left`, and
  `Next` … suppress the write when all three are identical".
- *Workflow*, "Writing an entry, end to end" — the `append` invocation line
  showing `--left`/`--next`, the validation line "all four fields present
  and non-empty", and both duplicate-check branches.
- *Implementation Order*, Phase 2 — "any differing `Done`, `Left`, or
  `Next` writes a new entry".
- *Configuration Requirements*, "Action rules admitting worklog tool calls"
  → Constraints — enumerates `--item`/`--done`/`--left`/`--next` as the
  values a rule cannot match on separately. The rule *shape* is unaffected
  (it stays prefix-anchored on `bob worklog append`/`list`), so no operator
  rule migration follows from this request; only the enumeration changes.

One clause must be **added** to the Contract: an `append` still passed
`--left` or `--next` fails with an unknown-argument error rather than
accepting and ignoring them. A caller written against the old surface must
break visibly, on the same reasoning the Contract already applies to
suppression ("a suppressed write is never indistinguishable from a failed
one").

**B. The `S-010` amendment set names skill files, not spec sections.** This
request's "Possible Spec Amendments" entry for `S-010` cites `SKILL.md` step
4 and `references/worklog.md` — both shipped `email-triage` skill files,
which are implementation of `S-010`, not sections of it. `S-010` itself
restates the three-field shape in three places, and each needs amending:

- *Responsibility Separation*, the "Daily worklog" row — "Record of what each
  run actually did, **what it left, and what it intends next**, per calendar
  day".
- *Component 4* Purpose — "recording what each run did, **what it left, and
  what it intends next**".
- *Workflow*, the penultimate step — "Append a worklog entry for the
  message: **what was done / what's left / next**, naming the identifier of
  any task filed for it."

**C. Contradiction — `Done`-only suppression plus a non-unique
item-identifier breaks a guarantee `S-010` states today.** This is the one
real conflict in the request, and it is created by item 1, not carried in
from before.

- `S-010` *Purpose*: "Success is confirmed when a completed run leaves no
  unseen message unclassified … and **a corresponding entry exists in that
  day's worklog for every message processed**."
- `S-010`'s shipped convention (`email-triage/references/worklog.md`, "Item
  identifier"): the item-identifier is the message's `<subject> (from
  <sender>)` — which this request's own Context correctly observes is not
  unique across messages.
- `S-015` Contract, as this request would amend it: an `append` whose `Done`
  matches that item-identifier's most recent entry in today's file writes
  nothing.

Today three fields must all match for a write to be suppressed; after this
request one must. Two distinct messages sharing a subject and sender — a
thread, a recurring automated sender — handled the same way in one run
produce the same identifier *and* the same `Done` ("moved to Archive"), so
the second message gets no worklog entry at all. `S-015` is authoritative on
the command's behaviour, and the suppression narrowing is the point of this
request; the fix therefore belongs on `S-010`'s side of the boundary:
**`email-triage`'s item-identifier must distinguish distinct messages.**
Item 2 already has the run fetch a `Message-ID` for every message it files a
task for; the identifier convention should carry a stable discriminator
derived from that same `Message-ID` alongside the human-readable `<subject>
(from <sender>)` part, for every message, not only escalated ones. Exact
rendering is the Planner's during breakdown; the binding property is that
two distinct messages never share an identifier and one message's identifier
never changes between days.

With that fix, same-day suppression fires for `email-triage` only when the
*same message* is handled twice in one day to the same outcome — which is
precisely what `CR-013` introduced it for.

The domain-free `worklog` skill's identifier convention should state the
same property generically ("distinct items get distinct identifiers"); it
currently requires only stability across recurrences, not distinctness. That
is skill content under `S-015` Component 4, not an `S-011` amendment.

**D. Item 2 is already binding — it is a concretization, not a new
requirement.** `S-010` *Component 5* Purpose already requires the filed task
to hold its record "in terms complete enough for a later run to pick the
item up cold without reading any previous day's worklog", and `S-010`
*Exclusions* rejected `report.submit` specifically because it "cannot hold …
a description of an unfinished item complete enough to retry cold". The gap
observed in practice is therefore shipped-skill content failing an
already-approved requirement (`SKILL.md` step 3 and
`references/escalation.md` say only to "name the message"), not a missing
requirement. Consequence for the breakdown: the `S-010` amendment is narrow
— name the three content elements (message identity, retrieval pointer, body
content) in Component 5 so the bar is auditable at spec level — and the
substantive work is skill-content correction.

**E. Item 2 moves untrusted sender content into two places that need
discipline stated.** Neither is a contradiction; both are silent widenings
that must be written down rather than inherited.

- *Trust.* `S-014` Design Principles: "Board content is trusted pi context.
  Task files are read by sessions under `ADR-012` §7's trust relaxation."
  A body excerpt in a task description means arbitrary-sender text is read
  back as trusted context by every later run that lists the board. The
  exposure already exists for the subject line; item 2 widens it to the
  body. `ADR-012` §7 already accepts this class of exposure and names
  filesystem permissions as the gate, so no new decision is needed — but the
  amendment must require the excerpt to be **quoted and attributed as
  message content, bounded in length, and never authoritative over the
  mailbox** (the `Message-ID` pointer exists so a later run can re-fetch the
  original).
- *Shell safety.* `S-010`'s own established practice (`SKILL.md` step 3, and
  the `himalaya` skill's "Embedding message-derived text safely" section)
  requires message-derived subject and body text to be loaded into shell
  variables rather than typed as literal quoted arguments. A `bob task new`
  invocation carrying a body excerpt is exactly that case and must follow
  the same pattern. The request does not mention it; the amendment must.

**F. Placement constraint (advances, does not close, the `S-010` placement
TODO).** Wherever the Planner puts it, the new content requirement must live
in `email-triage`'s own content. It must not enter the `worklog` or `tasks`
skills: `S-011` Design Principles require the diary mechanism to "carry no
domain knowledge", and both skills are marked domain-free in `S-011`'s
Responsibility Separation. Second constraint: the "what the message is" bar
is now demanded in three places — the escalation email, the `todo` task, and
the `blocked` task. Define it **once** in `email-triage`'s references and
cross-reference it from all three, rather than writing three copies free to
drift apart (the same reasoning `S-014` used to reject a second skill
teaching `bob task`, and `S-015` used to reject keeping the raw-shell append
prose as a fallback). The file it lives in is the Planner's call.

### Resolution of this request's open questions

- **Item 3 — does `references/escalation.md` need stronger wording?** No, and
  no spec amendment. The text already reads "enough of the original message
  (sender, subject, and a summary or the relevant excerpt) that the manager
  can understand it without needing to open the mailbox themselves", and
  `SKILL.md` step 3 independently names the subject and body excerpt as the
  escalation's content. An escalation going out without the body is an
  execution deviation from content that already says what to do, orthogonal
  to this request. One non-normative clarity edit is in scope for the
  breakdown — making the body excerpt a separately-checkable element rather
  than a parenthetical inside a larger bullet — because finding F folds this
  requirement into a shared definition anyway. If the gap recurs after that,
  it is a defect to file against the run, not a third round of wording.
- **Legacy three-bullet entries — backward reads or clean cutover?** Clean
  cutover, no migration, and no legacy-parsing code. `store.rs`'s
  `parse_entries` is already lenient by design ("Lines that are not part of
  an entry are ignored, so an operator's hand-authored notes between entries
  do not break reading") and defaults absent bullets to empty, so an entry
  written under the three-bullet shape still parses for its header and
  `Done` once the narrower struct lands; the `Left`/`Next` lines are ignored
  exactly as an operator's own notes are. The historical text stays in the
  file and stays readable directly, which `S-015` already guarantees ("The
  on-disk file must remain plain, human-readable markdown independent of the
  command"). This matches `CR-013`'s "No migration of existing on-disk
  worklog files" precedent. One consequence to record in the amended
  Contract: on a day's file that already holds three-bullet entries,
  suppression compares `Done` alone against those too, so a legacy entry can
  suppress a new append whose `Done` repeats it — bounded to files written
  before the cutover.
- **`S-011` — amendment needed?** `none`, confirmed. `S-011` names neither
  `Left`/`Next` nor the `<subject> (from <sender>)` identifier anywhere; its
  `worklog` skill row and Component 4 already defer the entry format and the
  duplicate check to the command, and its `email-triage` row already routes
  open-item tracking to `tasks`. Its only live constraint on this request is
  the domain-free rule in finding F.
- **`S-014` — amendment needed?** `none`, confirmed. Item 2 adds no field,
  no status, no format change, and no command-side enforcement — `S-014`
  explicitly leaves task-writing discipline to the skills ("Enforcement of
  task discipline" Exclusion). One citation correction: the "fold that
  information into the description, or say explicitly where to find it"
  wording this request attributes to `S-014` is the shipped `tasks` skill's
  text (`S-014` Component 4's content); `S-014` itself says "how to write a
  task another run can pick up cold". Cite whichever is meant.
- **`ADR-014`, `ADR-015` — affected?** `none`, confirmed. Neither mentions
  the entry's field shape. `ADR-015` governs where the worklog resolves;
  `ADR-014` §5 governs that working-directory-relative state stays
  working-directory-relative; `ADR-014`'s Alternative C amendment turns only
  on the command's invocation text not carrying the working directory, which
  this request does not change. Same conclusion `CR-013` reached, for the
  same reasons.
- **`himalaya` skill — does it need a `Message-ID` example?** The option is
  already documented: `references/command-reference.md`'s "Reading a
  Message" lists `-H, --header <NAME>` among `message read`'s verified
  options. No worked `Message-ID` example exists, and adding one is
  breakdown work inside `S-010` Component 1's existing scope ("every
  himalaya CLI operation the triage workflow needs") — no spec amendment.
  Guidance for the breakdown: have the run obtain the identity headers from
  the read that already classifies the message (`-H From -H Subject -H Date
  -H Message-ID`) rather than issuing a second per-message call, and keep
  `--preview` semantics in mind for any read that must not set `\Seen`.
- **Stale hand-written passages.** Confirmed by search, for the breakdown to
  size against: `bob-skills/skills/worklog/references/entry-format.md` (the
  `append` invocation line and the whole three-bullet section, including the
  `Left` and `Next` field descriptions) and its regenerated `.pi/` mirror;
  `bob-skills/README.md` (the `--item`/`--done`/`--left`/`--next` action-rule
  passage); `bob-companion/claude/skills/bob-cli/references/command-reference.md`
  (the duplicate-check description, the `append` signature, the
  "all four flags … are required" line, and the per-flag descriptions);
  `the-intern/docs/src/operator-guide/index.md` (the free-text flag
  enumeration in the worklog action-rule prose); and `email-triage`'s
  `SKILL.md` steps 1, 3, and 4 plus `references/worklog.md`. The generated
  CLI-reference page needs no manual edit, as this request already states.

### Recommended decision record

The boundary this request completes — the worklog records what happened and
carries no field describing what is outstanding; a consuming skill keeps
that record itself — has now been argued three times (`S-015` Gate 1,
`CR-013`, this request) and constrains every future consuming skill and any
future filesystem-only subcommand. It lives only as prose spread across
`S-015`, `S-010`, and `S-011`. Recommend recording it as an ADR with status
`accepted` **at the point these amendments are applied**, mirroring how
`ADR-015` was accepted at `S-015`'s Gate 1 rather than in advance.

### Routing

- **Planner** — apply findings A, B, C, D, E, and F when amending `S-015`
  and `S-010`; record both amendments in the specs' Amendment Logs naming
  this change-request, and add the Resolution section to this file when they
  land.
- **Architect** — record the recommended ADR when the amendments are
  applied.
- **Human** — nothing required. No finding needs a spec change beyond the
  amendments this request already opens.
