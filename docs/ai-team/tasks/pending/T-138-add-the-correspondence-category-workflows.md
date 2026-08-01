---
id: T-138
title: Add the correspondence category workflows
status: pending  # pending | in-progress | completed | blocked
priority: medium  # critical | high | medium | low
assigned-role: developer
created: '2026-08-01'
spec: S-010
---

# Add the correspondence category workflows

## Description

S-010 Component 3, second group: the reference workflows for the two starter
categories that send mail back to a human — `direct-request` and
`meeting-scheduling`. T-136 defines the taxonomy, matching signals, and the
confidence rubric; this task writes what a *confident* match in each does.

One file per category under the `email-triage` skill's
`references/categories/` directory (layout verified by T-131).

These are the categories where S-010's read-and-act scope is exercised: the
skill composes and sends real mail, not just summaries. Each workflow names the
himalaya operation to use (deferring syntax to the `himalaya` skill from T-132),
states what the reply must contain, and states what the worklog entry records
(deferring the format to `references/worklog.md` from T-133).

The confidence gate still applies inside a confident classification: if acting
would require information the run does not have — availability the skill cannot
determine, a decision only the owner can make — the message escalates per
`references/escalation.md` (T-134) instead of the workflow guessing. Blocked
calls likewise follow the rule already stated there; refer to it rather than
re-specifying it.

## Acceptance Criteria

AC-1: WHEN a message is confidently classified as `direct-request` THE SYSTEM
      SHALL draft and send a reply through the `himalaya` skill's reply operation
      and append a worklog entry naming the reply that was sent.
AC-2: WHEN a message is confidently classified as `meeting-scheduling` THE SYSTEM
      SHALL follow the workflow's concrete steps for proposing or confirming a
      time and replying to the sender.
AC-3: IF acting on a confidently-classified message would require information the
      run does not have THEN THE SYSTEM SHALL escalate per
      `references/escalation.md` instead of guessing.
AC-4: Each workflow file shall defer himalaya syntax to the `himalaya` skill and
      the worklog entry format to `references/worklog.md`, restating neither.

## Dependencies

- `T-136` — taxonomy index, matching signals, and confidence rubric

## Files to Touch

- `the-intern/email-skills/.pi/skills/email-triage/references/categories/direct-request.md`
  — new
- `the-intern/email-skills/.pi/skills/email-triage/references/categories/meeting-scheduling.md`
  — new

## Verification

```bash
# Both workflows exist, defer rather than restate, and name the escalation path.
for f in direct-request meeting-scheduling; do
  rg -n "himalaya|worklog.md|escalation.md" \
    "the-intern/email-skills/.pi/skills/email-triage/references/categories/$f.md"
done

# Behavioural check (read-only — describe, do not execute): present a direct
# question answerable from the message alone, and a meeting request that depends
# on the owner's availability. It must describe drafting and sending a reply for
# the first, and escalate the second rather than inventing availability.
# Use the non-interactive invocation form T-131 recorded; pi's default mode is a
# TTY TUI.
cd /tmp/email-skills-probe && pi -p "For each message, name the workflow file you would follow and describe what you would do. Do not run any tool and do not send mail. 1) From: a.person@example.com Subject: What is the office postal address? 2) From: b.person@example.com Subject: Can we meet Thursday afternoon?"
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
