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
