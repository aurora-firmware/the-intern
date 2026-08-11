---
id: B-038
title: bob-setup companion skill duplicates a now-stale interactive pi version 
  number
severity: low
status: resolved
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

### Session 1 — 2026-08-11

Read the canonical bug file from `dev-agent` (not the stale in-tree copy, which predates the Diagnosis Log) and used the recorded Diagnosis Log as the fix contract. The isolated fault was the sentence "Interactive `pi` binary (used by `bob chat`): last verified against **0.79.10**." at `the-intern/bob-companion/claude/skills/bob-setup/SKILL.md:30-31`, which disagreed with the root README's T-150-reconciled value of pi 0.80.3.

Of the two options the Diagnosis Log offered — (a) drop the duplicated number and defer entirely to the root README, or (b) update the number to 0.80.3 — I chose (a). The extension-API line just above it (`0.75.3`) is kept accurate by an automated test (`npm test` in `the-intern/pi-extension` fails loudly on mismatch), so hardcoding a number there carries low staleness risk. The interactive-`pi` line has no such enforcement mechanism — it's exactly the kind of unenforced duplicate that caused this bug in the first place (T-150's scope only covered README.md, so this file drifted). Restating the current number (0.80.3) would just recreate the same staleness trap for the next version bump. Dropping the number and pointing readers to the root README's "pi-agent Version Compatibility" section removes the duplicate-of-truth entirely, which is also consistent with the paragraph's own lead sentence ("Version compatibility is pinned, not aspirational — check the root README.md ... section for the exact supported versions").

I did not touch the two `0.75.3` extension-API-pin references (`bob-setup/SKILL.md:28`, `bob-troubleshooting/references/symptom-table.md:12`), confirmed via `grep -rn "0.79.10\|0.65.2\|0.75.3" the-intern/bob-companion/` before and after the edit that only the intended line changed and the unrelated pins were preserved verbatim.

Ran the bug's own Fix Verification command (`grep -n "0.79.10\|0.65.2" the-intern/bob-companion/claude/skills/bob-setup/SKILL.md`) and confirmed it now returns no matches. No automated regression test was written, since this is a one-line prose fix and the bug's Fix Verification is itself a single grep command. Committed the change as `cc3d52b` (`docs(bob-companion): drop stale duplicated interactive pi version`) on `bug/B-038-stale-pi-version-companion-skill`. Nothing remains outstanding for this bug; ready for review.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that diagnosis, fix, verification, and code quality passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->

### Review Verdict — 2026-08-11

PASS

Reviewed on `dev-agent` against branch `bug/B-038-stale-pi-version-companion-skill`
(single commit `cc3d52b`, "docs(bob-companion): drop stale duplicated interactive
pi version", based on `dev-agent` @ `3335532` — confirmed via
`git merge-base cc3d52b 3335532`).

**Evidence-chain pre-check:** Diagnosis Log ("Diagnosis 1 — 2026-08-11") is
complete — reproduction status (confirmed, direct text comparison), evidence
captured (SKILL.md:30-31 text, README.md's T-150-reconciled record, git log
provenance for the T-150 commit, and a full `grep -rn` of the companion tree),
isolated fault (SKILL.md:30-31's "last verified against 0.79.10" sentence),
and root cause (T-150's Files to Touch scope was limited to `README.md`, so
this independent duplicate never got updated) are all present. Chain is
sufficient to proceed.

**Stage 1 — Bug criteria:**
- Fix addresses the isolated fault: confirmed via `git show cc3d52b` — the
  stale "last verified against **0.79.10**" sentence at
  `the-intern/bob-companion/claude/skills/bob-setup/SKILL.md:30-31` is
  replaced with a sentence that drops the version number and defers to the
  root README's "pi-agent Version Compatibility" section. Matches the isolated
  fault recorded in the Diagnosis Log exactly.
- Fix Verification steps followed: ran the bug's own command against the
  fixed commit — `git show cc3d52b:the-intern/bob-companion/claude/skills/bob-setup/SKILL.md`
  piped through `grep -n "0.79.10\|0.65.2"` returns no matches (exit 1), as
  required.
- No unrelated behavior added: `git show --stat cc3d52b` shows exactly one
  file changed (3 insertions, 2 deletions) — only
  `the-intern/bob-companion/claude/skills/bob-setup/SKILL.md`. The bug
  lifecycle file was not touched on the branch (the Diagnosis Log and Work
  Log entries live in commits `d482cb9`/`09fb849` on `dev-agent`, not on the
  bug branch).
- Ran `git grep -n "0.79.10\|0.65.2\|0.75.3" cc3d52b -- the-intern/bob-companion/`
  directly against the fixed commit: only the two expected, out-of-scope
  `0.75.3` extension-API-pin references remain
  (`bob-setup/SKILL.md:28`, `bob-troubleshooting/references/symptom-table.md:12`),
  both left untouched exactly as the Diagnosis Log's planned fix specified.

**Stage 2 — Code quality:**
- Correctness/readability: the replacement sentence is grammatically clear,
  matches the surrounding bullet's style, and is consistent with the
  paragraph's own lead-in ("check the root README.md ... section for the
  exact supported versions").
- Fix is minimal: 3-line diff, single file, no unrelated refactoring or
  cleanup bundled in.
- Diagnosis Log fix contract vs. implementation: the Diagnosis Log's Planned
  Fix offered two options — (a) drop the duplicated number and defer to the
  root README, or (b) update it to 0.80.3. The Developer chose (a), matching
  the bug's own Expected Behavior section, which explicitly allows either.
  The Work Log's stated rationale — the extension-API line just above is
  protected by an automated test (`npm test` in `the-intern/pi-extension`
  fails loudly on mismatch) while the interactive-`pi` line has no such
  enforcement, so restating a hardcoded number would simply recreate the same
  unenforced-duplicate trap that caused this bug — is sound engineering
  judgment, not merely a different-but-equally-valid choice. Endorsed.
- Regression test: none added. Acceptable and documented — this is a
  one-line prose/documentation fix in a Markdown skill file with no
  executable behavior to unit-test, and the bug's own Fix Verification is
  itself a single grep command, which was run and independently
  re-verified above. Proportionate for a low-severity documentation bug of
  this size; does not block PASS.

Both stages pass. No issues found.
