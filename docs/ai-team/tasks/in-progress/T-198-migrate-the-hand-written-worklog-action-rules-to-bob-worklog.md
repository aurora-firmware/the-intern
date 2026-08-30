---
id: T-198
title: Migrate the hand-written worklog action rules to bob worklog
status: pending
priority: medium
assigned-role: developer
created: '2026-08-30'
---

# Migrate the hand-written worklog action rules to bob worklog

<!--
Task Quality Rules (see the new-task skill for full details):
  - Atomic — one clear outcome.
  - One-shottable — ≤ 3–4 files touched, ≤ 5 ACs, Description ≈ 20 lines.
  - Verifiable — concrete Verification command or explicit manual steps.
  - Self-contained — Description is enough to start without follow-up questions.
  - EARS — every AC matches one of the five EARS patterns below.
  - Dependency-honest — list every prior task this one reads from or modifies.
-->

## Description

Component 5, part two: migrate the worklog action rules everywhere they are
hand-written. The **same ten-rule listing appears twice** — in the shipped
mdBook operator guide (`the-intern/docs/src/operator-guide/index.md`) and in
the `bob-skills` package `README.md` (introduced as "the S-004 worklog
rules below must match", so it is prescriptive, not historical). Apply the
identical migration to both.

**1. Migrate the worklog action rules (both listings).** Of the ten
worklog-driven `[[policy.action_rules]]` entries in each listing, **keep**
the two install-path reference reads — `read` `path`
`/opt/bob/skills/worklog/SKILL.md` and `/opt/bob/skills/worklog/references/*.md`
(S-011 still needs them for the rewritten skill's reference reads) — and
**remove** the other eight: the relative `read` `worklog/*.md`; the six
raw-shell `bash` rules `*find worklog*`, `*ls *worklog*`,
`test -f worklog/*`, `cat worklog/*.md*`, `mkdir -p worklog*`,
`*>> worklog/*.md*`; and `date +%H:%M*`. Replace those eight with **one**
`bash` rule whose `command` matcher is prefix-anchored on
`bob worklog append` / `bob worklog list` (wildcard tail), mirroring the
existing `bob task*` rule's shape.

**2. Update the surrounding prose (both listings).** The "now
live-validated" narrative around each listing: describe the single
`bob worklog` rule; drop the description of the removed raw-shell rules and
the `date +%H:%M` gap; and remove or reframe the quotation of S-011's
now-retired "broad enough to cover arbitrary working directories" clause
(operator guide and `README.md` both carry it). In the operator guide,
also fix the later paragraph (around lines 1317–1320) that tells the
operator to "keep that rule in place" referring to the now-removed relative
`worklog/*.md` matcher — the cross-day continuity path now runs through
`bob worklog`'s own reconciliation, so drop or repoint that paragraph.
`README.md` carries the same instruction in a different place: the
prescriptive paragraph immediately above its `## Validation outcomes`
heading (around lines 454–465) still lists "checks and lists today's
`worklog/` files through `bash`, opens prior worklog contents through
`read`" as part of the deployed runtime surface, and states that "the
deployed allow rules must admit that relative shape" — repoint both
sentences at the single `bob worklog` rule.
Leave historical validation-outcome sections (what past live runs observed —
in `README.md`, everything under `## Validation outcomes`) unchanged in both
files.

**3. Fix two stale claims in the operator guide's `bob task` section**
(around lines 262–272): "That makes it, along with `init`, the only bob
subcommand that works whether or not `bob serve` is running" must also name
`bob worklog`; and the cross-reference "This is the same guidance already
given for the `worklog` skill's writes" must still read correctly now that
worklog writes go through a command rule.

**4. Record issue closure for the integrator.** GitHub issues #62
(carry-forward duplication) and #63 (append-order vs time-order) are fixed
by construction by S-015. Record in the Work Log the exact `gh issue close`
commands (with a comment referencing S-015) for the integrator to run at
merge; do not close them from the task branch.

## Acceptance Criteria

AC-1: Both hand-written worklog action-rule listings — the operator guide
and `bob-skills/README.md` — shall retain exactly the two
`/opt/bob/skills/worklog/...` read rules and replace the eight raw-shell
worklog rules with a single `bash` rule matching `bob worklog append` /
`bob worklog list`.

AC-2: The prose around each listing shall describe the single `bob worklog`
rule, shall not present S-011's retired "arbitrary working directories"
clause as current, and in neither file shall instruct keeping the removed
relative `worklog/*.md` matcher — or any other removed raw-shell worklog
rule — for cross-day continuity or as a required part of the deployed
runtime surface.

AC-3: The operator guide's `bob task` section shall name `bob worklog`
alongside `bob init` and `bob task` as subcommands that run without
`bob serve`.

AC-4: WHEN the mdBook docs are built with a freshly built `bob` on
`BOB_BIN` THE SYSTEM SHALL build without error.

AC-5: The Work Log shall record the `gh issue close` commands for #62 and
#63 for the integrator.

## Dependencies

- `T-193` — the `bob worklog` subcommand the new rule admits
- `T-195` — the rewritten `worklog` skill whose runtime surface the new rule matches
- `T-196` — the rewritten `email-triage` worklog surface whose runtime calls the new rule
  must admit; removing the eight raw-shell rules before this rewrite lands would ship a
  ruleset that denies calls the shipped skill still instructs
- `T-200` — the rewritten `email-triage` category workflow files, for the same reason as T-196

## Files to Touch

- `the-intern/docs/src/operator-guide/index.md` — worklog action-rule migration, prose update, cross-day-continuity paragraph, `bob task` section fixes
- `the-intern/bob-skills/README.md` — the duplicated worklog action-rule listing and its surrounding prose, migrated identically

## Verification

```bash
cd the-intern/service && cargo build -p bob
cd ../docs && BOB_BIN="$PWD/../service/target/debug/bob" mdbook build
grep -q 'pattern = "bob worklog' src/operator-guide/index.md
grep -q 'pattern = "bob worklog' ../bob-skills/README.md
! grep -qE 'pattern = "\*(find|>>) worklog|pattern = "\*ls \*worklog|pattern = "date \+%H:%M|pattern = "(mkdir -p|test -f|cat) worklog|pattern = "worklog/\*\.md' src/operator-guide/index.md ../bob-skills/README.md
! grep -q 'must admit that relative shape' ../bob-skills/README.md
```

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

### Session 1 — 2026-08-30

Implemented T-198 as a pure docs migration across the two files listed in the task (`the-intern/docs/src/operator-guide/index.md`, `the-intern/bob-skills/README.md`), one commit per file on `task/T-198-migrate-the-hand-written-worklog-action-rules-to-bob-worklog`. The task lifecycle file was left untouched on the branch.

Action-rule migration (both listings, identical in substance): kept the two install-path worklog reference reads (`.../worklog/SKILL.md` and `.../worklog/references/*.md`); removed the relative `read` `worklog/*.md` and the six raw-shell `bash` rules (`*find worklog*`, `*ls *worklog*`, `test -f worklog/*`, `cat worklog/*.md*`, `mkdir -p worklog*`, `*>> worklog/*.md*`) plus `date +%H:%M*`; replaced those eight with a single `bash` rule `{ field_path = "command", pattern = "bob worklog*" }`, placed where the removed raw-shell rules were. I read the existing `bob task*` rule first and copied its exact shape — `tool = "bash"`, one `arg_matchers` entry on `field_path = "command"`, prefix + wildcard tail, no explicit decision field (the ruleset is allow-only by match). `bob worklog*` (rather than two rules or `bob worklog append*`) is the one-rule form that admits both `bob worklog append` and `bob worklog list` while mirroring `bob task*` exactly; it also satisfies the `grep 'pattern = "bob worklog'` verification.

Prose updates: rewrote the "now live-validated" paragraph in each file to describe the single `bob worklog` rule (skill calls `bob worklog list` once per run and `bob worklog append` once per item; the command creates `worklog/`, reconciles prior-day open items, and stamps its own clock), and dropped the description of the removed raw-shell rules, the `date +%H:%M` gap, and the (now-resolved) B-039 wrong-timestamp follow-up. Reframed S-011's "broad enough to cover arbitrary working directories" clause in both files as explicitly retired for worklog writes (the working directory never appears in a `bob worklog` command string). Operator guide: fixed the `bob task` section so it names `bob worklog` alongside `bob init` and `bob task` as serve-independent, and adjusted the "same guidance already given for the `worklog` skill's writes" cross-reference to "the `worklog` skill's own `bob worklog` calls"; repointed the later cross-day-continuity paragraph (previously "keep that rule in place" for the relative `read.path = "worklog/*.md"` matcher) to `bob worklog`'s built-in reconciliation. README: repointed the prescriptive paragraph immediately above `## Validation outcomes` — both the "checks and lists today's `worklog/` files through `bash`, opens prior worklog contents through `read`" sentence and the "the deployed allow rules must admit that relative shape" sentence — at the single `bob worklog` rule, and made a small companion fix to the earlier "it is the path the S-004 worklog rules below must match" sentence since the worklog rule is now a command matcher, not a path matcher. Everything under `## Validation outcomes` in README, and the historical T-139/T-140/T-164 validation-outcome prose in the operator guide, was left unchanged.

Tried and rejected: (a) unifying the two kept-read placeholder paths (`/opt/bob/skills/...` vs `/abs/skill-install-path/...`) across the two files — rejected as out of scope and not required by the ACs or verification; each file keeps its own convention. (b) Keeping a trimmed mention of the `*ls *worklog*` / `date +%H:%M*` gaps in the README prescriptive prose with a pointer to Validation outcomes — rejected because the task says to drop that description; the Validation outcomes section still records those gaps as history and the prose now frames T-139/T-140/T-164 as predating the `bob worklog` command.

Verification run and passing: `cargo build -p bob`; `BOB_BIN=.../target/debug/bob mdbook build` (exit 0, AC-4); all four grep assertions; `git diff --name-only dev-agent...HEAD` shows only the two files; `cargo test --workspace` from `the-intern/service/` has 0 failures (no Rust touched). Note: `mdbook build` emits a pre-existing `mdbook-mermaid` version-mismatch warning that does not fail the build.

Nothing remains for a follow-up session on this task.

Issue closure for the integrator to run at merge (AC-5) — do NOT run from the task branch:

```
gh issue close 62 --comment "Fixed by construction in S-015 (bob worklog subcommand — append, list, and automatic first-run reconciliation): reconciliation is presence-tested per item-identifier, so a still-open item is carried forward exactly once per day no matter how many times append/list run. The hand-written worklog action-rule listings were migrated to the bob worklog command rule in T-198."
```

```
gh issue close 63 --comment "Fixed by construction in S-015 (bob worklog subcommand — append, list, and automatic first-run reconciliation): bob worklog owns entry ordering and reconciliation, replacing the raw-shell append recipe whose file was append-ordered rather than time-ordered under concurrent scheduled runs. The hand-written worklog action-rule listings were migrated to the bob worklog command rule in T-198."
```

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->
