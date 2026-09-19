---
id: B-047
title: Operator guide's email-triage deployment policy TOML omits the bob task* 
  rule now required by every run
severity: high
status: in-progress
created: '2026-09-18'
task: T-211
---

# Operator guide's email-triage deployment policy TOML omits the bob task* rule now required by every run

## Summary

`the-intern/docs/src/operator-guide/index.md`'s "Deploying the `email-triage`
scheduled job" walkthrough (step 4) gives a concrete `[[policy.action_rules]]`
TOML block for an operator to literally replace their workspace's bootstrap
policy with. That block admits `bob worklog*` but never admits `bob task*`.
Since `T-206` (merged, per `S-010` v0.3 / `CR-013`), `email-triage`'s
`SKILL.md` step 1 now calls `bob task list` unconditionally at the start of
every single run, and files/updates `bob task` entries for every escalation
or S-004-blocked action. An operator who deploys the job by following this
walkthrough's literal step-4 policy would have every run's first action
denied by bob's default-deny action-authorization gate, because no rule in
the printed TOML block matches a `bob task*` command.

## Reproduction Status

Status: confirmed (by document inspection; not run against a live `bob`
instance)

The gap is confirmed by reading the walkthrough's own policy TOML block and
comparing it against `email-triage`'s actual, reviewed runtime behavior
(`T-206`, `PASS`, `dev-agent`) and the guide's own policy-gate model
("Policy basics": "an action is admitted only when an
`[[policy.action_rules]]` rule matches it, and an absent rule denies by
default").

## Evidence

- Logs / stack traces / failing assertions: none captured live; this is a
  static documentation-accuracy defect, discovered during `T-211`'s code
  review while cross-checking the operator guide's corrected "Cross-day
  continuity" paragraph against `T-206`'s actual merged behavior.
- Screenshots or recordings: none.
- Failing command or test: none (docs-only defect; no automated test covers
  this cross-file consistency).
- First diagnostic step if not yet reproduced: n/a — already confirmed by
  inspection, see Reproduction Steps.

## Reproduction Steps

1. Open `the-intern/docs/src/operator-guide/index.md`, section "Deploying
   the `email-triage` scheduled job", step 4 ("Replace the bootstrap-wide
   action rules..."). Note the full `[[policy.action_rules]]` TOML block
   printed there: it contains one `bash` rule for `bob worklog*` but no rule
   matching `bob task*`.
2. Compare against the same file's own "The task board (`bob task`)"
   section, which documents that `tasks` skill calls (`bob task list`,
   `bob task status`, etc.) require their own `bob task*` `[[policy.action_rules]]`
   rule, admitted separately.
3. Compare against `the-intern/bob-skills/skills/email-triage/SKILL.md`
   (rewritten by `T-206`, `PASS` on `dev-agent`): step 1 of its four-step
   loop calls `bob task list` unconditionally on every run, and steps 1/3/4
   call `bob task status`/file new tasks.
4. Conclude: an operator who deploys `email-triage` by copying step 4's
   policy TOML verbatim (as the walkthrough instructs, "replace those broad
   rules with the narrower rules below") has no admitting rule for any
   `bob task*` call, so every scheduled run's first step is denied by the
   default-deny gate.

## Expected Behavior

The walkthrough's step-4 policy TOML block should admit every command the
deployed job's skill actually issues, including the `bob task*` calls
`email-triage`'s `SKILL.md` now makes on every run (per `T-206`), so that
following the guide's steps produces a working deployment.

## Actual Behavior

The step-4 TOML block admits `bob worklog*` but has no rule for `bob task*`.
Any `bob task list`/`bob task status`/`bob task new` call the deployed job's
session attempts is denied by the policy engine's default-deny gate, because
`bob init`'s permissive bootstrap policy was already replaced with this
narrower set in the same step. `email-triage`'s own "Cross-day continuity"
paragraph (rewritten by `T-211`) now explicitly says the `bob task*` rule
"is required for this workflow too, not only for `bob task` users
generally" — but the walkthrough's own concrete policy example, a few
hundred lines earlier in the same section, does not include it.

## Environment

- OS / platform: n/a (documentation defect)
- Language / runtime version: n/a
- Relevant dependencies: `the-intern/docs` (mdBook user manual),
  `the-intern/bob-skills/skills/email-triage/SKILL.md`
- Branch / commit: `dev-agent`, confirmed present after `T-206`'s merge and
  still present as of `T-211`'s `task/T-211-...` branch (`0616bfa`)

## Related

- Task: `T-206` (introduced the runtime dependency on `bob task*`),
  `T-211` (discovered during its review; corrected nearby prose but did not
  touch the step-4 policy TOML, which was outside its Files to Touch and
  Acceptance Criteria)
- Specification: `S-010` (v0.3, amended by `CR-013`)

## Suspected Area

`the-intern/docs/src/operator-guide/index.md`, "Deploying the
`email-triage` scheduled job" section, step 4's `[[policy.action_rules]]`
TOML block (add a `bash` rule matching `bob task*`, mirroring the existing
`bob worklog*` rule's shape, following the pattern already documented in
"The task board (`bob task`)").

## Fix Verification

```bash
grep -n 'pattern = "bob task\*"' the-intern/docs/src/operator-guide/index.md
# expect a match inside the "Deploying the email-triage scheduled job" section's
# step-4 policy TOML block, not only inside "The task board (bob task)" section
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
Reproduction status: Confirmed, by direct document inspection (not a live-`bob` run — matches the bug's own reported reproduction method; no runtime reproduction is possible for this class of defect since the defect is an omission in a documentation walkthrough, not executable code).
Evidence captured:
- `sed -n '1083,1197p' the-intern/docs/src/operator-guide/index.md | grep -in "task"` → no output. The full step-4 `[[policy.action_rules]]` TOML block (the block the walkthrough instructs operators to copy over their bootstrap policy) contains zero mentions of "task" in any form, confirming no rule matches `bob task*`.
- `grep -n 'pattern = "bob task\*"' the-intern/docs/src/operator-guide/index.md` → single match at line 339, inside the separate "The task board (`bob task`)" section (lines 309-347), not inside the step-4 block (lines 1083-1197). Note: the bug's own Fix Verification grep command, run as literally written, currently returns exit 0 / a match at line 339 even though the defect is present — the command alone cannot distinguish "matched anywhere in the file" from "matched inside the step-4 block", so verification of the fix must also confirm the match's line number falls within the step-4 block, not rely on grep exit status alone.
- Confirmed the correct rule shape to mirror, at lines 336-340: `tool = "bash"`, `arg_matchers = [{ field_path = "command", pattern = "bob task*" }]`, immediately followed by a `read` rule admitting `<skill_install_path>/tasks/SKILL.md` — same shape as the existing `bob worklog*` rule at lines 1192-1196.
- `grep -n "bob task" the-intern/bob-skills/skills/email-triage/SKILL.md` → 15 matches, including line 90 ("Call `bob task list`") as an unconditional step in every run's loop, and further `bob task status`/`bob task new` calls on escalation and S-004-blocked paths (lines 65-69, 113, 166, 178, 210, 244) — confirms the runtime dependency T-206 introduced that the step-4 block fails to admit.
- `git log --oneline -3 -- the-intern/docs/src/operator-guide/index.md` → most recent commit `0616bfa docs(operator-guide): correct worklog cross-day continuity prose` (the T-211 commit referenced in the bug's Environment section), confirming this file's last touch did not add the missing rule.
- `git log -1 -- the-intern/bob-skills/skills/email-triage/SKILL.md` → `1ecff4e docs(email-triage): move continuity from worklog carry-forward to bob task`, consistent with T-206/T-211's documented history.
- `git status --short` → clean before and after diagnosis; no production files modified.
Isolated fault: `the-intern/docs/src/operator-guide/index.md`, "Deploying the `email-triage` scheduled job" section, step 4's `[[policy.action_rules]]` TOML code block (lines 1083-1197). Missing rule: a `bash` rule matching `command` field pattern `bob task*`.
Root cause or fault hypothesis: Documentation-synchronization gap. T-206 (merged, per S-010 v0.3 / CR-013) added an unconditional `bob task list` call plus escalation-path `bob task status`/`bob task new` calls to `email-triage`'s `SKILL.md`, creating a new runtime dependency on a `bob task*` policy-admission rule for every deployed run. The step-4 walkthrough's concrete policy example was never updated to include this rule — T-211 explicitly left it untouched per its Files to Touch/Acceptance Criteria, only correcting nearby "Cross-day continuity" prose. No automated test covers cross-file/cross-section documentation consistency between the SKILL.md's actual command usage and the operator guide's copy-paste policy block, so the gap was not caught by CI.
Planned verification:
- `sed -n '1083,1197p' the-intern/docs/src/operator-guide/index.md | grep -n 'pattern = "bob task\*"'` should return a match once the fix lands (currently returns nothing, confirming the pre-fix state).
- Manually confirm the added rule sits within the step-4 block (between the existing `read` rules and the closing code fence, alongside the `bob worklog*` rule) and mirrors the exact shape at lines 336-340 (`tool = "bash"`, `field_path = "command"`, `pattern = "bob task*"`).
- Re-run `mdbook build the-intern/docs` (the `user-docs` CI check) to confirm the doc still builds cleanly after the edit.

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
