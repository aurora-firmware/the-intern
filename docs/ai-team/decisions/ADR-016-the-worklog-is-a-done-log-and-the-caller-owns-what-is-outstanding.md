---
id: ADR-016
title: the worklog is a done-log and the caller owns what is outstanding
status: accepted
created: '2026-09-21'
---

# ADR-016: the worklog is a done-log and the caller owns what is outstanding

## Context

Where an item's outstanding state lives has now been argued three times, and
each round re-derived the same reasoning from scratch:

- **S-015, Gate 1.** The specification made `bob worklog` the durable store
  for "is this item still open": a reconciliation step ran on every
  `append`/`list` call and copied a prior day's still-open items forward into
  today's file, so a consuming skill never had to look at yesterday's.
- **`CR-013`.** Cross-day carry-forward was removed entirely — a day's file
  holds only what that day's runs appended — and `email-triage`'s continuity
  moved onto its own `bob task` board. But the entry format kept its `Left`
  and `Next` bullets as descriptive prose, so the same fact ("this escalation
  is awaiting a reply") was still written in two places on every run: the
  board, which was authoritative, and the worklog entry, which was not, with
  nothing keeping the two in sync and nothing able to detect the drift.
- **`CR-014`.** Those two fields were removed. An entry now records a header
  line and `Done` — what the run did for that item — and nothing else.

After `CR-014` the rule is stated only as prose spread across three
specifications: `S-015`'s Design Principles, Exclusions, and Contract;
`S-010`'s continuity Design Principle, Component 4, and Component 5; and
`S-011`'s `worklog` skill row. Nothing records it as a decision that a future
consuming skill, or a future filesystem-only subcommand, has to honour.

Forces:

- **A record that answers two questions has no single source of truth for the
  second.** "What happened" and "what is still outstanding" are different
  questions with different lifetimes. Carrying both in one per-day record
  means writing the second one twice — once where it is authoritative and
  once where it is not — which is a drift surface, not redundancy.
- **"Is this still open" is domain policy, and the command has none.** What
  closes an item — a specific reply arriving, a specific block being lifted —
  is knowledge only the consuming skill has. Any field that describes
  outstanding state pulls a domain-flavoured test toward a domain-free
  command; `S-015` rejected exactly that, and the implementation carried an
  `item_open_state` helper for it until `CR-013` removed the need.
- **Narrowing the entry makes the caller's identity discipline
  load-bearing.** Same-day duplicate suppression now compares `Done` alone
  against an item-identifier's most recent entry, so the identifier is the
  only thing separating two distinct items. A caller whose identifiers are
  not distinct per item silently loses entries — a consequence that belongs
  to the mechanism as a whole and has no natural home in either
  specification on its own.
- **`ADR-015`'s precedent applies.** A convention that a future subcommand or
  consuming skill might otherwise assume should be recorded as a decision
  rather than left as an unexplained spec bullet.

## Decision

**The worklog is a record of what a run did. What is still outstanding is
kept by the caller, on the caller's own record, and never in the worklog.**

1. **An entry records work done, and nothing else.** A worklog entry is a
   header line naming the time and the item identifier, plus what was done
   for that item on that run. No field describes what remains open, what will
   resolve it, or when it will be retried. Naming a record the run opened or
   closed elsewhere — a filed or closed task — is part of what was done and
   stays in the entry.

2. **The command classifies nothing.** `bob worklog` never decides whether an
   item is open or closed, never tracks an item's state from one entry or one
   day to the next, and never reads or writes any day's file other than the
   one an invocation names. Reading an earlier day is something a caller asks
   for explicitly.

3. **Outstanding state lives on the caller's own record.** A consuming skill
   that needs to know what is still unfinished keeps that record itself and
   reads it back directly; a later run learns what needs retrying from that
   record, never by reading a previous day's worklog. `email-triage` keeps it
   on its own `bob task` board (`S-010`, `S-014`).

4. **Distinct items must get distinct, stable identifiers, and that is the
   caller's responsibility.** Because suppression compares only the work
   done, the item identifier is what separates two items in a day's file. A
   caller must give distinct items distinct identifiers, and must keep one
   item's identifier unchanged across days. `email-triage` satisfies this
   with a discriminator derived from the message's `Message-ID` (`S-010`),
   because its human-readable subject-and-sender label is not unique on its
   own.

5. **Scope.** This governs the worklog mechanism and every skill that
   consumes it. It does not dictate what record a caller keeps instead, or
   how. `bob task` and `bob worklog` remain independent tools, exactly as
   `S-014`'s Exclusion requires — a run may use either, both, or neither.

Accepted by the Architect on 2026-09-21, at the point `CR-014`'s amendments
to `S-015` (v0.6) and `S-010` (v0.4) were applied, following the architecture
consistency review of `CR-014` against all 14 approved specifications and all
15 accepted decision records, which found no contradiction with any accepted
decision. Recorded at application rather than proposed in advance, the same
way `ADR-015` was accepted at `S-015`'s Gate 1.

## Consequences

### Positive

- There is exactly one place that answers "is this still outstanding", so the
  question cannot be answered two ways by two artifacts that disagree.
- The worklog's contract becomes small enough to state in a sentence, which
  is what lets skill prose defer to the command instead of restating it.
- The command stays domain-free and stays usable by work that has nothing to
  do with the domain that motivated it, per `S-011`'s requirement of the
  diary mechanism.
- A day's file is a true log: every line in it was put there by a run on that
  day, so it can be read as evidence of what happened rather than as a
  mutable working set.

### Negative

- **A day's worklog alone no longer tells a reader whether an item is
  finished.** Answering that requires the caller's own record as well, so two
  artifacts must be consulted where one used to appear sufficient — appear,
  because the second copy was never authoritative.
- **Identifier discipline becomes load-bearing and is unenforceable by the
  command.** A caller that reuses one identifier for two distinct items now
  loses the second item's entry to same-day suppression whenever the work
  done reads the same. `bob worklog` cannot detect this: from inside the
  command the two are indistinguishable from one item recorded twice.
- **A consuming skill with no record of its own has nowhere to put
  outstanding state.** The mechanism no longer supplies a default; such a
  skill must adopt a record (`bob task` is the one that exists) or accept
  that nothing about unfinished work survives the run.
- **Entries written under the earlier three-bullet shape keep text that
  `list` no longer presents.** The historical `Left`/`Next` lines remain in
  those files and remain readable directly, which `S-015` guarantees, but
  they are not part of what the command reads back.

### Neutral

- `ADR-015` is untouched: where the worklog resolves to is a separate
  question from what an entry records. `ADR-014` §5 is likewise untouched —
  working-directory-relative state stays working-directory-relative.
- `bob task`'s own semantics are unchanged. This decision names it as the
  record `email-triage` keeps, and adds nothing to it.
- No migration of worklog files already on disk, consistent with `CR-013`.

## Alternatives Considered

### Alternative A: Keep descriptive open-state fields alongside an authoritative record

**Description:** Leave `Left`/`Next` in the entry as free prose describing
what remains open, while the caller's own record stays the authoritative
answer — the state `CR-013` left behind.
**Rejected because:** it writes the same fact twice on every run, once
authoritatively and once not, with no mechanism keeping the two consistent
and no way to notice when they diverge. A reader has no way to tell which
copy is stale. The descriptive copy costs a field on every call and buys
nothing the authoritative record does not already say better.

### Alternative B: Let the command decide whether an item is still open

**Description:** Give `bob worklog` the "is this still open" test, as the
original `S-015` carry-forward design did, so a consuming skill never keeps
its own record.
**Rejected** at `CR-013` and not reopened here: it makes a domain-free
command the arbiter of a domain question it has no policy for, and — in the
carry-forward form — lets a day's file fill with entries nobody wrote that
day, which destroys the log's value as evidence.

### Alternative C: Leave the rule as specification prose, with no decision record

**Description:** Treat the boundary as adequately captured by `S-015`,
`S-010`, and `S-011`, and record nothing.
**Rejected because:** the boundary has now been re-argued three times, each
time from first principles, and the rule it settles is split across three
specifications with no single statement of it. It constrains artifacts that
do not exist yet — any future skill that consumes the worklog, and any future
filesystem-only subcommand tempted to model outstanding state — which is
precisely the case `ADR-015` established for recording a convention rather
than leaving it implicit in a specification's bullets.
