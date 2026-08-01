---
id: T-132
title: Author the himalaya CLI-reference skill
status: pending  # pending | in-progress | completed | blocked
priority: high  # critical | high | medium | low
assigned-role: developer
created: '2026-08-01'
spec: S-010
---

# Author the himalaya CLI-reference skill

## Description

S-010 Component 1: a generic `himalaya` skill that teaches pi-agent how to drive
the himalaya CLI. It carries **no** triage policy — no manager address, no
taxonomy, no worklog discipline — so any pi session sharing the package's working
directory (including an interactive `bob chat` started from there) can use it
without inheriting the email-triage job's rules (S-010 Design Principles).

Write it at the discovery path T-131 verified and recorded in
`the-intern/email-skills/README.md` (expected `.pi/skills/himalaya/`). Follow the
SKILL.md convention pi already uses for its installed skills: frontmatter with
`name`, a trigger-rich `description`, `compatibility`, and `allowed-tools`, a
short body, and detail pushed into `references/` files loaded on demand.

Cover every operation the triage workflow needs: listing and searching envelopes
(including filtering on the unseen flag), reading a message, replying,
forwarding, composing and sending, moving and copying, deleting, adding and
removing flags, handling attachments, and selecting an account.

Every documented command and flag must be checked against the installed
`himalaya` binary's own help output — do not write commands from memory. himalaya
account setup is out of scope (S-010 Exclusions); assume a configured account.

## Acceptance Criteria

AC-1: The system shall document the invocation for each operation the triage
      workflow needs: listing/searching envelopes including an unseen-flag
      filter, reading, replying, forwarding, composing and sending, moving,
      copying, deleting, adding/removing flags, attachments, and account
      selection.
AC-2: The system shall verify every documented command and flag against the
      installed `himalaya` binary's help output and record the verified
      `himalaya --version` in the skill.
AC-3: The skill shall contain no triage policy — no escalation address, no
      category taxonomy, no worklog instruction — so it is usable standalone by
      any pi session sharing this working directory.
AC-4: The skill's frontmatter shall declare `name`, a `description` naming
      himalaya and email-CLI usage as its trigger, and the tools it needs,
      matching the SKILL.md frontmatter convention used by pi's installed skills.
AC-5: IF the `himalaya` binary is not available on PATH THEN THE SYSTEM SHALL
      stop and escalate rather than documenting commands from memory.

## Dependencies

- `T-131` — verified skill-discovery path and package layout

## Files to Touch

- `the-intern/email-skills/.pi/skills/himalaya/SKILL.md` — new: frontmatter,
  health check, operation index
- `the-intern/email-skills/.pi/skills/himalaya/references/command-reference.md` —
  new: per-operation command and flag detail

## Verification

```bash
# Prerequisite — escalate if absent (AC-5)
himalaya --version

# For every command block in the skill and its reference file, confirm the
# subcommand and each flag exist in the installed binary's own help output:
himalaya --help
himalaya <subcommand> --help    # repeat per documented subcommand

# Confirm the skill is discovered and carries no triage policy. Use the
# non-interactive invocation form T-131 recorded (pi's default mode is a TTY
# TUI). The answer must come from this skill and must not mention escalation,
# categories, or the worklog.
cd /tmp/email-skills-probe && pi -p "Which himalaya command lists unseen mail? Answer from your available skills only. Do not run any tool."
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
