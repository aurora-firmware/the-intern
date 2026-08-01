---
id: T-140
title: Validate the escalation, block, and next-run continuity paths
status: pending  # pending | in-progress | completed | blocked
priority: high  # critical | high | medium | low
assigned-role: developer
created: '2026-08-01'
spec: S-010
---

# Validate the escalation, block, and next-run continuity paths

## Description

S-010 Phase 4, second half: the happy path is covered by T-139; this task proves
the three behaviours S-010's Design Principles hinge on, using the same deployed
owner-only workspace and live scheduled job.

1. **Escalation.** Feed the mailbox a message the taxonomy cannot classify
   confidently. Exactly one escalation email must reach the configured manager
   address, and the message must be carried forward as an open worklog item —
   not acted on.
2. **S-004 block.** Remove or narrow **only** the himalaya allow rule recorded by
   T-139 — leave the worklog read/append rule in force, or the skill has no way
   to record anything and the test proves nothing. Reload policy and fire again.
   The blocked call must be recorded as an open worklog item; the message must
   not be acted on autonomously as a fallback, and the block must not be
   silently dropped.
3. **Skipped-tick continuity.** Simulate skipped days by leaving a dated worklog
   file holding open items and no worklog for the days since. The next executed
   run's first-run reconciliation must pick up those carried-forward items rather
   than assuming the previous run was yesterday.

Record the outcomes in the package README's validation section. Any defect found
is fixed in the skill files and re-validated, not documented as a limitation.

## Acceptance Criteria

AC-1: WHEN an unseen message cannot be confidently classified THE SYSTEM SHALL
      send exactly one escalation email to the configured manager address and
      record the message as an open worklog item, evidenced by the received mail
      and the worklog file.
AC-2: WHILE the S-004 action ruleset holds no rule admitting this package's
      himalaya calls, but still admits its worklog access, THE SYSTEM SHALL
      record the blocked call as an open worklog item and take no autonomous
      action on the message.
AC-3: WHEN the next executed run happens on a later calendar day while an earlier
      worklog still holds open items THE SYSTEM SHALL reconcile against that
      worklog even though intervening daily ticks produced no run, evidenced by
      the new day's worklog referencing the carried-forward items.
AC-4: IF validation exposes a defect in either skill or in a category workflow
      THEN THE SYSTEM SHALL correct the file and re-run the affected validation.

## Dependencies

- `T-139` — deployed workspace, verified allow rule, and the README section this
  task extends

## Files to Touch

- `the-intern/email-skills/README.md` — record the validated escalation, block,
  and continuity outcomes
- `the-intern/email-skills/.pi/skills/email-triage/SKILL.md` — fix-ups if
  validation exposes defects
- `the-intern/email-skills/.pi/skills/email-triage/references/worklog.md` —
  fix-ups if reconciliation behaviour does not match the reference

## Verification

```bash
# Manual, against the live service and the deployed workspace from T-139.

# AC-1 — escalation: send a deliberately ambiguous message, wait one tick.
cat "$HOME/workspaces/email/worklog/$(date +%F).md"     # open item recorded
# confirm exactly one escalation mail arrived at the configured manager address

# AC-2 — block: remove only the himalaya allow rule from the policy section,
# keeping the worklog rule, then
./scripts/bob-dev.sh policy reload
# wait one tick, then confirm a blocked verdict and a recorded open item:
./scripts/bob-dev.sh audit tail
cat "$HOME/workspaces/email/worklog/$(date +%F).md"
# restore the allow rule and reload afterwards

# AC-3 — continuity: leave an open item in a worklog dated several days back and
# remove the more recent worklog files, then let the next run fire:
ls "$HOME/workspaces/email/worklog/"
cat "$HOME/workspaces/email/worklog/$(date +%F).md"     # references the carried item

# Paste the audit records, worklog contents, and the received escalation mail
# into the Work Log as evidence.
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
