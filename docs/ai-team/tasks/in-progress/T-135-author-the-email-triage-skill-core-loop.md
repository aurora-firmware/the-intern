---
id: T-135
title: Author the email-triage skill core loop
status: pending  # pending | in-progress | completed | blocked
priority: high  # critical | high | medium | low
assigned-role: developer
created: '2026-08-01'
spec: S-010
---

# Author the email-triage skill core loop

## Description

S-010 Component 2, Phase 2: the `email-triage` SKILL.md that a scheduled firing
discovers from its `--cwd` and runs end to end. This task delivers the core loop
**without** the category taxonomy — a single generic act-or-escalate behaviour;
T-136 wires classification in afterwards.

Write `SKILL.md` in the `email-triage` skill directory (layout verified by
T-131), following pi's SKILL.md convention: `name`, trigger-rich `description`,
`allowed-tools`, a short body, and detail delegated to references.

The loop, per S-010's Workflow:
1. If this is the day's first executed run, reconcile per `references/worklog.md`
   (T-133) — including any pending manager escalation.
2. List unseen envelopes using the `himalaya` skill's documented command (T-132).
   Do not restate himalaya syntax here, and do not introduce a skill-owned
   last-seen state file — the mailbox's `\Seen` flag is the only new-mail signal
   (S-010 rejected a bespoke state file).
3. For each unseen message, act on it or escalate per `references/escalation.md`
   (T-134). The gate is confidence in the classification for that specific
   message — not the action's reversibility, not a sender allowlist.
4. Append a worklog entry per message so a completed run leaves no unseen message
   without an action, an escalation, or a recorded block.

Every himalaya call is a `bash` call gated by S-004; a block is recorded as an
open worklog item and the message is not treated as handled. S-004 is
default-deny over **every** tool call, not just himalaya ones — the config read,
worklog read/append, and on-demand `references/*.md` loads are gated too. Name
the tool each of those uses explicitly and keep that choice uniform, so T-139 can
record one narrow allow-rule set covering the whole package.

## Acceptance Criteria

AC-1: WHEN the skill runs THE SYSTEM SHALL detect new mail by listing envelopes
      carrying the unseen flag through the `himalaya` skill's documented command,
      without maintaining any skill-owned last-seen state file.
AC-2: WHEN the run is the day's first executed run THE SYSTEM SHALL perform the
      reconciliation defined in `references/worklog.md` before processing new
      mail.
AC-3: The system shall, for each unseen message, either act on it or escalate it
      per `references/escalation.md`, gated on confidence in that message's
      classification and not on the action's reversibility or a sender allowlist.
AC-4: WHEN a message has been handled THE SYSTEM SHALL append a worklog entry for
      it, so that a completed run leaves no unseen message without an action, an
      escalation, or a recorded block.
AC-5: The skill's frontmatter shall declare `name`, `description`, and its
      required tools per the pi SKILL.md convention, and the body shall delegate
      himalaya syntax to the `himalaya` skill rather than restating it.

## Dependencies

- `T-132` — `himalaya` skill whose commands this loop invokes
- `T-133` — worklog format and first-run reconciliation reference
- `T-134` — escalation reference and skill-local configuration

## Files to Touch

- `the-intern/email-skills/.pi/skills/email-triage/SKILL.md` — new: frontmatter
  and the detect → reconcile → act-or-escalate → record loop

## Verification

```bash
# The loop delegates rather than restates, and names all four steps.
rg -n "unseen|reconcil|escalat|worklog|himalaya" \
  the-intern/email-skills/.pi/skills/email-triage/SKILL.md

# Behavioural check (read-only — instruct the session to describe, not execute):
# the walkthrough must (a) list unseen envelopes via the himalaya skill,
# (b) reconcile first when it is the day's first run, (c) escalate rather than
# guess when unsure, and (d) append a worklog entry per message.
# Use the non-interactive invocation form T-131 recorded; pi's default mode is a
# TTY TUI.
cd /tmp/email-skills-probe && pi -p "You receive the scheduled prompt 'Check email'. Describe, step by step, exactly what you would do. Do not run any tool and do not send any mail."
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
