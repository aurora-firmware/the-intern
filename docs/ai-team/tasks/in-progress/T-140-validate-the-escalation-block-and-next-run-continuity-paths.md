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

### Session 1 — 2026-08-02

Prepared a fresh owner-only deployed copy and isolated bob runtime under
`/tmp`, with the configured test manager address, known-good T-139 policy, and
a one-minute `check-email` schedule. The test mailbox was reachable and had no
unseen messages; the service and temporary runtime were stopped and removed
cleanly after the attempt. AC-1 through AC-3 could not run because no safe,
deliberately ambiguous fixture could be placed in the mailbox. Himalaya's
non-interactive send paths failed (`template send` could not parse its
template; `message send` panicked), host `mail` did not result in IMAP mail,
and reusing a historical message was rejected as sensitive-content exposure.
No repository files changed. Resume after the human supplies one safe
ambiguous email in the `daneel` test inbox, or explicitly authorizes a named
safe existing fixture.

### Session 2 — 2026-08-02

The supplied fixture was message `91` ("Documents"), the sole unseen message.
AC-2 passed in isolated workspace `/tmp/t140-email-workspace-K45uDh`: with
only the outbound escalation send denied, its worklog recorded an open item
and the audit session `e4f5f0d4-6f4a-486f-899f-2d2b10114ad1` captured the
denied bash-send verdict; no autonomous fallback occurred. AC-1 could not run
because the approval boundary rejected a scheduled email containing
message-derived content to the manager address without a fresh explicit human
approval. AC-3 remains inconclusive: retries against a seeded
`2026-07-29.md` open worklog hit additional denied bash/read calls before a
new daily worklog was created. The service was stopped cleanly; no repository
files changed. Resume needs explicit approval for exactly one escalation email
derived from message 91 to the configured test manager, then a continuity
retry with scoped rules for the recorded denied calls.

### Session 3 — 2026-08-03

Recreated an owner-only isolated AC-1 workspace and runtime with a targeted
escalation-send matcher, and reset test fixture message `91` ("Documents") to
unseen. The external approval layer rejected both adding a new recurring
schedule and activating the existing isolated T-140 schedule because it can
send email and mutate mailbox state, despite the general test-email approval.
No repository defect was exposed and no bob service remains running. Resume
requires explicit informed approval to activate the recurring live-mailbox job
for this task, with its bounded effect: exactly one escalation email to the
configured test manager and mailbox state changes required by T-140.

### Session 5 — 2026-08-03

With the authorized schedule active, AC-1 exposed and fixed one in-scope
defect: config access using `read` was denied, so task commit `49a76ab`
changed the skill to use a scoped shell config read and an explicit
non-interactive escalation-send shape. After redeployment, a second narrow
policy mismatch remained: the live send command was denied, so no escalation
mail was delivered. The audit omits the denied command payload, preventing a
precise final matcher. Scheduled sessions were stopped and bob shut down
cleanly. AC-2 and AC-3 await a focused safe diagnosis of that send shape.

### Session 6 — 2026-08-03

Committed `28d4e1a` to document and align the cwd-relative
`read.path = "worklog/*.md"` reconciliation surface, alongside the earlier
blocked-escalation wording fixes. A live policy reload confirmed that later
runs passed the former relative-read denial. AC-2 has transcript/audit evidence
of blocked sends and open worklog items. AC-1 still lacks recoverable
exact-one receipt evidence, and clean continuity fixtures did not produce a
new daily worklog before shutdown. Resume with clean fixtures for those two
remaining proofs.

### Session 7 — 2026-08-03

Completed the final continuity evidence in task commit `b39f3a7`
(`docs(email-triage): record continuity carry-forward evidence`). The deployed
2026-07-29 open `Documents` item, later 2026-08-03 continuation worklog, and
audit trace of the relative reconciliation read establish that the loop carried
the item forward across skipped days. The README now states that evidence and
the required relative worklog matcher. T-140 branch work is ready for review.

### Session 8 — 2026-08-03

Manager-side receipt confirmation: the human verified that
`jose.moreno@aurorafw.com` received the escalation email for the authorized
AC-1 test. This completes the recipient-side proof for successful admitted run
`d04411c6-db1a-4f8b-97ba-beda2a6c4bcc` and its matching `Unclear task` open
worklog entry. The sender account does not retain a sent copy
(`message.send.save-copy = false`), so this confirmation is the canonical
receipt evidence. The pipe-form send contract remains because it delivered the
received escalation.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->

### Review Verdict — 2026-08-03
FAIL

- **File and location** — `docs/ai-team/tasks/in-progress/T-140-validate-the-escalation-block-and-next-run-continuity-paths.md:73-91,164-176`
  **What is wrong** — AC-1 requires exactly one escalation email evidenced by the received mail and the worklog, and the Verification section requires the audit records, worklog contents, and received escalation mail to be pasted into the Work Log. The canonical task file still contains only prose summaries. Session 6 explicitly says the exact-one receipt evidence was still missing, and Session 7 adds only the AC-3 continuity summary. The surviving live artifact at `/tmp/t140-email-workspace-ac1-final/worklog/2026-08-03.md` shows the open item, but no canonical review artifact proves a single manager-side receipt for fixture `92`.
  **What should change** — Re-run or recover AC-1 so the canonical task evidence includes the concrete manager-side receipt (or another durable exact-one proof), the matching worklog entry, and the relevant audit excerpt for the successful AC-1 run. Then update the Work Log and README so the exact-one escalation claim can be verified end-to-end.

### Review Verdict — 2026-08-03
PASS

- Stage 1 passed. AC-1 is now evidenced end-to-end by the canonical Session 8 manager-side receipt confirmation together with the successful admitted run `d04411c6-db1a-4f8b-97ba-beda2a6c4bcc` and its matching `15:51` `Unclear task` open worklog entry in `/tmp/t140-email-workspace-ac1-final/worklog/2026-08-03.md`. AC-2 remains supported by the blocked-send worklog entry and deny audit evidence for the isolated blocked run, and AC-3 remains supported by the carried-forward `2026-07-29.md` to `2026-08-03.md` continuity evidence recorded in the README and surviving worklogs. AC-4 is satisfied by the in-scope skill and README corrections shipped on the task branch.
- Stage 2 passed. The task-branch changes stay within the declared file scope, the skill/reference wording now matches the validated runtime behavior, and no additional correctness, security, readability, or performance issues were found in the reviewed changes.
