---
id: T-164
title: Re-validate the skill install-path model end to end for scheduled and 
  interactive sessions
status: pending
priority: high
assigned-role: developer
created: '2026-08-09'
spec: S-011
---

# Re-validate the skill install-path model end to end for scheduled and interactive sessions

## Description

S-011 Implementation Order Phase 5. Every earlier task builds a piece of the
install-path model in isolation; none of them proves the finished model
actually works end to end. S-011's Purpose states success is confirmed when
"a session started from a directory containing no skill files can still
perform a skilled task" and "a scheduled run and an interactive session both
journal through the same worklog skill." Run the same kind of live
validation T-139/T-140 ran for the old per-workspace model, against the new
one: install the packaged skill content once at the resolved
`skill_install_path`, then exercise both a scheduled job and an interactive
`bob chat` session from working directories that hold no skill files of
their own, confirming both actually use the installed skills. Record the
result in `the-intern/email-skills/README.md`'s validation section (the
T-139/T-140 precedent for where this evidence lives), correcting anything
T-161/T-162 documented that this live run contradicts.

## Acceptance Criteria

AC-1: The system shall confirm skills are installed once at the resolved
      `skill_install_path` (default or configured), with no per-workspace
      copy present anywhere in the validation run.
AC-2: WHEN a scheduled job whose `--cwd` contains no skill files fires THE
      SYSTEM SHALL still let the pi-agent session perform a skilled
      email-triage action (classify and act on a real test message) and
      journal that action through the `worklog` skill into the job's own
      working directory, proving skill delivery is independent of the job's
      working directory while diary state stays correctly `--cwd`-scoped.
AC-3: WHEN an interactive `bob chat` session is started from a working
      directory unrelated to any skill deployment THE SYSTEM SHALL let that
      session journal a worklog entry through the `worklog` skill.
AC-4: The system shall confirm a single stable action-rule set scoped to the
      install path (not per-workspace) admits every tool call exercised by
      both validation runs above, with no denied call worked around.

## Dependencies

- `T-161` — operator guide/quickstart already updated to the model being
  validated
- `T-162` — email-skills README already updated to the model being
  validated

## Files to Touch

- `the-intern/email-skills/README.md` — record the live validation result;
  correct anything T-162 documented that this run contradicts
- `the-intern/docs/src/operator-guide/index.md` — correction only, and only
  where the live run contradicts what T-161 documented (Gate 2 correction,
  2026-08-09: the Description requires correcting T-161's output, which
  lives in these files, so omitting them forces a Files-to-Touch boundary
  escalation)
- `the-intern/docs/src/quickstart/index.md` — same, correction only
- `the-intern/docs/test_operator_guide_email_triage_trust.sh` — same,
  correction only, if a corrected deployment section changes its assertions

## Verification

Manual live validation (no automated command; matches the T-139/T-140
precedent):

```
1. Confirm skill_install_path resolves and contains himalaya/email-triage/worklog.
2. Fire a scheduled job with --cwd containing no skill files; confirm the
   triage action succeeds and is admitted by the install-path-scoped rules.
3. Start `bob chat` from an unrelated directory; confirm a worklog entry is
   written through the worklog skill.
4. Record the exact rule set and commands exercised in README.md.
```

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
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->
