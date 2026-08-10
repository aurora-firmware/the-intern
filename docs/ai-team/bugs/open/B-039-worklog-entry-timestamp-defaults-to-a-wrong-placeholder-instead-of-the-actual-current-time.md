---
id: B-039
title: worklog entry timestamp defaults to a wrong placeholder instead of the 
  actual current time
severity: medium
status: open
created: '2026-08-10'
task: T-164
---

# worklog entry timestamp defaults to a wrong placeholder instead of the actual current time

## Summary

The `worklog` skill's `references/entry-format.md` shows the per-item entry
header as `## <HH:MM> — <item-identifier>` but never instructs the
consuming skill (here, `email-triage`) to determine the real current time
with a `bash` call before substituting it in. During a live scheduled-job
run of `email-triage` under T-164's install-path re-validation, the agent
wrote a worklog entry with the literal placeholder `00:00` instead of the
actual local time the run executed at (~22:24, the same session), then
tried to correct the mistake after the fact using tools (`edit`, and a
`bash` call running an ad hoc Python heredoc) that this skill's own "Tool
usage" section explicitly says it should never need — both correction
attempts were correctly denied by the S-004 action-authorization gate, so
the wrong timestamp was never fixed and still sits in the worklog file.

## Reproduction Status

Status: confirmed

Evidence-backed: reproduced once, live, during T-164's scheduled-job
validation run (single observation so far; not yet tested for how often
this recurs across repeated runs/models).

## Evidence

- Live session transcript (JSONL), first `toolCall`/`toolResult` pair
  showing the entry being written with a literal `00:00` header, then two
  denied attempts to correct it:
  `~/.pi/agent/sessions/--tmp-...-t164-job-workspace--/2026-08-10T20-24-00-685Z_019fed58-b1ad-7fe3-9c32-fc8899a83362.jsonl`
  — the assistant's `bash` tool call that appended the entry used
  `## 00:00 — You have been invited to join Holded`, followed later by a
  denied `bash` call running:
  ```
  python3 - <<'PY'
  from pathlib import Path
  p=Path('worklog/2026-08-10.md')
  s=p.read_text()
  s=s.replace('## 00:00 — You have been invited to join Holded', '## 22:25 — You have been invited to join Holded', 1)
  p.write_text(s)
  PY
  ```
  and a denied `edit` tool call with the same old/new text substitution.
- bob's own audit trail (`audit.jsonl` in the isolated T-164 validation
  runtime) records both denials as
  `{"allow": false, "reason": "no action rule permits tool 'edit' with the supplied arguments"}`
  and the equivalent `'bash'` denial for the Python heredoc, at
  `2026-08-10T20:25:06Z` and `2026-08-10T20:25:11Z` UTC — roughly a minute
  after the entry was first written at `2026-08-10T20:24:58Z` UTC (local
  time ~22:24/22:25, matching the interactive session's independently
  observed local clock at ~22:13–22:18 the same evening; see T-164's Work
  Log Session 1 for the corroborating interactive-session evidence).
- Final worklog file (job workspace) content:
  ```
  ## 00:00 — You have been invited to join Holded (from Holded <no-reply@mail.holded.com>)

  - Done: Classified as a routine automated notification (no-reply service invite) and moved from INBOX to INBOX.Notifications.
  - Left: nothing
  - Next: Nothing further for this message.
  ```
- By contrast, a same-evening *interactive* `bob chat` session asked to
  record a worklog entry (T-164's AC-3 validation, after the S-004 rule set
  was broadened to admit a standalone `date +%H:%M*` lookup) correctly
  computed and used the real local time (`22:13`, then `22:18` on a second
  run) by embedding a `NOW=$(date +%H:%M)` assignment inside its combined
  `mkdir -p worklog; ...; cat >> worklog/$TODAY.md <<EOF` append command —
  proving the skill *can* get this right when the model chooses to look up
  the time, but nothing in `entry-format.md` requires it to.

## Reproduction Steps

1. Deploy the `email-triage`/`worklog`/`himalaya` skill package at any
   `skill_install_path`, with the S-004 action-rule set documented in
   `the-intern/email-skills/README.md`'s "Verified S-004 action rules for
   the install-path model" section (this bug reproduced even with that
   set's `date +%H:%M*` rule present, since the run never called it).
2. Feed a scheduled `email-triage` job (`--cwd` holding only
   `config/email-triage.toml` and no prior `worklog/`) exactly one unseen
   message that confidently classifies as `automated-notification`.
3. Let the job fire and inspect the resulting `worklog/<today>.md` entry's
   `## <HH:MM> — ...` header against the actual wall-clock time the tool
   call ran at (compare the entry's timestamp to the audit trail's or
   session transcript's own timestamps for the same call).

## Expected Behavior

The worklog entry's `<HH:MM>` header reflects the actual local time the
entry was recorded, the same way the interactive session in this same
evidence set correctly did.

## Actual Behavior

The scheduled-job run wrote the literal placeholder `00:00` instead of the
real time, then — on apparently noticing the mistake — tried to fix it
using `edit` and an ad hoc `bash`-run Python script, both denied by the
S-004 action-authorization gate (correctly, since this skill's own
documented tool-usage contract in `SKILL.md`/`entry-format.md` only ever
calls for `bash`-driven `mkdir`/`cat >>` operations on the worklog file,
never `edit` or arbitrary scripts). The wrong `00:00` entry was never
corrected and still sits in the deployed worklog file as the permanent
record of when this item was handled.

## Environment

- OS / platform: Linux (dev sandbox), same as the rest of this repository's
  live validation work.
- Language / runtime version: `pi` 0.80.3 (npm `@earendil-works/pi-coding-agent`),
  model `gpt-5.5` (medium thinking), `bob` built from `dev-agent` at the
  time of T-164.
- Relevant dependencies: `the-intern/email-skills/skills/worklog/references/entry-format.md`,
  `the-intern/email-skills/skills/email-triage/references/worklog.md`.
- Branch / commit: observed on `task/T-164-revalidate-skill-install-path-e2e`,
  based on `dev-agent` at the point T-164 was picked up (S-011 chain,
  T-150–T-163 already merged).

## Related

- Task: `T-164` (discovered during this task's live end-to-end
  re-validation; out of T-164's own Files-to-Touch scope to fix, since
  fixing it requires editing skill files, not the docs T-164 is scoped to)
- Specification: `S-011-vendor-neutral-skills-package-and-bob-side-skill-loading.md`

## Suspected Area

`the-intern/email-skills/skills/worklog/references/entry-format.md` (the
canonical diary-mechanics reference that defines the entry format but never
instructs a `bash date` lookup for `<HH:MM>`) and/or
`the-intern/email-skills/skills/email-triage/references/worklog.md` (the
consuming skill's own email-specific worklog notes).

## Fix Verification

```bash
# Manual, live (matches this bug's own reproduction steps): re-run a
# scheduled email-triage job against one confidently-classifiable unseen
# test message and confirm the resulting worklog entry's <HH:MM> header
# matches the real wall-clock time the entry was appended at, within a
# one-minute tolerance, with no denied edit/bash-correction attempt in the
# session transcript or bob's audit trail.
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
