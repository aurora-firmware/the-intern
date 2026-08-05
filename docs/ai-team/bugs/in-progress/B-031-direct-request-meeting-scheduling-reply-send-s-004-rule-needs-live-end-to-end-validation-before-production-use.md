---
id: B-031
title: direct-request/meeting-scheduling reply-send S-004 rule needs live 
  end-to-end validation before production use
severity: high
status: in-progress
created: '2026-08-05'
task: T-139
---

# direct-request/meeting-scheduling reply-send S-004 rule needs live end-to-end validation before production use

## Summary

`B-029`'s fix added a new S-004 `[[policy.action_rules]]` `tool = "bash"`
allow-rule to `the-intern/docs/src/operator-guide/index.md` and
`the-intern/email-skills/README.md`, admitting the `himalaya template
reply` -> `himalaya template send` command shape that `direct-request` and
`meeting-scheduling` use to send a reply, built on `B-030`'s hardened
heredoc pattern. That rule was verified statically — checked against the
real `wildmatch` v2.6.1 crate (the exact library `bob`'s policy-control
matcher uses) via the real `load_policy_config_from_file` parsing path, for
both the intended safe shape (plain reply and `-A` reply-all, including
adversarial message-derived body content) and several unsafe variants
(unquoted-heredoc bypass, bare/unquoted `$BODY` regression, missing `--`,
the pre-`B-030` naive literal-splice shape) — all passed. **What has not
been done, and can't safely be done from an unsupervised docs-editing
session:** a real end-to-end live validation — deploying the package to a
workspace, adding the new rule via the (already-updated) operator guide,
running the scheduled job against a real mailbox, and confirming a real
`direct-request`/`meeting-scheduling` reply is actually composed, admitted
by S-004, sent via the real configured `himalaya` account
(`daneel@aurorafw.com` via `lin119.loading.es`), and recorded in the
worklog — the same way T-139/T-140 live-validated the other categories.
This mirrors `B-030` exactly (that bug tracks the same kind of outstanding
live-validation gap for the hardened escalation-send shape); this bug
tracks it for the reply-send shape instead.

## Reproduction Status

Status: not yet reproduced (this is a validation gap, not a reproduced
failure — the new rule and command shape have simply never been run live)

## Evidence

- Logs / stack traces / failing assertions: none yet — no live run
  attempted
- Screenshots or recordings: n/a
- Failing command or test: n/a
- First diagnostic step if not yet reproduced: deploy the package per the
  operator guide (including the new `B-029` reply-send S-004 rule), place
  an unseen test message that classifies confidently as `direct-request`
  or `meeting-scheduling`, let the scheduled job run, and confirm the reply
  is actually sent (not blocked) and recorded correctly in the worklog

## Reproduction Steps

1. Deploy `email-skills` to an isolated workspace exactly per
   `the-intern/docs/src/operator-guide/index.md`'s "Deploying the
   email-triage scheduled job" section, using the current (post-`B-029`)
   S-004 rule set.
2. Place an unseen test message the taxonomy classifies confidently as
   `direct-request` (or `meeting-scheduling`).
3. Let the scheduled job run.
4. Confirm: (a) the agent successfully composes and runs the heredoc-based
   reply command without a syntax/tool error, (b) S-004 admits it (not
   blocked), (c) exactly one reply email arrives with content that
   correctly answers the original message, (d) the worklog records it as
   fully handled.

## Expected Behavior

A confident `direct-request` or `meeting-scheduling` match should result in
exactly one reply being sent to the sender, end to end, through a live
deployment that follows the operator guide's documented steps — exactly as
`automated-notification` and escalation are already known (via T-139/T-140)
to work.

## Actual Behavior

Unknown — not yet exercised against live infrastructure. The fix is
verified at the mechanism level (S-004 glob matching against the real
`wildmatch` crate and the real config parser) but not at the integration
level (agent + pi's `bash` tool + `bob`'s live policy engine + a real
`himalaya` send over a live mailbox).

## Environment

- OS / platform: n/a until live-tested
- Language / runtime version: n/a
- Relevant dependencies: `bob` S-004 policy-control action gate, `himalaya`
  CLI, pi-agent's `bash` tool (external to this repo), deployed
  `email-skills` package
- Branch / commit: `dev-agent`, landed via `B-029`'s fix
  (`f303848`)

## Related

- Task: `T-139` (original happy-path validation — explicitly deferred
  `direct-request`), `T-140` (escalation/block/continuity validation — did
  not cover this path either)
- Bug: `B-029` (added the missing S-004 rule this bug live-validates; this
  bug was spun out of `B-029`'s own review because sending a real,
  unsupervised outbound email over a live SMTP relay is a materially
  different, less reversible action than editing docs files — the same
  judgment call `B-030` already made for the escalation-send shape).
  `B-030` — cross-linked, same kind of live-validation gap, for the
  escalation-send shape instead of reply-send. Both bugs ultimately need
  the same kind of live T-139/T-140-style validation pass before the
  package's full category set can be trusted in production, and could
  reasonably be validated together in one live session.
- Specification: `S-010-email-skills-for-pi-agent-himalaya-cli-reference-and-classification-driven-triage.md`

## Suspected Area

`the-intern/email-skills/.pi/skills/email-triage/references/categories/direct-request.md`
and `meeting-scheduling.md` (the agent-facing reply workflow), and the new
S-004 reply-send rule in `the-intern/docs/src/operator-guide/index.md` /
`the-intern/email-skills/README.md` (the policy-side admission) — not
suspected of being wrong, just never exercised live.

## Fix Verification

```bash
# Deploy per the operator guide (current S-004 rule set, including the
# B-029 reply-send rule), feed the scheduled job a message that confidently
# classifies as direct-request (or meeting-scheduling), and confirm the
# reply is actually sent (not blocked) and recorded as such in the worklog
# — the same live-validation shape T-139/T-140 used for the other paths.
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
