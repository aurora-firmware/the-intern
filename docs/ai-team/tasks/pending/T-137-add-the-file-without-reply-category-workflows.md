---
id: T-137
title: Add the file-without-reply category workflows
status: pending  # pending | in-progress | completed | blocked
priority: medium  # critical | high | medium | low
assigned-role: developer
created: '2026-08-01'
spec: S-010
---

# Add the file-without-reply category workflows

## Description

S-010 Component 3, first group: the reference workflows for the three starter
categories that are filed without corresponding with the sender —
`newsletter-bulk`, `automated-notification`, and `suspected-spam`. T-136 defines
the taxonomy, the matching signals, and the confidence rubric; this task writes
what a *confident* match in each of these categories does.

One file per category under the `email-triage` skill's
`references/categories/` directory (layout verified by T-131).

Each workflow states the concrete steps for a confident match: which himalaya
operation to use (naming the operation and deferring syntax to the `himalaya`
skill from T-132), which mailbox or folder the message ends up in, and what the
worklog entry records (deferring the entry format to `references/worklog.md`
from T-133). Do not restate himalaya CLI syntax or the worklog format here.

Blocked calls follow the rule already defined in `references/escalation.md`
(T-134): a call blocked by S-004 is recorded as an open worklog item and the
message is not treated as handled — refer to it rather than re-specifying it.

Keep these workflows non-destructive by default: S-010 excludes exhaustive
per-category business logic, and destructive defaults are not something an
operator should inherit implicitly from a starter taxonomy.

## Acceptance Criteria

AC-1: WHEN a message is confidently classified as `newsletter-bulk` THE SYSTEM
      SHALL file it per the workflow's named himalaya operation and append a
      worklog entry, without composing a reply.
AC-2: WHEN a message is confidently classified as `automated-notification` THE
      SYSTEM SHALL file it the same way and record a follow-up item in the
      worklog when the notification reports a failure needing attention.
AC-3: The system shall specify non-destructive handling for `suspected-spam` and
      shall not instruct replying to the sender or following links in the
      message.
AC-4: Each workflow file shall name the himalaya operations it uses by deferring
      to the `himalaya` skill, defer the entry format to `references/worklog.md`,
      and defer blocked-call handling to `references/escalation.md`, restating
      none of them.

## Dependencies

- `T-136` — taxonomy index, matching signals, and confidence rubric

## Files to Touch

- `the-intern/email-skills/.pi/skills/email-triage/references/categories/newsletter-bulk.md`
  — new
- `the-intern/email-skills/.pi/skills/email-triage/references/categories/automated-notification.md`
  — new
- `the-intern/email-skills/.pi/skills/email-triage/references/categories/suspected-spam.md`
  — new

## Verification

```bash
# Each workflow exists, defers rather than restates, and none instructs replying.
for f in newsletter-bulk automated-notification suspected-spam; do
  rg -n "himalaya|worklog.md|escalation.md" \
    "the-intern/email-skills/.pi/skills/email-triage/references/categories/$f.md"
done

# Behavioural check (read-only — describe, do not execute): present a newsletter,
# a CI failure notification, and a phishing-looking message. It must name the
# matched workflow file for each, describe filing without replying, flag the
# failure notification as a follow-up item, and refuse to reply to or follow
# links in the third.
# Use the non-interactive invocation form T-131 recorded; pi's default mode is a
# TTY TUI.
cd /tmp/email-skills-probe && pi -p "For each message, name the workflow file you would follow and the steps it prescribes. Do not run any tool and do not send mail. 1) From: news@example.com Subject: Your weekly digest. 2) From: ci@example.com Subject: Build failed on main. 3) From: secur1ty@example-bank.co Subject: Verify your account now, link inside."
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
