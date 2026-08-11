---
id: B-038
title: bob-setup companion skill duplicates a now-stale interactive pi version 
  number
severity: low
status: in-progress
created: '2026-08-10'
---

# bob-setup companion skill duplicates a now-stale interactive pi version number

## Summary

`the-intern/bob-companion/claude/skills/bob-setup/SKILL.md` duplicates the
root README's previously-recorded interactive-`pi`-binary version number
(`0.79.10`, T-103) directly in its own prose, rather than only pointing
readers at the root README section. `T-150` reconciled the root README's
"pi-agent Version Compatibility" section so that all three bob spawn paths
(pooled RPC worker, interactive chat, scheduled/periodic) now share a single
revalidated version, **pi 0.80.3**, replacing the old per-path
`0.79.10`/`0.65.2` records. `T-150`'s Files to Touch was scoped to
`README.md` only, so this companion-plugin duplicate was left unedited and
is now factually stale relative to the canonical record it claims to defer
to.

## Reproduction Status

Status: confirmed — a direct text comparison between the two files.

## Evidence

- `the-intern/bob-companion/claude/skills/bob-setup/SKILL.md:29-31`:
  > "Version compatibility is pinned, not aspirational — check the root
  > `README.md` "pi-agent Version Compatibility" section for the exact
  > supported versions before assuming a mismatch is your bug: ... Interactive
  > `pi` binary (used by `bob chat`): last verified against **0.79.10**."
- Root `README.md`'s "pi-agent Version Compatibility" section (post-`T-150`):
  the interactive-chat spawn path's runtime `pi` binary is now recorded as
  **pi 0.80.3**, reconciled together with the pooled-RPC-worker and
  scheduled/periodic paths.
- `grep -rn "0.79.10\|0.65.2\|0.75.3" the-intern/bob-companion/` shows this is
  the only stale occurrence in the companion plugin tree; the other match
  (`bob-troubleshooting/references/symptom-table.md:12`, the `0.75.3`
  extension-API pin) is unaffected by `T-150` and remains accurate.
- Failing command or test: none automated — this is a prose cross-reference,
  not covered by `pi-agent-compat.test.ts` or any other test.

## Reproduction Steps

1. Read `the-intern/bob-companion/claude/skills/bob-setup/SKILL.md`'s
   "Hard prerequisite: `pi` on PATH" section.
2. Compare its stated interactive `pi` binary version (`0.79.10`) against the
   root `README.md`'s "pi-agent Version Compatibility" section (`pi 0.80.3`,
   as of `T-150`).
3. Observe the two disagree, even though the SKILL.md explicitly tells the
   reader to treat the root README as the source of truth.

## Expected Behavior

The companion skill should either state only that the root README is
authoritative (dropping the duplicated number entirely) or keep its
duplicated number in sync with the root README's reconciled record, so an
operator following the companion plugin's setup skill is not told a
different supported version than the project's own canonical record.

## Actual Behavior

`bob-setup/SKILL.md` still asserts "last verified against **0.79.10**" for
the interactive `pi` binary, which no longer matches the root README's
`T-150`-reconciled value of **pi 0.80.3**.

## Environment

- OS / platform: Linux (this dev environment)
- Language / runtime version: n/a (documentation only)
- Relevant dependencies: `pi` 0.80.3 (`@earendil-works/pi-coding-agent`)
- Branch / commit: discovered on `task/T-150-reconcile-pi-agent-version-records`
  while implementing `T-150`; the root README change lives on that branch
  pending integration into `dev-agent`

## Related

- Task: `T-150` (introduced the reconciled root README record this file now
  disagrees with)

## Suspected Area

`the-intern/bob-companion/claude/skills/bob-setup/SKILL.md`, "Hard
prerequisite: `pi` on PATH" section (lines ~22-31).

## Fix Verification

```bash
# After the fix, the companion skill's own text must not contain a
# version number that disagrees with the root README's current
# "pi-agent Version Compatibility" section. E.g.:
grep -n "0.79.10\|0.65.2" the-intern/bob-companion/claude/skills/bob-setup/SKILL.md
# should return no matches once the duplicate is removed or updated to match
# the root README's current reconciled runtime pi version.
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

### Diagnosis 1 — 2026-08-11

Reproduction status: Confirmed. Direct text comparison between `the-intern/bob-companion/claude/skills/bob-setup/SKILL.md` and the root `README.md`'s "pi-agent Version Compatibility" section, on this branch (cut from `dev-agent` @ 3335532, which already includes T-150's merged README reconciliation, commit `11d3d93` / `a1ba007`).

Evidence captured:
- `the-intern/bob-companion/claude/skills/bob-setup/SKILL.md:30-31` states: "Interactive `pi` binary (used by `bob chat`): last verified against **0.79.10**."
- Root `README.md:83-89` ("pi-agent Version Compatibility" section, post-T-150) states the runtime `pi` binary is now reconciled to a single version across all three bob spawn paths (pooled RPC worker, interactive chat, scheduled/periodic): **pi 0.80.3**, explicitly replacing the old "interactive: 0.79.10, T-103" record.
- `git log --oneline -- README.md` confirms `a1ba007 docs(pi-agent): reconcile version records and verify resources_discover` (2026-08-10) is the T-150 commit that changed README.md; `git log --all --oneline | grep T-150` confirms T-150 is `completed` and merged into `dev-agent` (`11d3d93 chore(tasks): merge T-150 ...`, `6af367d chore(tasks): move T-150 to completed`).
- `grep -rn "0.79.10\|0.65.2\|0.75.3" the-intern/bob-companion/` output:
  - `bob-troubleshooting/references/symptom-table.md:12` — `0.75.3` (extension-API pin, unaffected by T-150, still accurate — out of scope).
  - `bob-setup/SKILL.md:28` — `0.75.3` (extension-API pin, still accurate — out of scope).
  - `bob-setup/SKILL.md:31` — `0.79.10` (interactive runtime `pi` binary version — stale, disagrees with README's reconciled 0.80.3).
- Suggested Fix Verification command from the bug file, run against the current tree, still matches (i.e. the defect is still present): `grep -n "0.79.10\|0.65.2" the-intern/bob-companion/claude/skills/bob-setup/SKILL.md` → returns `31:  **0.79.10**.` (exit 0 / one match).

Isolated fault: `the-intern/bob-companion/claude/skills/bob-setup/SKILL.md`, lines 30-31 (the "Interactive `pi` binary (used by `bob chat`): last verified against **0.79.10**" sentence). This is the only stale duplicate in the companion-plugin tree; the two other `0.75.3` matches are the extension-API pin, which T-150 deliberately did not change (per README.md's own text: "the two are reconciled, not merged ... one is a compile-time API contract and the other is a runtime executable version") and remain correct.

Root cause: T-150's Files to Touch scope was limited to `README.md` only. `bob-setup/SKILL.md` independently duplicates the interactive-`pi` runtime version number in its own prose instead of only deferring to the root README section it explicitly names as authoritative, so the reconciliation task's edit never reached this file. This is a scope-boundary gap (an out-of-scope duplicate location), not a logic or state error — root cause, not just a hypothesis, since the evidence chain (task history, file contents, and the bug's own reproduction steps) fully accounts for the discrepancy.

Planned fix: In `the-intern/bob-companion/claude/skills/bob-setup/SKILL.md`, either (a) drop the duplicated "last verified against 0.79.10" number entirely and state only that the root README's "pi-agent Version Compatibility" section is authoritative for the interactive `pi` binary, or (b) update the duplicated number to match the root README's current reconciled value (pi 0.80.3). No other files in the companion tree need changes — the `0.75.3` extension-API references in `bob-setup/SKILL.md:28` and `bob-troubleshooting/references/symptom-table.md:12` are unaffected by T-150 and must be left as-is.

Planned verification:
```
grep -n "0.79.10\|0.65.2" the-intern/bob-companion/claude/skills/bob-setup/SKILL.md
```
should return no matches after the fix (currently returns one match at line 31, confirming the pre-fix baseline).

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
