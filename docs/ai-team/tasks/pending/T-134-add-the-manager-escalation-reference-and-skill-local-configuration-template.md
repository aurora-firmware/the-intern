---
id: T-134
title: Add the manager-escalation reference and skill-local configuration template
status: pending  # pending | in-progress | completed | blocked
priority: medium  # critical | high | medium | low
assigned-role: developer
created: '2026-08-01'
spec: S-010
---

# Add the manager-escalation reference and skill-local configuration template

## Description

S-010's escalation path: a `periodic` request has no caller to answer it
(ADR-004), so "ask for guidance" must produce an addressable artifact — an email
to a configured manager address — never a blocking wait. This task writes that
reference and the skill-local configuration template it reads.

Two files, under the `email-triage` skill directory and the package root (paths
rooted at the layout T-131 verified):
- `references/escalation.md` — when and how to escalate, what the escalation
  email must contain, and the hard-stop rules.
- `config/email-triage.example.toml` — the shipped template for the skill-local
  configuration, with `manager_address` documented and no real address. The real
  file (`config/email-triage.toml`) exists only in the owner-only deployed
  workspace, not in the repository.

Configuration lives in the job's own working directory, not bob's TOML config,
per S-010's Configuration Requirements and ADR-008 §5 ("actions use their own
configuration"). Manager-address provisioning itself is out of scope.

Hard rules from S-010 that this reference must carry: the escalation send is a
`bash` call and is therefore gated by S-004 like every other call; if it is
blocked, or the address is missing or malformed, the message is a hard stop
recorded as an open worklog item — never a licence to act autonomously instead.
The worklog entry format is defined by T-133's `references/worklog.md`; refer to
it rather than restating it.

## Acceptance Criteria

AC-1: The system shall define the skill-local configuration file
      `config/email-triage.toml` in the job's working directory with a required
      `manager_address` key holding a single well-formed email address, and ship
      an example file documenting that key with no real address.
AC-2: WHEN a message's classification is not confident THE SYSTEM SHALL send one
      escalation email to `manager_address` describing the message, the
      uncertainty, and the question asked, and take no further action on that
      message in that run.
AC-3: IF the escalation send is blocked by bob's S-004 action gate THEN THE
      SYSTEM SHALL record the block as an open worklog item and SHALL NOT act on
      the message autonomously as a fallback.
AC-4: IF `manager_address` is missing or is not a well-formed address THEN THE
      SYSTEM SHALL treat the message as a hard stop recorded in the worklog, with
      no autonomous action.
AC-5: The system shall state that no synchronous reply is expected within the
      run, because scheduled firings are fire-and-forget periodic requests
      (ADR-004), and that the manager's reply returns as ordinary unseen mail.

## Dependencies

- `T-131` — verified skill-discovery path and package layout
- `T-133` — worklog entry format and open-item lifecycle referenced here

## Files to Touch

- `the-intern/email-skills/.pi/skills/email-triage/references/escalation.md` —
  new: escalation trigger, email content, S-004-block and missing-address stops
- `the-intern/email-skills/config/email-triage.example.toml` — new: documented
  `manager_address` template with a placeholder value

## Verification

```bash
# The template ships a documented key and no real address.
cat the-intern/email-skills/config/email-triage.example.toml

# The reference carries all four hard rules and defers the entry format.
rg -n "manager_address|blocked|hard stop|worklog.md|periodic" \
  the-intern/email-skills/.pi/skills/email-triage/references/escalation.md

# Behavioural check (read-only, no mail sent): in a copy of the package with
# config/email-triage.toml absent, ask what it would do with a message it cannot
# classify confidently. The answer must be "record a hard stop as an open
# worklog item", never "act on it anyway".
#
# The email-triage SKILL.md that loads this reference does not exist until
# T-135, so name the file in the prompt. Use the non-interactive invocation form
# T-131 recorded; pi's default mode is a TTY TUI.
cd /tmp/email-skills-probe && pi -p "Read .pi/skills/email-triage/references/escalation.md. Following only its rules, and given config/email-triage.toml does not exist, what do you do with a message you cannot classify confidently? Send no mail."
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
