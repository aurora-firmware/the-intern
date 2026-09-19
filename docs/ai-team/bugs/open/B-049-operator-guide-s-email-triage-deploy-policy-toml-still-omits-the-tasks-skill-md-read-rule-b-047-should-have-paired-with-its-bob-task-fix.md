---
id: B-049
title: Operator guide's email-triage deploy policy TOML still omits the 
  tasks/SKILL.md read rule B-047 should have paired with its bob task* fix
severity: high
status: open
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
