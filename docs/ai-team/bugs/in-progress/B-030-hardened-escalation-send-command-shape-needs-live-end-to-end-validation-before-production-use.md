---
id: B-030
title: hardened escalation-send command shape needs live end-to-end validation 
  before production use
severity: high
status: in-progress
created: '2026-08-04'
task: T-139
---

# hardened escalation-send command shape needs live end-to-end validation before production use

## Summary

PR #42 review found a critical command-injection vulnerability in the
`email-triage` skill's escalation-send command: untrusted email
subject/body were spliced as literal characters into single-quoted shell
arguments with no escaping. The fix (landed on `dev-agent` alongside this
bug) replaces that with a heredoc-based safe-embedding pattern in
`the-intern/email-skills/.pi/skills/himalaya/references/command-reference.md`
and `email-triage/SKILL.md`, and the corresponding S-004 allow-rule in
`the-intern/docs/src/operator-guide/index.md` and `email-skills/README.md`
was replaced to match. The shell-injection mechanism was empirically proven
safe (a real bash subshell run with an adversarial subject/body, `himalaya`
stubbed to print argv — all injection payloads failed to execute), and the
new S-004 glob pattern was checked against the real `wildmatch` v2.6.1 crate
(the exact library `bob`'s policy-control matcher uses) for both the
intended safe shape and several unsafe variants (unquoted-heredoc bypass,
bare/single-quoted `$BODY` regression, the old vulnerable one-liner, missing
`--`) — all passed. **What has not been done, and can't be done from a
docs-editing session:** a real end-to-end live validation — a real mailbox,
a real `bob` instance, a policy reload, and an actual scheduled-job run
sending a real escalation — the way T-139/T-140 validated the original
(now-replaced) command shape. Two concrete unknowns only that can close:
(a) how pi's external `bash` tool (source not in this repo) actually
executes a multi-line command string containing heredocs — completely
untested; (b) whether the new S-004 pattern, verified only against the
`wildmatch` crate directly, actually admits the real command as submitted by
a live agent session end to end through `bob`'s policy engine.

## Reproduction Status

Status: not yet reproduced (this is a validation gap, not a reproduced
failure — the new command shape has simply never been run live)

## Evidence

- Logs / stack traces / failing assertions: none yet — no live run attempted
- Screenshots or recordings: n/a
- Failing command or test: n/a
- First diagnostic step if not yet reproduced: deploy the package per the
  updated operator guide, add the new escalation S-004 rule, feed the
  scheduled job a message that classifies with low confidence, and confirm
  the escalation email is actually sent (not blocked) and matches the
  documented content requirements

## Reproduction Steps

1. Deploy `email-skills` to an isolated workspace exactly per
   `the-intern/docs/src/operator-guide/index.md`'s "Deploying the
   email-triage scheduled job" section, using the updated (post-fix)
   escalation S-004 rule.
2. Place an unseen test message the taxonomy cannot classify confidently.
3. Let the scheduled job run.
4. Confirm: (a) the agent successfully composes and runs the heredoc-based
   command without a syntax/tool error, (b) S-004 admits it (not blocked),
   (c) exactly one escalation email arrives with the expected subject/body,
   (d) the worklog records it correctly.

## Expected Behavior

The hardened escalation command should work end to end, exactly as the
original (now-replaced) command shape was proven to work in T-139/T-140:
agent composes it correctly, S-004 admits it, himalaya sends it, worklog
records it.

## Actual Behavior

Unknown — not yet exercised against live infrastructure. The fix is
verified at the mechanism level (shell-injection safety, S-004 glob
matching) but not at the integration level (agent + pi's bash tool + bob's
live policy engine + real himalaya send).

## Environment

- OS / platform: n/a until live-tested
- Language / runtime version: n/a
- Relevant dependencies: `bob` S-004 policy-control action gate, `himalaya`
  CLI, pi-agent's `bash` tool (external to this repo), deployed
  `email-skills` package
- Branch / commit: `dev-agent`, landed alongside this bug filing

## Related

- Task: `T-139` (original happy-path validation), `T-140` (original
  escalation/block/continuity validation) — both validated the *previous*
  command shape, now replaced
- Bug: `B-029` (missing S-004 rule + no live validation for
  `direct-request`/`meeting-scheduling` replies) — cross-linked: whoever
  resolves B-029 must build the new reply/forward S-004 rule against the
  hardened heredoc pattern this bug's fix established in
  `command-reference.md`, not the vulnerable pattern that existed before it.
  Both B-029 and this bug ultimately need the same kind of live
  T-139/T-140-style validation pass before the package's full category set
  can be trusted in production.
- Specification: `S-010-email-skills-for-pi-agent-himalaya-cli-reference-and-classification-driven-triage.md`

## Suspected Area

`the-intern/email-skills/.pi/skills/email-triage/SKILL.md`,
`the-intern/email-skills/.pi/skills/himalaya/references/command-reference.md`
(the agent-facing command construction), and the S-004 escalation rule in
`the-intern/docs/src/operator-guide/index.md` /
`the-intern/email-skills/README.md` (the policy-side admission).

## Fix Verification

```bash
# Live-validate the hardened escalation-send command the same way T-139/T-140
# validated the original: deploy to an isolated workspace, add the updated
# S-004 escalation rule, feed a low-confidence test message, confirm the
# agent's heredoc-based command runs, S-004 admits it, himalaya sends
# exactly one escalation email, and the worklog records it correctly.
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
