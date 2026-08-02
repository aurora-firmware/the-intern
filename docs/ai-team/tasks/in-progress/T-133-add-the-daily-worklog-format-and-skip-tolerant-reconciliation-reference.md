---
id: T-133
title: Add the daily worklog format and skip-tolerant reconciliation reference
status: pending  # pending | in-progress | completed | blocked
priority: medium  # critical | high | medium | low
assigned-role: developer
created: '2026-08-01'
spec: S-010
---

# Add the daily worklog format and skip-tolerant reconciliation reference

## Description

S-010 Component 4: the daily worklog is the diary that gives independent
scheduler firings continuity, and the *only* record of anything left open by an
escalation or an S-004 block — reading a message to classify it sets `\Seen`
regardless of outcome, so the mailbox cannot carry an open item forward.

Write the reference file that defines the diary and the reconciliation
discipline, at `references/worklog.md` under the `email-triage` skill directory
(path root verified by T-131). It is loaded on demand by the `email-triage`
SKILL.md that T-135 writes; this task only defines the format and the rules.

Key constraints from S-010's Design Principles and Workflow:
- The file lives at `<workspace>/worklog/<YYYY-MM-DD>.md` in the job's own
  working directory — no bob-side session or queue state may be relied on.
- Reconciliation happens on each day's **first executed run**, not every tick,
  and must not assume the previous run was yesterday: bob stopped at a tick
  (ADR-006), a missing per-entry `cwd` (S-009), or `max_processes` exhaustion
  (S-002) can eliminate a day's runs entirely. Reconcile against the most recent
  worklog file that still holds open items.
- Entries record what was done, what is left, and what is next, per message.

## Acceptance Criteria

AC-1: The system shall define the worklog location as
      `<workspace>/worklog/<YYYY-MM-DD>.md` and a per-message entry format
      recording what was done, what is left, and what is next.
AC-2: WHEN a run is the first executed run of a calendar day THE SYSTEM SHALL
      read the most recent worklog file that still contains open items — not
      necessarily the previous calendar day's — and reconcile against it.
AC-3: The system shall state that an escalated or blocked message is carried
      forward as an open item through the worklog only, never through its
      mailbox flag state.
AC-4: The system shall define how an open item closes — an escalation when the
      manager's reply arrives as ordinary unseen mail and re-enters triage, an
      S-004 block once an admitting allow rule is in place — and that unresolved
      items are carried forward at the next day's first-run reconciliation.
AC-5: IF the `worklog/` directory or the day's file does not exist THEN THE
      SYSTEM SHALL create it before appending.

## Dependencies

- `T-131` — verified skill-discovery path and package layout

## Files to Touch

- `the-intern/email-skills/.pi/skills/email-triage/references/worklog.md` — new:
  diary location, entry format, open-item lifecycle, first-run reconciliation

## Verification

```bash
# Structural check: the reference names the dated path and all four rules.
rg -n "worklog/|first executed run|open item|Seen" \
  the-intern/email-skills/.pi/skills/email-triage/references/worklog.md

# Behavioural check (read-only, no mail actions): in a copy of the package,
# create worklog/2026-07-28.md holding one open escalation item and
# worklog/2026-07-30.md holding none, then ask pi which file it would reconcile
# against today and why. The answer must name the 2026-07-28 file (most recent
# with open items) and must not assume "yesterday".
#
# The email-triage SKILL.md that loads this reference does not exist until
# T-135, so nothing auto-discovers it yet — name the file in the prompt. Use the
# non-interactive invocation form T-131 recorded; pi's default mode is a TTY TUI.
cd /tmp/email-skills-probe && pi -p "Read .pi/skills/email-triage/references/worklog.md. Following only its rules, which worklog file would you reconcile against today, and why?"
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
