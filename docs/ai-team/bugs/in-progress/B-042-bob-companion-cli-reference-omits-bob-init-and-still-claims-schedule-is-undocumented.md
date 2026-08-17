---
id: B-042
title: bob-companion CLI reference omits bob init and still claims schedule is 
  undocumented
severity: low
status: in-progress
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

# command-reference.md must document bob init:
grep -n "^## bob init" the-intern/bob-companion/claude/skills/bob-cli/references/command-reference.md
# should return exactly one match after the fix.
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

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that diagnosis, fix, verification, and code quality passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->
