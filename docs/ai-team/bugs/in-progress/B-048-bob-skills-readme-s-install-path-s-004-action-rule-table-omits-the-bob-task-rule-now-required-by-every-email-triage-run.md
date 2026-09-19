---
id: B-048
title: bob-skills README's install-path S-004 action-rule table omits the bob 
  task* rule now required by every email-triage run
severity: high
status: in-progress
created: '2026-09-18'
task: T-212
---

# bob-skills README's install-path S-004 action-rule table omits the bob task* rule now required by every email-triage run

## Summary

`the-intern/bob-skills/README.md`'s "Verified S-004 action rules for the
install-path model" section gives a concrete `[[policy.action_rules]]` TOML
block for deploying `email-triage` under the skill install-path model. That
block admits `bob worklog*` (and read rules for each skill's `SKILL.md`/
`references/*.md`, including `worklog/`) but never admits `bob task*`, and
never admits a read rule for `/abs/skill-install-path/tasks/SKILL.md`
either. Since `T-206` (merged, per `S-010` v0.3 / `CR-013`), `email-triage`'s
`SKILL.md` step 1 now calls `bob task list` unconditionally at the start of
every run, and files/updates `bob task` entries for every escalation or
S-004-blocked action. An operator who deploys the job by copying this
README's rule set verbatim would have every run's first action denied by
`bob`'s default-deny action-authorization gate. This is the same defect
class as `B-047` (filed against the operator guide's equivalent walkthrough
TOML), but in this package's own README, which is a separate file with its
own separate policy example.

## Reproduction Status

Status: confirmed (by document inspection; not run against a live `bob`
instance)

The gap is confirmed by reading this README's own policy TOML block and
comparing it against `email-triage`'s actual, reviewed runtime behavior
(`T-206`, `PASS`, `dev-agent`) and the documented S-004 policy-gate model
(an action is admitted only when an `[[policy.action_rules]]` rule matches
it; an absent rule denies by default).

## Evidence

- Logs / stack traces / failing assertions: none captured live; this is a
  static documentation-accuracy defect, discovered during `T-212`'s work
  correcting this same README's worklog continuity prose, while
  cross-checking the "Verified S-004 action rules for the install-path
  model" table against `email-triage`'s actual merged behavior.
- Screenshots or recordings: none.
- Failing command or test: none (docs-only defect; no automated test covers
  this cross-file consistency). `grep -c 'pattern = "bob task' the-intern/bob-skills/README.md`
  returns `0` against the table's own TOML block (the only two `bob task`
  mentions in the whole file are prose, not TOML rules — see Reproduction
  Steps).
- First diagnostic step if not yet reproduced: n/a — already confirmed by
  inspection, see Reproduction Steps.

## Reproduction Steps

1. Open `the-intern/bob-skills/README.md`, section "Verified S-004 action
   rules for the install-path model". Read the full
   `[[policy.action_rules]]` TOML block printed there (19 rules): 7 `read`
   rules for each skill's `SKILL.md`/`references/*.md` (including
   `/abs/skill-install-path/worklog/SKILL.md` and
   `.../worklog/references/*.md`, but none for `tasks/SKILL.md`), and 12
   `bash` rules for `himalaya*`/`cat config/email-triage.toml*`/
   `bob worklog*`. No rule matches `bob task*`, and no `read` rule matches
   `/abs/skill-install-path/tasks/SKILL.md`.
2. Compare against `the-intern/bob-skills/skills/email-triage/SKILL.md`
   (rewritten by `T-206`, `PASS` on `dev-agent`): step 1 of its four-step
   loop calls `bob task list` unconditionally on every run, board resolved
   explicitly to the job's own working directory, and steps 1/3/4 call
   `bob task status`/file new tasks via the `tasks` skill
   (`the-intern/bob-skills/skills/tasks/SKILL.md`).
3. Note that this same README only ever *mentions* `bob task*` in prose (in
   the "worklog skill's rules now follow the `bob worklog` command"
   paragraph, comparing the `bob worklog*` matcher's shape to it, and in the
   "Verified S-004 action rules" prose corrected by `T-212`) — it never adds
   an actual `[[policy.action_rules]]` entry for it to the table itself, nor
   a `read` rule for the `tasks` skill's own `SKILL.md`.
4. Conclude: an operator who deploys `email-triage` by copying this
   README's install-path rule set verbatim has no admitting rule for any
   `bob task*` call or for reading the `tasks` skill's `SKILL.md`, so every
   scheduled run's first step (and every `pi`-side skill-discovery read of
   `tasks/SKILL.md`) is denied by the default-deny gate.

## Expected Behavior

The "Verified S-004 action rules for the install-path model" TOML block
should admit every command and skill-content read the deployed job's
session actually issues, including a `read` rule for
`/abs/skill-install-path/tasks/SKILL.md` and a `bash` rule matching
`bob task*` (mirroring the existing `bob worklog*` rule's shape), so that
following this README's steps produces a working deployment.

## Actual Behavior

The table admits reads for `email-triage`, `himalaya`, and `worklog`
`SKILL.md`/`references/*.md`, plus `bob worklog*`, but has no rule for
`tasks/SKILL.md` or `bob task*`. Any `bob task list`/`bob task status`/
`bob task new` call, or any `read` of the `tasks` skill's own `SKILL.md`,
that the deployed job's session attempts is denied by the policy engine's
default-deny gate.

## Environment

- OS / platform: n/a (documentation defect)
- Language / runtime version: n/a
- Relevant dependencies: `the-intern/bob-skills/README.md`,
  `the-intern/bob-skills/skills/email-triage/SKILL.md`,
  `the-intern/bob-skills/skills/tasks/SKILL.md`
- Branch / commit: `dev-agent`, confirmed present after `T-206`'s merge and
  still present as of `T-212`'s `task/T-212-...` branch

## Related

- Task: `T-206` (introduced the runtime dependency on `bob task*` and on
  reading the `tasks` skill), `T-212` (discovered during its work correcting
  this same README's worklog continuity prose; corrected nearby prose but
  did not touch the install-path policy TOML, which was outside its Files
  to Touch and Acceptance Criteria)
- Bug: `B-047` (identical defect class, already filed against the operator
  guide's own equivalent walkthrough TOML — this bug covers the separate
  policy example in this package's own README)
- Specification: `S-010` (v0.3, amended by `CR-013`)

## Suspected Area

`the-intern/bob-skills/README.md`, "Verified S-004 action rules for the
install-path model" section's `[[policy.action_rules]]` TOML block (add a
`read` rule for `/abs/skill-install-path/tasks/SKILL.md`, mirroring the
existing per-skill `SKILL.md` read rules' shape, and a `bash` rule matching
`bob task*`, mirroring the existing `bob worklog*` rule's shape).

## Fix Verification

```bash
grep -n 'pattern = "bob task\*"' the-intern/bob-skills/README.md
grep -n 'pattern = "/abs/skill-install-path/tasks/SKILL.md"' the-intern/bob-skills/README.md
# expect one match each, both inside the "Verified S-004 action rules for
# the install-path model" section's policy.action_rules TOML block
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
Reproduction status: Confirmed (by document inspection, matching the bug's own stated reproduction method — this is a static docs-accuracy defect with no runnable test surface).
Evidence captured:
- `grep -c 'pattern = "bob task' the-intern/bob-skills/README.md` → 0 (whole file, not just the TOML block).
- `grep -n 'pattern = "bob task\*"' the-intern/bob-skills/README.md` → no match (exit 1).
- `grep -n 'pattern = "/abs/skill-install-path/tasks/SKILL.md"' the-intern/bob-skills/README.md` → no match (exit 1).
- The "Verified S-004 action rules for the install-path model" TOML block (README.md lines 224-336) contains exactly 19 `[[policy.action_rules]]` entries — 7 `read` (email-triage/himalaya/worklog `SKILL.md` + `references/*.md`, none for `tasks/SKILL.md`) and 12 `bash` (himalaya*/cat config*/bob worklog*, none for `bob task*`) — confirming both pieces the bug's Summary/Expected Behavior sections call out are absent from the table.
- `grep -n "tasks/SKILL.md" the-intern/bob-skills/README.md` → zero mentions anywhere in the file (not even in prose), so the missing read rule has no partial coverage at all.
- `grep -n "bob task" the-intern/bob-skills/README.md` → only prose mentions (lines 82, 352, 433-436); notably lines 433-436 assert "the `bob task*` rule noted above ... is required for this workflow too" even though no such rule exists anywhere above it in the document — the README's own prose contradicts its TOML block, corroborating the gap.
- `git log --oneline -- the-intern/bob-skills/README.md` shows the contradictory prose was introduced by `ce3f7f7` (docs(bob-skills): correct worklog cross-day continuity prose, T-212), which per the bug's Related section corrected nearby prose but was out of scope to touch the policy TOML.
- `grep -rn "bob-skills/README.md" the-intern/service --include="*.rs"` → no matches; no automated test exercises this README's TOML content, consistent with the bug's Evidence section stating this is docs-only with no CI coverage.
Isolated fault: `the-intern/bob-skills/README.md`, "Verified S-004 action rules for the install-path model" section, `[[policy.action_rules]]` TOML block (lines 224-336). The block is missing (1) a `bash` rule with `pattern = "bob task*"` and (2) a `read` rule with `pattern = "/abs/skill-install-path/tasks/SKILL.md"`.
Root cause or fault hypothesis: Documentation drift — the TOML block was last substantively edited by `c562793` (migrate worklog action rules to bob worklog) and then referenced by name in continuity prose added by `ce3f7f7` (T-212) as though a `bob task*` rule already existed in it ("the `bob task*` rule noted above"), but neither commit actually added the rule to the TOML block or added any read rule for `tasks/SKILL.md`. Neither commit's task scope (per T-212's Related-section note) included updating the install-path policy TOML, so the runtime dependency T-206 introduced (email-triage's SKILL.md step 1 calling `bob task list` unconditionally, plus task-board escalation continuity) was never reflected back into this README's example policy.
Planned verification:
- `grep -n 'pattern = "bob task\*"' the-intern/bob-skills/README.md`
- `grep -n 'pattern = "/abs/skill-install-path/tasks/SKILL.md"' the-intern/bob-skills/README.md`
- Expect one match each, both inside the "Verified S-004 action rules for the install-path model" section's policy.action_rules TOML block (lines 224-336), mirroring the existing `bob worklog*` bash rule's shape and the existing per-skill SKILL.md read rules' shape respectively.

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
