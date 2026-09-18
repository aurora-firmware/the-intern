---
id: B-047
title: Operator guide's email-triage deployment policy TOML omits the bob task* 
  rule now required by every run
severity: high
status: open
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
