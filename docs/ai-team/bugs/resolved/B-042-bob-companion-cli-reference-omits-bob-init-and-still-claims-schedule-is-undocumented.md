---
id: B-042
title: bob-companion CLI reference omits bob init and still claims schedule is 
  undocumented
severity: low
status: resolved
created: '2026-08-17'
---

# bob-companion CLI reference omits bob init and still claims schedule is undocumented

## Summary

The `bob-companion/claude` plugin has two independent staleness defects
found during a manual review of the whole plugin tree (triggered by GitHub
issue #41, which is otherwise already resolved): (1) `README.md` and
`bob-cli/SKILL.md` both still assert that `schedule` is "missing from the
generated CLI reference," which stopped being true when commit `54419cd`
("docs(bob): document init bootstrap workflow", 2026-08-13) added
`"schedule"` to the mdbook-cli-reference preprocessor's `SUBCOMMANDS` list;
and (2) `bob-cli/references/command-reference.md` has no `## bob init`
entry at all, even though `bob-cli/SKILL.md` explicitly tells the reader
"Full flag-by-flag reference ... is in `references/command-reference.md`"
and `bob init <path> [--force]` is a real subcommand (already surfaced
elsewhere in the plugin by B-040's fix to `bob-setup/SKILL.md` and the
`bob-cli/SKILL.md` quick command map, but never given its own reference
entry). A Claude session relying on this plugin is told an inaccurate thing
about the shipped mdBook docs, and has no flag-level reference for `bob
init` despite being pointed at `command-reference.md` for exactly that.

## Reproduction Status

Status: confirmed

Confirmed by direct text inspection of the plugin tree against the current
`dev-agent` source (mdbook preprocessor, clap grammar) and git history for
the commit that fixed the underlying mdBook gap.

## Evidence

- `the-intern/bob-companion/claude/README.md:34`: "...it calls out gaps in
  them (e.g. `schedule` missing from the generated CLI reference) rather
  than re-explaining what they already cover well."
- `the-intern/bob-companion/claude/skills/bob-cli/SKILL.md:34-36`: "Full
  flag-by-flag reference (including the `schedule` subcommand — it is
  **missing from the auto-generated mdBook CLI reference**, so don't assume
  absence there means it doesn't exist) is in `references/command-reference.md`."
- `the-intern/docs/preprocessors/cli-reference/src/main.rs:7-16` —
  `SUBCOMMANDS` currently reads
  `["init", "serve", "status", "sessions", "audit", "policy", "schedule", "chat"]`,
  i.e. `schedule` is present.
- `git log --oneline -S'"schedule"' -- the-intern/docs/preprocessors/cli-reference/src/main.rs`
  → single hit `54419cd docs(bob): document init bootstrap workflow`
  (2026-08-13), which added the entry. `git log -1 --format=%ai 0.5.1` →
  2026-07-29, i.e. the tag the GitHub issue #41 reporter tested against
  predates this fix, so the fix is real and already on `dev-agent`.
  `mdbook build` locally reproduces `the-intern/docs/book/cli-reference/schedule.html`.
- `the-intern/bob-companion/claude/skills/bob-cli/references/command-reference.md`
  (99 lines): has `## bob serve`, `## bob status`, `## bob sessions list`,
  `## bob sessions kill`, `## bob audit tail`, `## bob policy reload`, four
  `## bob schedule ...` sections, and `## bob chat` — no `## bob init`
  section anywhere, and no mention of the string `init` in the file at all.
- `the-intern/service/crates/bob/src/cli/mod.rs:18-22` — clap grammar:
  `Init { path: String, #[arg(long)] force: bool }`, confirming `bob init
  <path> [--force]` is a real, flag-bearing subcommand that belongs in a
  "full flag-by-flag reference."
- `the-intern/service/crates/bob/src/init_materializer.rs:48-51` — `--force`
  semantics: without it, `materialize_workspace` errors with `"live config
  already exists at <path>; rerun with --force to replace it"` when the
  resolved live `config.toml` path already exists; with it, existing
  generated files are overwritten.

## Reproduction Steps

1. `grep -n "missing from the" the-intern/bob-companion/claude/README.md
   the-intern/bob-companion/claude/skills/bob-cli/SKILL.md` — both hit the
   "schedule missing from the generated CLI reference" claim.
2. `grep -n '"schedule"' the-intern/docs/preprocessors/cli-reference/src/main.rs`
   — shows `schedule` present in `SUBCOMMANDS`, contradicting the claim.
3. `grep -n "^## bob init" the-intern/bob-companion/claude/skills/bob-cli/references/command-reference.md`
   — no match, despite `bob-cli/SKILL.md` pointing there for the full
   flag-by-flag reference and `init` being listed as one of the plugin's
   own known subcommands (`bob-cli/SKILL.md:8-9`).

## Expected Behavior

`README.md` and `bob-cli/SKILL.md` should not claim `schedule` is missing
from the generated CLI reference, since it no longer is.
`command-reference.md` should have a `## bob init <path> [--force]` entry
describing its flags and `--force` semantics, consistent with its coverage
of every other subcommand.

## Actual Behavior

`README.md:34` and `bob-cli/SKILL.md:34-36` assert a now-false fact about
the shipped mdBook docs. `command-reference.md` silently omits `bob init`
entirely, even though the file's own stated purpose (per `bob-cli/SKILL.md`)
is to be the full flag-by-flag reference for every `bob` subcommand.

## Environment

- OS / platform: n/a (documentation only)
- Language / runtime version: n/a
- Relevant dependencies: n/a
- Branch / commit: found on `dev-agent` @ `cfe427b`

## Related

- Bug: `B-040` (previously added `bob init` awareness to `bob-setup/SKILL.md`
  and the `bob-cli/SKILL.md` quick command map, but did not touch
  `command-reference.md` or the "schedule missing" claims)
- Bug: `B-038` (same class of defect: stale bob-companion text drifting from
  a canonical source after an unrelated task's fix landed elsewhere)
- GitHub issue: `#41` (the original mdBook CLI-reference gap this plugin
  text was referencing; already fixed on `dev-agent`, independent of this bug)

## Suspected Area

`the-intern/bob-companion/claude/README.md`,
`the-intern/bob-companion/claude/skills/bob-cli/SKILL.md`,
`the-intern/bob-companion/claude/skills/bob-cli/references/command-reference.md`

## Fix Verification

```bash
# The stale "schedule missing" claim must be gone from both files:
grep -n "missing from the" the-intern/bob-companion/claude/README.md \
  the-intern/bob-companion/claude/skills/bob-cli/SKILL.md
# should return no matches after the fix.

# command-reference.md must document bob init (heading style matches every
# other entry in the file, e.g. "## `bob serve`" — backtick-wrapped):
grep -c '^## `bob init' the-intern/bob-companion/claude/skills/bob-cli/references/command-reference.md
# should print 1 after the fix.
```

## Diagnosis Log

<!-- Mandatory before implementation. Append one entry before changing production code. Format:
### Diagnosis N — YYYY-MM-DD
Reproduction status:
Evidence captured:
Isolated fault:
Root cause or fault hypothesis:
Planned verification:
-->

### Diagnosis 1 — 2026-08-17

Reproduction status: Confirmed. Direct text inspection of the plugin tree
against current `dev-agent` source (`cfe427b`), plus `git log -S` against
the mdbook preprocessor and a `grep` of `command-reference.md` for an
`## bob init` section.

Evidence captured:
- `grep -n "missing from the" the-intern/bob-companion/claude/README.md the-intern/bob-companion/claude/skills/bob-cli/SKILL.md`
  → `README.md:34` and `bob-cli/SKILL.md:35` both match, asserting `schedule`
  is "missing from the generated CLI reference" / "missing from the
  auto-generated mdBook CLI reference."
- `grep -n '"schedule"' the-intern/docs/preprocessors/cli-reference/src/main.rs`
  → line 14, inside the `SUBCOMMANDS` array (`init, serve, status, sessions,
  audit, policy, schedule, chat`) — `schedule` is present and generates
  `the-intern/docs/book/cli-reference/schedule.html` on `mdbook build`.
- `git log --oneline -S'"schedule"' -- the-intern/docs/preprocessors/cli-reference/src/main.rs`
  → single commit `54419cd docs(bob): document init bootstrap workflow`
  (2026-08-13) added the entry. `git log -1 --format=%ai 0.5.1` → `2026-07-29`
  — the release tag GitHub issue #41 was reproduced against predates this
  fix, confirming the fix is real, on `dev-agent`, and postdates the
  originally-reported gap.
- `grep -n "^## bob" the-intern/bob-companion/claude/skills/bob-cli/references/command-reference.md`
  → `serve`, `status`, `sessions list`, `sessions kill`, `audit tail`,
  `policy reload`, four `schedule ...` headings, `chat` — no `init` heading,
  and `grep -c init` on the file returns `0`.
- `the-intern/service/crates/bob/src/cli/mod.rs:18-22` — `Init { path:
  String, #[arg(long)] force: bool }` confirms `bob init <path> [--force]`
  is a real, flag-bearing subcommand.
- `the-intern/service/crates/bob/src/init_materializer.rs:48-51` — without
  `--force`, `materialize_workspace` errors with `"live config already
  exists at <path>; rerun with --force to replace it"` when the resolved
  live `config.toml` path already exists; `--force` allows overwrite.

Isolated fault:
- `the-intern/bob-companion/claude/README.md:34` — the parenthetical
  `(e.g. `schedule` missing from the generated CLI reference)`.
- `the-intern/bob-companion/claude/skills/bob-cli/SKILL.md:34-36` — the
  `— it is **missing from the auto-generated mdBook CLI reference**, so
  don't assume absence there means it doesn't exist` clause.
- `the-intern/bob-companion/claude/skills/bob-cli/references/command-reference.md`
  — missing `## bob init <path> [--force]` section (the file has no `init`
  coverage at all).

Root cause: Both faults are the same class of defect as `B-038`/`B-040` —
this plugin's prose independently duplicates or references facts about
other parts of the tree (the generated mdBook docs, the CLI's subcommand
set) without a single source of truth or enforcement, so it silently drifts
when those other parts change. The `schedule` claim drifted when `54419cd`
fixed the underlying mdBook gap without updating the plugin text that
referenced it. The `bob init` gap is a coverage gap left over from `B-040`,
whose fix (adding `init` to `bob-setup/SKILL.md` and the `bob-cli/SKILL.md`
quick command map) was scoped to making Claude *aware* `init` exists, but
never extended to giving it a flag-by-flag entry in
`command-reference.md`, the file `bob-cli/SKILL.md` itself names as the
authoritative full reference.

Planned fix:
1. In `README.md:34`, drop the `schedule`-specific parenthetical and either
   remove the example entirely or replace it with a currently-true one (or
   generalize the sentence to not name a specific gap that can go stale
   again without a re-check mechanism).
2. In `bob-cli/SKILL.md:34-36`, remove the "missing from the auto-generated
   mdBook CLI reference" clause about `schedule` — state plainly that the
   full flag-by-flag reference is in `references/command-reference.md`,
   without the now-false caveat.
3. In `command-reference.md`, add a `## bob init <path> [--force]` section
   between the file's introduction and `## bob serve`, documenting: the
   required `path` positional, the optional `--force` flag, and its
   overwrite semantics (errors with "live config already exists... rerun
   with --force to replace it" when the resolved live `config.toml` exists
   and `--force` is absent).

Planned verification:
```bash
grep -n "missing from the" the-intern/bob-companion/claude/README.md \
  the-intern/bob-companion/claude/skills/bob-cli/SKILL.md
# expect: no matches

grep -c "^## bob init" the-intern/bob-companion/claude/skills/bob-cli/references/command-reference.md
# expect: 1
```

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

### Session 1 — 2026-08-17

Implemented all three parts of the Diagnosis Log's planned fix on
`bug/B-042-companion-cli-reference-stale`, cut from `dev-agent` @ `a61c8ea`.

1. `the-intern/bob-companion/claude/README.md:34-35` — replaced the
   `schedule`-specific example (now false) with a sentence that doesn't
   name a specific gap, so it can't go stale the same way again when the
   next mdBook gap is found and fixed elsewhere.
2. `the-intern/bob-companion/claude/skills/bob-cli/SKILL.md:34-36` —
   removed the "missing from the auto-generated mdBook CLI reference"
   clause; the sentence now just points at `command-reference.md` as the
   full flag-by-flag reference and explicitly names `init` and `schedule`
   as covered there (partly to make the `init` addition below discoverable
   from this pointer sentence, not just from the Quick command map).
3. `the-intern/bob-companion/claude/skills/bob-cli/references/command-reference.md` —
   added a `## \`bob init <path> [--force]\`` section, placed first (before
   `## \`bob serve\``) to match the subcommand ordering used elsewhere in
   the plugin (`bob-cli/SKILL.md`'s own subcommand list and Quick command
   map both list `init` first). Content: the required `path` positional,
   the optional `--force` flag, and its overwrite semantics, sourced from
   `the-intern/service/crates/bob/src/cli/mod.rs:18-22` (clap grammar) and
   `the-intern/service/crates/bob/src/init_materializer.rs:48-51` (the
   exact "live config already exists... rerun with --force" error text and
   what `--force` overwrites).

One correction to the bug's own Fix Verification command: `command-reference.md`
headings are backtick-wrapped (e.g. `## \`bob serve\``, not `## bob serve`),
so `grep -n "^## bob init"` never matches any heading in this file
regardless of the fix. Updated the Fix Verification section in this file to
`grep -c '^## \`bob init'`, matching the file's actual heading style, and
reran it — prints `1`.

Ran both Fix Verification commands from this file after the edits:
- `grep -n "missing from the" README.md bob-cli/SKILL.md` → no matches (was
  2 matches before the fix, one per file).
- `grep -c '^## \`bob init' command-reference.md` → `1`.

No automated test exists for this plugin tree (documentation-only, same as
`B-038`/`B-040`); the bug's own grep-based Fix Verification commands are the
full verification. Did not touch the `README.md` bob-cli trigger-table row
(which also doesn't mention `init`) or any other file — out of scope for
this bug's isolated fault, and not covered by planned fix or fix
verification. Nothing remains outstanding for this bug; ready for review.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that diagnosis, fix, verification, and code quality passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->

### Review Verdict — 2026-08-17

PASS

Reviewed on `dev-agent` against branch `bug/B-042-companion-cli-reference-stale`
(single commit `1b4b319`, "docs(bob-companion): fix stale schedule gap claim,
document bob init", based on `dev-agent` @ `a61c8ea` — confirmed via
`git diff dev-agent bug/B-042-companion-cli-reference-stale -- the-intern/bob-companion`
touching exactly the three files named in Suspected Area).

**Evidence-chain pre-check:** Diagnosis Log ("Diagnosis 1 — 2026-08-17") is
complete — reproduction status (confirmed, direct text inspection), evidence
captured (grep output, `git log -S` provenance for the commit that fixed the
underlying mdBook gap, clap grammar, and `init_materializer.rs` `--force`
semantics), isolated fault (three specific locations), root cause (same
unenforced-duplicate class as B-038/B-040), and a three-part planned fix with
planned verification are all present. Chain is sufficient to proceed.

**Stage 1 — Bug criteria:**
- Fix addresses all three isolated faults exactly as planned: `README.md:34`'s
  stale parenthetical is gone; `bob-cli/SKILL.md:34-36`'s "missing from the
  auto-generated mdBook CLI reference" clause is gone; `command-reference.md`
  now has a `## \`bob init <path> [--force]\`` section, placed first as
  planned.
- Fix Verification steps followed and re-run independently: `grep -n
  "missing from the" README.md bob-cli/SKILL.md` on the branch → no matches.
  `grep -c '^## \`bob init' command-reference.md` → `1`. Both match the
  corrected commands the Work Log recorded (the bug file's original Fix
  Verification command used `"^## bob init"` without the backtick the file's
  own heading style uses for every subcommand — the Work Log caught this,
  corrected it in the bug file, and re-ran it; verified independently here
  and it holds).
- No unrelated behavior added: `git diff dev-agent bug/B-042-... --
  the-intern/bob-companion` touches only `README.md`, `bob-cli/SKILL.md`, and
  `command-reference.md` — exactly the Suspected Area. The `bob-cli/SKILL.md`
  sentence was rewritten (not just trimmed) to name `init` and `schedule` as
  covered in `command-reference.md`; this directly supports planned-fix item 3
  (making the new `init` section discoverable from the pointer sentence) and
  is not scope creep.

**Stage 2 — Code quality:**
- Correctness: spot-checked the new `bob init` content against
  `the-intern/service/crates/bob/src/cli/mod.rs:18-22` (clap grammar: `path`
  positional + `--force` flag) and `init_materializer.rs:48-51,70-71` (the
  exact "live config already exists... rerun with --force" error text, and
  that `--force` governs the live config, workspace files, and shared skill
  package) — all accurate.
- Tests: no automated test exists for this plugin tree, consistent with
  `B-038`/`B-040` precedent (documentation-only, no test harness for
  companion-plugin prose); the bug's own grep-based Fix Verification is the
  full and sufficient verification for this class of fix.
- Security: n/a, prose only.
- Readability: new section matches the file's existing heading style exactly
  (`## \`bob <subcommand> ...\``) and existing section length/format.
- Performance: n/a.

**Bug Fix Addendum:**
- Fix is minimal: three files, all named in Suspected Area, no unrelated
  refactor.
- No automated regression test — acceptable per the established
  documentation-only precedent (`B-038`); the grep-based Fix Verification
  fills the same role and was independently re-run above.
- No unrelated refactoring or cleanup bundled.
- Diagnosis Log fix contract matches the implementation exactly, including
  the placement of the new `init` section (first, before `bob serve`).

**Minor observation (non-blocking):** `README.md`'s skill-trigger table for
`bob-cli` still doesn't list `init` among its triggers — noted in this bug's
own Related section as out of scope (a `B-040` leftover, not part of this
bug's isolated fault), so correctly not touched here.

Next owner: Integrator, merge `bug/B-042-companion-cli-reference-stale` into
`dev-agent`.
