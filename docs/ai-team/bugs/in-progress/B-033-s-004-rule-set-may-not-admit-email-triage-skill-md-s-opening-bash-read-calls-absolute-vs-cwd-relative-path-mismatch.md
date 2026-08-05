---
id: B-033
title: S-004 rule set may not admit email-triage SKILL.md's opening bash/read 
  calls (absolute vs cwd-relative path mismatch)
severity: high
status: in-progress
created: '2026-08-05'
task: T-139
---

# S-004 rule set may not admit email-triage SKILL.md's opening bash/read calls (absolute vs cwd-relative path mismatch)

## Summary

During B-030's live-validation session, the first live tick issued exactly
2 `bash` calls and 1 `read` call, all three denied by S-004, before the
session ended. Per `SKILL.md:66-104`'s prescribed run order (step 1: a
`bash` existence check on `worklog/<date>.md` plus worklog/reference reads;
step 2: a `bash` envelope-list call; escalation itself is step 3, reached
only after a message is read and classified low-confidence), a run that
stops after 2 bash + 1 read never got past steps 1-2 — the escalation rule
was never evaluated, and these denials carry no signal about the hardened
escalation command shape B-030 exists to validate. They may, however, be a
real signal about a *different* gap: `the-intern/docs/src/operator-guide/index.md:812-845`
writes several `read` rules as absolute `/srv/workspaces/email-skills/…`
paths, while `:901-941` writes several `bash` rules cwd-relative (`cat
config/email-triage.toml*`, `test -f worklog/*`, `cat worklog/*.md*`, `*>>
worklog/*.md*`). A live agent that submits an absolute path for a worklog
`bash` call, or a relative path for a `read` call, would match no rule in
either direction — a deployment-configuration gap of the same class as
B-029.

## Reproduction Status

Status: not yet reproduced (this is a suspected gap identified by static
inspection of a path-convention mismatch, not yet confirmed against the
real `wildmatch` matcher with the exact command/path shapes `SKILL.md`
actually submits)

## Evidence

- Logs / stack traces / failing assertions: the exact denied command text
  from B-030's live session is unrecoverable (see `B-032`, filed
  separately for that instrumentation gap) — this bug's suspicion is based
  on static reading of the rule set's path conventions, not on the
  unrecoverable live denial text itself.
- Screenshots or recordings: n/a
- Failing command or test: n/a — no automated test yet exists for this
  path-convention check.
- First diagnostic step if not yet reproduced: build a static harness
  (reusing the `load_policy_config_from_file` + real `ArgMatcher::matches`
  approach `B-029`/`B-031` already used) and drive it with the exact
  command and path shapes `SKILL.md:30-107` prescribes for steps 1-2, in
  both absolute-path and cwd-relative-path form, against the rule set
  shipped in `operator-guide/index.md`/`email-skills/README.md`.

## Reproduction Steps

1. Extract the exact `bash`/`read` call shapes `SKILL.md` prescribes for
   its opening steps (config read, `worklog/<date>.md` existence check,
   worklog/reference reads, envelope-list call).
2. For each shape, construct both an absolute-path and a cwd-relative-path
   variant.
3. Run each variant through the real S-004 matcher
   (`load_policy_config_from_file` + `ArgMatcher::matches`, `wildmatch`
   2.6.1) against the current shipped rule set in
   `the-intern/docs/src/operator-guide/index.md` and
   `the-intern/email-skills/README.md`.
4. Observe which shapes are admitted and which are denied; a mismatch
   between the path convention `SKILL.md` actually submits and the
   convention the matching rule expects would reproduce this bug.

## Expected Behavior

Every `bash`/`read` call `SKILL.md` prescribes for its opening steps
(before any category-specific action) should be admitted by the shipped
S-004 rule set when deployed exactly per the operator guide — the same
prerequisite already established (and fixed where missing) for the
reply-send and escalation-send steps by `B-029`/`B-030`.

## Actual Behavior

Unknown — not yet confirmed. Static reading of the shipped rule set shows
an absolute-vs-cwd-relative path convention mismatch between the `read`
rules and several `bash` rules covering the same opening-step files, which
is consistent with (but not proven to be the cause of) the 3 denials
observed in B-030's live session.

## Environment

- OS / platform: n/a until statically verified
- Language / runtime version: n/a
- Relevant dependencies: `bob` S-004 policy-control action gate
  (`wildmatch` 2.6.1), `email-skills` package
- Branch / commit: `dev-agent`; suspected during B-030's live-validation
  diagnosis session, 2026-08-05

## Related

- Bug: `B-030` (the live-validation run whose early denials prompted this
  suspicion), `B-029` (same class of defect — shipped rule set not
  admitting a call the shipped skill prescribes), `B-032` (tracing gap that
  prevented directly confirming this from B-030's actual denied command
  text)
- Task: `T-139` (original happy-path validation)
- Specification: `S-010-email-skills-for-pi-agent-himalaya-cli-reference-and-classification-driven-triage.md`

## Suspected Area

`the-intern/docs/src/operator-guide/index.md` and
`the-intern/email-skills/README.md` (S-004 action-rule lists — the `read`
vs `bash` path-convention consistency for opening-step file access), cross-
checked against
`the-intern/email-skills/.pi/skills/email-triage/SKILL.md:66-104` (the
exact command/path shapes those opening steps prescribe).

## Fix Verification

```bash
# Static: run the wildmatch/load_policy_config_from_file harness against
# every SKILL.md-prescribed opening-step command/path shape (both absolute
# and cwd-relative forms) and confirm each is admitted by exactly the
# convention SKILL.md actually submits, with no gap.
#
# Live (once B-030's provider-quota block clears): re-run B-030's live
# validation and confirm the opening ticks (config/worklog reads, envelope
# list) are admitted without denial before the run reaches the
# escalation-send step.
```

## Diagnosis Log

### Diagnosis 1 — 2026-08-05

Reproduction status: **not reproduced.** Every `bash`/`read` call shape
`SKILL.md`'s opening steps (config read, `worklog/<date>.md` existence
check, worklog reconciliation reads, envelope-list) actually prescribe is
admitted by both `the-intern/docs/src/operator-guide/index.md` and
`the-intern/email-skills/README.md`'s current shipped S-004 rule lists, in
exactly the path convention `SKILL.md` uses for each.

Evidence captured:
- `SKILL.md:30-104` and `references/worklog.md`: confirmed the exact
  opening-step shapes and prescribed path convention. Worklog content reads
  go through the `read` tool via the job's own cwd-relative path (the only
  such explicit qualifier in the doc); config-read and worklog-existence
  `bash` calls are also written cwd-relative. Reference-file reads carry no
  such qualifier (fixed skill-directory/absolute resolution).
- `operator-guide/index.md:796-965` and `README.md:130-298` read in full
  (not just the `812-845` window this bug's own filing cited): both ship an
  identical `bash` rule set (cwd-relative throughout) and a `read` rule set
  that includes **both** an absolute rule
  (`/srv/workspaces/email-skills/worklog/*.md` /
  `/abs/workspace/worklog/*.md`) **and** a cwd-relative rule
  (`worklog/*.md`) for worklog files.
- `git log -p -S'{ field_path = "path", pattern = "worklog/*.md" }' --
  the-intern/email-skills/README.md` and `git show 28d4e1a`: traced the
  cwd-relative worklog `read` rule's origin to **T-140 Session 6
  (2026-08-03)**, which diagnosed and fixed exactly this class of gap live
  ("the carried-forward worklog open was read through a relative
  `worklog/*.md` path... The validated allow-rule set now includes that
  relative `read` matcher"), predating this bug's filing.
- Static harness (temporary, deleted after use): extracted the actual
  shipped `[[policy.action_rules]]` TOML block verbatim from both doc
  files, loaded it through the real `load_policy_config_from_file` +
  `RulesetSnapshot::from_config`, and drove it through the real
  `PolicyEngine::evaluate_action` (`wildmatch` 2.6.1, pinned in
  `Cargo.lock`) with the exact SKILL.md-prescribed opening-step shapes.
  2/2 checks passed: `cat config/email-triage.toml` → `allow=true`; `test
  -f worklog/2026-08-05.md` → `allow=true`; cwd-relative `read` on
  `worklog/2026-08-04.md` → `allow=true`; absolute `read` on
  `/srv/workspaces/email-skills/worklog/2026-08-04.md` → `allow=true`;
  `read` on the skill's own absolute reference path → `allow=true`;
  `himalaya envelope list not flag seen` → `allow=true`.

Isolated fault: none present in the current shipped rule set.

Root cause or fault hypothesis: **hypothesis refuted, not confirmed.** The
absolute-vs-cwd-relative mismatch this bug suspected was a real defect
once, but it was already found and fixed by T-140 (commit `28d4e1a`,
2026-08-03) before this bug was filed. This bug's own static-inspection
evidence cited only `operator-guide/index.md:812-845` (the block of
absolute-path `read` rules), which happens to end 2 lines before the
cwd-relative `worklog/*.md` `read` rule at lines 847-851 — an artifact of
where the quoted line range was cut, not of the actual shipped rule set,
which does include that rule.

Planned verification: none required — the static check this bug's Fix
Verification specifies (run the wildmatch/`load_policy_config_from_file`
harness against every SKILL.md-prescribed opening-step shape, confirm each
is admitted) has been run and passed against the real shipped text. No
code or doc change is needed. Recommend closing as "not reproduced —
already fixed by T-140/commit 28d4e1a" rather than an implementation
cycle. Durable regression coverage against future doc drift, if wanted, is
a separate follow-up task, not part of this bug.

## Work Log

### Session 1 — 2026-08-05

Diagnosis (recorded on dev-agent, commit c953051) found no defect: the
S-004 rule set's absolute-vs-cwd-relative path mismatch this bug suspected
does not exist in the current shipped rule set. Every bash/read call shape
SKILL.md's opening steps prescribe (config read, worklog/<date>.md
existence check, worklog reconciliation reads, envelope-list) is admitted
by both the-intern/docs/src/operator-guide/index.md and
the-intern/email-skills/README.md, in exactly the path convention SKILL.md
uses for each — confirmed against the real wildmatch/load_policy_config_from_file
matcher, not just by inspection. The one real instance of this defect class
(a cwd-relative worklog read call denied because only an absolute read
rule existed) was already found and fixed live during T-140, commit
28d4e1a, on 2026-08-03 — before this bug was even filed. B-033's own filed
evidence quoted only operator-guide/index.md lines 812-845, a window that
stops just short of the cwd-relative worklog read rule at lines 847-851,
which is what produced the false-positive suspicion.

No code or doc change was made on this branch this cycle: there is no
fault to fix, so there is nothing to implement, and per the diagnosis's
own recommendation the durable-regression-test idea was intentionally left
out of scope as a separate follow-up rather than bundled in here. The
branch remains byte-identical to dev-agent aside from the bug-lifecycle
file itself.

Recommend the Reviewer verify the Diagnosis Log's evidence chain (the
extracted-live wildmatch harness results and the T-140/commit 28d4e1a
cross-reference) and record a PASS verdict of "no fix needed — already
resolved," rather than expecting a source diff to review. Recommend the
bug-fix loop then move B-033 directly to resolved/ without an integration
merge, since no branch content needs merging.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that diagnosis, fix, verification, and code quality passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->

### Review Verdict — 2026-08-05
PASS

This closes as **not reproduced — already resolved**, with no branch content to
merge. `bug/B-033-...` carries zero source/doc diff against `dev-agent`
(`git diff dev-agent...HEAD` is empty; the only difference is that `dev-agent`
has since gained the diagnosis and work-log lifecycle commits that post-date
the branch cut). The bug-fix loop should move B-033 straight to `resolved/`
without invoking the `integrate` skill.

Evidence-chain and diagnosis-quality checks (all independently re-verified,
not taken on the Developer's word):

- **Both doc files ship the cwd-relative worklog `read` rule.** Read
  `the-intern/email-skills/README.md` and
  `the-intern/docs/src/operator-guide/index.md` directly off `dev-agent`:
  both ship an identical `[[policy.action_rules]]` block that includes
  **both** an absolute `read` rule
  (`/srv/workspaces/email-skills/worklog/*.md` /
  `/abs/workspace/worklog/*.md`) **and** a cwd-relative `read` rule
  (`worklog/*.md`) for worklog files, and every `bash` rule covering the
  same opening-step files (`cat config/email-triage.toml*`, `test -f
  worklog/*`, `*find worklog*`, `*ls worklog*`, `cat worklog/*.md*`, `*>>
  worklog/*.md*`) is cwd-relative throughout. Confirmed by reading the full
  ranges (`README.md:130-298`, `operator-guide/index.md:796-965`), not just
  the window the bug itself cited.
- **The cwd-relative rule traces to T-140, predating this bug's filing.**
  `git log -S'pattern = "worklog/*.md" }' -- the-intern/email-skills/README.md`
  isolates exactly one commit, `28d4e1a` ("docs(email): clarify triage
  runtime rules", 2026-08-03 15:39). `git show 28d4e1a` confirms the diff
  turns the second worklog `read` rule from an absolute path into
  `worklog/*.md`. `28d4e1a` is an ancestor of `dfe409b` ("chore(tasks): merge
  T-140 validate escalation continuity paths"), and T-140's own Session 6
  work-log entry independently corroborates committing `28d4e1a` "to
  document and align the cwd-relative `read.path = \"worklog/*.md\"`
  reconciliation surface" after a live run hit exactly that denial. All of
  this predates B-033's 2026-08-05 filing date. Separately,
  `operator-guide/index.md` did not exist until commit `83e4c2f` (2026-08-03
  20:42, after `28d4e1a`), so that file was created already carrying the
  fixed rule set — it never shipped the gap.
- **Every SKILL.md-prescribed opening-step shape is admitted, in the
  convention SKILL.md actually uses.** Read `SKILL.md`'s "Tool usage"
  section and steps 1-2 (lines ~30-104) plus `references/worklog.md` in
  full to enumerate the exact shapes: `test -f worklog/<date>.md` (bash,
  cwd-relative), backward-walking `worklog/*.md` via listing (bash,
  cwd-relative) and opening each candidate's contents (`read`,
  cwd-relative — the specific shape this bug worried about), `cat
  config/email-triage.toml` (bash, cwd-relative), and the unseen-envelope
  listing (bash). Rather than treat the Diagnosis Log's harness description
  as fact, I reconstructed it independently: a temporary integration test
  in `policy-control` (`tests/b033_review_harness.rs`, deleted after the
  run — no trace left on any branch) loaded the exact TOML block shipped in
  `README.md` through `toml::from_str` + `RulesetSnapshot::from_config` and
  drove it through the real `PolicyEngine::evaluate_action`
  (`wildmatch` 2.6.1, confirmed pinned in `Cargo.lock`, matching the
  Diagnosis Log's claim). All 7 SKILL.md-prescribed shapes returned
  `allow=true`, including the cwd-relative `read` on `worklog/2026-08-04.md`
  and on an older carried-forward file `worklog/2026-07-29.md`. A negative
  control (an absolute-path `bash` worklog call, a shape SKILL.md never
  submits) correctly returned `allow=false`, confirming the harness
  discriminates real gaps rather than rubber-stamping everything.
- **The originally-filed evidence window is a real truncation artifact, not
  a rationalization.** `operator-guide/index.md` lines 812-845 (the range
  B-033's own filing cited) contain only the five absolute-path `read`
  rules plus the absolute worklog rule, ending at line 845/`]` on line 845 —
  the cwd-relative `worklog/*.md` rule sits immediately after, at lines
  847-851. Confirmed by direct inspection with line numbers; the cited
  range is exactly two lines short of the rule that would have refuted the
  suspicion.

Stage 1 (bug criteria): the Diagnosis Log records reproduction status ("not
reproduced"), captured evidence, an isolated-fault statement ("none present"),
and a root-cause disposition ("hypothesis refuted, not confirmed") — a
complete, evidenced fix contract for the not-reproduced case. The Work Log
correctly reports no code/doc change was made, consistent with there being no
fault. Nothing outside the bug's scope was touched.

Stage 2 (code quality): not applicable in the usual sense — there is no diff
to review. The Bug Fix Addendum criteria (minimal fix, matching regression
test) are vacuously satisfied by the absence of any fix, and the decision to
leave a durable regression-test-against-doc-drift out of scope as a separate
follow-up (rather than bundling it into this bug) is reasonable and correctly
flagged as such.

No further action needed on this bug; recommend closing to `resolved/` as
"not reproduced — already fixed by T-140/commit 28d4e1a," per the Developer's
own recommendation.
