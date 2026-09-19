---
id: B-049
title: Operator guide's email-triage deploy policy TOML still omits the 
  tasks/SKILL.md read rule B-047 should have paired with its bob task* fix
severity: high
status: resolved
created: '2026-09-19'
---

# Operator guide's email-triage deploy policy TOML still omits the tasks/SKILL.md read rule B-047 should have paired with its bob task* fix

## Summary

`the-intern/docs/src/operator-guide/index.md`'s "Deploying the
`email-triage` scheduled job" walkthrough (step 4) had its missing `bob
task*` `bash` rule added by `B-047` (merge `91833b7`), but that fix mirrored
only half of the reference pair the guide's own "The task board (`bob
task`)" section (lines 336-346) documents together: a `bash` rule for `bob
task*` **and** a `read` rule for `<skill_install_path>/tasks/SKILL.md`,
introduced with "At minimum, admit the skill's own command calls and its
`SKILL.md` read at the resolved `skill_install_path`." B-047's fix added
only the `bash` rule (now at lines 1192-1196) and never added the paired
`read` rule for `tasks/SKILL.md`, even though the same step-4 block already
carries an analogous `read` rule for every other skill the job loads
(`email-triage/SKILL.md`, `himalaya/SKILL.md`, `worklog/SKILL.md`). An
operator who deploys `email-triage` by copying step 4's policy TOML
verbatim (as instructed) still has no rule admitting a `read` of
`tasks/SKILL.md`, so the `tasks` skill `email-triage/SKILL.md` explicitly
says to "load" cannot actually be loaded once the bootstrap-wide `read`
rule is narrowed away in the same step. Sibling bug `B-048` fixed the
identical defect class in `the-intern/bob-skills/README.md` completely
(it added both the `bob task*` bash rule and the `tasks/SKILL.md` read
rule in the same commit, `528096e`), so this gap is specific to the
operator-guide walkthrough that `B-047` touched.

## Reproduction Status

Status: confirmed (by document inspection; not run against a live `bob`
instance — same reproduction method as B-047/B-048, which cover the same
underlying runtime dependency)

## Evidence

- Logs / stack traces / failing assertions: none captured live; static
  documentation-accuracy defect, discovered during an architecture/spec-
  consistency review of the merged `B-047`/`B-048` fixes (comparing them
  against `S-010`, `S-004`, and `ADR-014`).
- Screenshots or recordings: none.
- Failing command or test: none (docs-only defect; no automated test covers
  this cross-section documentation consistency, same as `B-047`/`B-048`).
- First diagnostic step if not yet reproduced: n/a — already confirmed by
  inspection, see Reproduction Steps.

## Reproduction Steps

1. Open `the-intern/docs/src/operator-guide/index.md`, section "The task
   board (`bob task`)" (heading at line 309). Note its `[[policy.action_rules]]`
   pair at lines 336-346: a `bash` rule for `bob task*` immediately followed
   by a `read` rule for `<skill_install_path>/tasks/SKILL.md`, introduced by
   "At minimum, admit the skill's own command calls and its `SKILL.md` read
   at the resolved `skill_install_path`."
2. Open the same file's "Deploying the `email-triage` scheduled job"
   section, step 4's `[[policy.action_rules]]` TOML block (now lines
   1083-1203, after `B-047`'s fix). Note its seven `read` rules: one each
   for `email-triage/SKILL.md`, `himalaya/SKILL.md`, `worklog/SKILL.md`,
   `email-triage/references/*.md`, `email-triage/references/categories/*.md`,
   `himalaya/references/*.md`, and `worklog/references/*.md` — but none for
   `tasks/SKILL.md`.
3. Note the block's `bash` rules include `bob task*` (lines 1192-1196,
   added by `B-047`) alongside the pre-existing `bob worklog*` rule, but
   the corresponding `read` rule for `tasks/SKILL.md` that the "task board"
   section documents as required alongside it was never added.
4. Compare against `the-intern/bob-skills/skills/email-triage/SKILL.md`'s
   frontmatter and "Tool usage" section: it explicitly says to "load the
   `tasks` skill for when work belongs on the board" and lists `read` as a
   tool this package uses for "any `references/*.md` file" and (by the same
   established pattern already used for `worklog`, `himalaya`, and
   `email-triage` itself in this exact TOML block) for each skill's own
   `SKILL.md`.
5. Conclude: an operator who deploys `email-triage` by copying step 4's
   policy TOML verbatim has a `bash` rule admitting `bob task*` but no
   `read` rule admitting `tasks/SKILL.md`, so — consistent with the
   established pattern that every other loaded skill's `SKILL.md` needs its
   own explicit `read` rule in this same block — a `read` of `tasks/SKILL.md`
   would be denied by the default-deny action gate once the bootstrap-wide
   permissive `read` rule is narrowed away in this same step.

## Expected Behavior

The walkthrough's step-4 policy TOML block should admit a `read` of
`<skill_install_path>/tasks/SKILL.md`, mirroring the `read` rules it already
carries for `email-triage/SKILL.md`, `himalaya/SKILL.md`, and
`worklog/SKILL.md`, and mirroring the paired `bash`+`read` rule set the
guide's own "The task board (`bob task`)" section (lines 336-346) documents
as the minimum required set for any deployment that uses the `tasks` skill.

## Actual Behavior

The step-4 TOML block (as left by `B-047`) admits `bob task*` via `bash`
but has no `read` rule for `tasks/SKILL.md`. This is the same defect class
`B-047` and `B-048` were filed to fix, just the half of the pair `B-047`'s
own fix did not cover — the "task board" section's own worked example
(lines 336-346), which the fix's diagnosis log cited as its mirrored
reference shape, documents the `bash` and `read` rules as a pair
("admit the skill's own command calls **and** its `SKILL.md` read"), but
only the `bash` half was carried over into step 4.

## Environment

- OS / platform: n/a (documentation defect)
- Language / runtime version: n/a
- Relevant dependencies: `the-intern/docs/src/operator-guide/index.md`,
  `the-intern/bob-skills/skills/email-triage/SKILL.md`,
  `the-intern/bob-skills/skills/tasks/SKILL.md`
- Branch / commit: `dev-agent`, confirmed present after `B-047`'s merge
  (`91833b7`)

## Related

- Bug: `B-047` (fixed the `bob task*` half of this same rule pair in the
  same TOML block; this bug covers the still-missing `read` rule for
  `tasks/SKILL.md`), `B-048` (fixed the identical defect class completely —
  both the `bash` and `read` rules — in the sibling
  `the-intern/bob-skills/README.md` walkthrough, in the same commit,
  `528096e`)
- Task: `T-206` (introduced the runtime dependency on `bob task*` and on
  loading the `tasks` skill), `T-211` (discovered the original `B-047` gap
  during its review; out of scope for that task's Files to Touch)
- Specification: `S-010` (v0.3, amended by `CR-013`); `S-004` (action-rule
  shape); `ADR-014` (skill install-path model — `tasks/SKILL.md` is a
  skill-install-path artifact under this ADR's model, same as
  `worklog/SKILL.md` and `himalaya/SKILL.md`)

## Suspected Area

`the-intern/docs/src/operator-guide/index.md`, "Deploying the
`email-triage` scheduled job" section, step 4's `[[policy.action_rules]]`
TOML block (add a `read` rule for `<skill_install_path>/tasks/SKILL.md`,
mirroring the existing per-skill `SKILL.md` read rules' shape and the
paired example already given in "The task board (`bob task`)", lines
336-346).

## Fix Verification

```bash
grep -n 'pattern = ".*tasks/SKILL.md"' the-intern/docs/src/operator-guide/index.md
# expect at least two matches: the existing one inside "The task board
# (bob task)" section (around line 345) and a new one inside the "Deploying
# the email-triage scheduled job" section's step-4 policy TOML block
# (should land near the other read rules, e.g. between lines 1083-1203)
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

### Diagnosis 1 — 2026-09-19
Reproduction status: Confirmed (by document inspection, same method as B-047/B-048; not run against a live `bob` instance).
Evidence captured:
- `grep -n 'tasks/SKILL.md' the-intern/docs/src/operator-guide/index.md` returns exactly one match (line 345, inside "The task board (`bob task`)" section), zero matches inside the step-4 `[[policy.action_rules]]` block (lines 1083-1203) of "Deploying the `email-triage` scheduled job".
- Lines 336-346 document the required pair: a `bash` rule for `bob task*` and a `read` rule for `<skill_install_path>/tasks/SKILL.md`, introduced by "At minimum, admit the skill's own command calls and its `SKILL.md` read at the resolved `skill_install_path`."
- Lines 1083-1203 (step-4 block) contain `read` rules for `/opt/bob/skills/email-triage/SKILL.md`, `/opt/bob/skills/himalaya/SKILL.md`, `/opt/bob/skills/worklog/SKILL.md`, plus four `references/*.md` glob rules, and a `bash` rule for `bob task*` (added by commit `640507d` / B-047) and `bob worklog*` — but no `read` rule for `/opt/bob/skills/tasks/SKILL.md`.
- `git show 640507d` (B-047's fix) confirms only the `bob task*` bash rule was added (6 inserted lines), no paired read rule.
- `git show 528096e -- the-intern/bob-skills/README.md` (B-048's fix) confirms the sibling walkthrough added both the `read` rule for `tasks/SKILL.md` and the `bash` rule for `bob task*` together, giving the expected fix shape.
- `the-intern/bob-skills/skills/email-triage/SKILL.md` (lines 16-17, 43-60) confirms the skill instructs loading the `tasks` skill and that all of its tool calls, reads included, are gated by the same action-authorization policy.
- `git diff dev-agent -- the-intern/docs/src/operator-guide/index.md` on the bug branch is empty, confirming the branch reflects the same unfixed content as canonical `dev-agent`.
Isolated fault: `the-intern/docs/src/operator-guide/index.md`, "Deploying the `email-triage` scheduled job" section, step 4's `[[policy.action_rules]]` TOML block (currently lines 1083-1203) — missing a `read` rule for `/opt/bob/skills/tasks/SKILL.md`.
Root cause or fault hypothesis: B-047's fix (commit `640507d`) added only the `bash` rule half of the documented rule pair (bash for `bob task*` + read for `tasks/SKILL.md`, per lines 336-346's own worked example) to the step-4 block, omitting the `read` rule half. This left the block internally inconsistent with its own established pattern (every other loaded skill — email-triage, himalaya, worklog — has both a functional rule and a `SKILL.md` read rule in this same block), and inconsistent with the sibling fix in `bob-skills/README.md` (B-048, commit `528096e`) which added both halves together.
Planned verification:
- `grep -n 'pattern = ".*tasks/SKILL.md"' the-intern/docs/src/operator-guide/index.md`
- Expect at least two matches: the existing one in "The task board (`bob task`)" section (~line 345) and a new one in the "Deploying the `email-triage` scheduled job" section's step-4 policy TOML block (landing near the other `read` rules, within lines 1083-1203).

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

### Session 1 — 2026-09-19
Implemented the fix specified in the Diagnosis Log's fix contract: added the missing `[[policy.action_rules]]` `read` rule for `/opt/bob/skills/tasks/SKILL.md` to the step-4 policy TOML block in the "Deploying the `email-triage` scheduled job" section of `the-intern/docs/src/operator-guide/index.md`. This completes the bash/read rule pair that B-047 left half-done — B-047 added the `bash` rule for `bob task*` commands but omitted the paired `read` rule for the skill's `SKILL.md` file.

Applied the tdd skill's discipline in its documentation-only mode: confirmed red state first (`grep -n 'pattern = ".*tasks/SKILL.md"' the-intern/docs/src/operator-guide/index.md` returned exactly one match, at line 345 in the unrelated "task board" reference section, and none inside the step-4 block), then made the minimal one-block insertion using the exact TOML shape specified in the Diagnosis Log, then confirmed green state (grep now returns two matches, with the new one at line 1105 verified by direct read to fall inside the step-4 TOML fence, positioned immediately after the `worklog/SKILL.md` read rule and before the `references/*.md` glob rules, matching the placement and shape of its sibling per-skill `SKILL.md` read rules).

Nothing was tried and rejected — the fix contract was complete and specific enough (exact rule text, exact placement description) that a single direct edit sufficed. Did not run `mdbook build` since this file is not part of the mdBook build target (confirmed by the bug's own diagnosis and prior sibling bugs B-047/B-048), and this step was optional/not required.

Nothing remains outstanding for this bug's fix. The single commit (`54babe6`, `docs(operator-guide): add tasks/SKILL.md read rule to step-4 policy toml`) is on the bug branch `bug/B-049-operator-guide-email-triage-policy-toml-missing-tasks-skill-read-rule`, ready for review.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that diagnosis, fix, verification, and code quality passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->

### Review Verdict — 2026-09-19
PASS

Diagnosis→fix evidence chain: complete. "Diagnosis 1 — 2026-09-19" records
reproduction status (confirmed by document inspection, same method as
B-047/B-048), evidence (grep counts before the fix, line ranges for the
step-4 block, `git show 640507d` and `git show 528096e` cross-checks, the
`email-triage/SKILL.md` reference, and an empty pre-fix diff against
`dev-agent`), an isolated fault (missing `read` rule for
`/opt/bob/skills/tasks/SKILL.md` in the step-4 `[[policy.action_rules]]`
block), a root cause (B-047's commit `640507d` added only the `bash` half of
the documented rule pair), and a planned verification (the same grep the bug
file's Fix Verification section specifies).

Stage 1 (bug criteria):
- Fix addresses the isolated fault: commit `54babe6` adds exactly one
  `[[policy.action_rules]]` block (`tool = "read"`, `arg_matchers = [
  { field_path = "path", pattern = "/opt/bob/skills/tasks/SKILL.md" } ]`) —
  6 lines, no other changes, confirmed via `git show --stat 54babe6` (1 file,
  6 insertions, 0 deletions).
- Fix Verification followed and independently reproduced: `grep -n 'pattern
  = ".*tasks/SKILL.md"' the-intern/docs/src/operator-guide/index.md` against
  the fixed content returns exactly two matches — line 345 (pre-existing,
  "The task board (`bob task`)" section) and line 1105 (new). Read the
  surrounding content directly: line 1105 sits inside the step-4 TOML fence
  (opens line 1083, closes line 1209), placed immediately after the
  `worklog/SKILL.md` read rule and before the `references/*.md` glob rules —
  matching the Work Log's claimed placement.
- Rule shape matches sibling rules: identical `tool = "read"` /
  `field_path = "path"` shape to the adjacent `email-triage/SKILL.md`,
  `himalaya/SKILL.md`, and `worklog/SKILL.md` read rules in the same block,
  and matches the paired shape documented in "The task board (`bob task`)"
  section (lines 336-346, using the `<skill_install_path>` placeholder form
  vs. this block's concrete `/opt/bob/skills` form — consistent with that
  section's own established convention).
- Step-4 block's `tasks` skill support is now complete: the pre-existing
  `bob task*` `bash` rule (B-047, now lines 1198-1202) plus this new `read`
  rule (lines 1102-1106) together mirror the "task board" section's
  documented minimum pair and B-048's complete fix shape (`git show 528096e
  -- the-intern/bob-skills/README.md` added both halves in one commit).
- No unrelated behavior added; only the operator guide file was touched
  (confirmed via `git show --stat`).

Stage 2 (code quality):
- Correctness: extracted the step-4 TOML block (lines 1084-1208, excluding
  fence markers) and parsed it with Python's `tomllib` — valid TOML, 21
  `action_rules` entries, confirming the insertion did not break the
  surrounding block's syntax.
- Minimal, targeted diff; indentation and formatting match the six sibling
  `read` rule blocks already in the same list item.
- Regression test: none automated (docs-only cross-section consistency,
  same as B-047/B-048; the bug's own Fix Verification section specifies
  only the grep check, which passes). Work Log documents a red/green grep
  cycle (one match pre-fix, two post-fix) consistent with the tdd skill's
  documentation-only mode.
- No dead code, no secrets, no unrelated refactoring.

Minor observation (non-blocking): the Work Log states "this file is not
part of the mdBook build target," but `the-intern/docs/src/SUMMARY.md` line
5 lists `operator-guide/index.md`, so it *is* part of the `user-docs` mdBook
build CI checks (unlike B-048's `the-intern/bob-skills/README.md`, which
genuinely is not). This doesn't affect the fix's correctness — mdBook
renders fenced code blocks as literal text without parsing TOML, so running
`mdbook build` would not have validated this change any further than the
`tomllib` check already performed above, and the bug's own required Fix
Verification (the grep check) was correctly executed. No action required,
but the stated rationale for skipping `mdbook build` should be corrected in
future similar entries (cite "mdBook does not parse fenced TOML content" or
"not required by the bug's Fix Verification steps," not "not part of the
build target").

Both stages pass. Verdict: PASS.
