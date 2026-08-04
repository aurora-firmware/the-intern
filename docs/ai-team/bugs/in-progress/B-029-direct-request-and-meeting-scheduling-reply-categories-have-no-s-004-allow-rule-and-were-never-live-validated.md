---
id: B-029
title: direct-request and meeting-scheduling reply categories have no S-004 
  allow-rule and were never live-validated
severity: high
status: in-progress
created: '2026-08-04'
task: T-139
---

# direct-request and meeting-scheduling reply categories have no S-004 allow-rule and were never live-validated

## Summary

The `email-triage` skill's `direct-request` and `meeting-scheduling`
categories both require sending a reply via `himalaya template reply` ->
`himalaya template send`, but neither the operator-guide's nor the package
README's S-004 action-rule lists include an allow-rule matching that command
shape — only the escalation-send rule is present. An operator who deploys
exactly per the shipped documentation gets these two categories permanently
denied by S-004's default-deny, silently diverging from the behavior
`SKILL.md`, `direct-request.md`, and `meeting-scheduling.md` describe.
Discovered during PR #42 review (`pr-42-review.md`, finding 2).

## Reproduction Status

Status: confirmed

Confirmed by static inspection, not live reproduction: neither
`the-intern/docs/src/operator-guide/index.md` (the "Add scoped S-004 action
rules for the deployed workspace" section) nor
`the-intern/email-skills/README.md` ("Verified S-004 action rules for the
happy path") contains any `bash` rule matching a `himalaya template
reply`/`template send` command shape. The only `template`-related rule
either document ships is the escalation-send rule
(`operator-guide/index.md`, pattern `"himalaya template write -H *To:* -H
*Subject:Escalation:* *| himalaya template send*"`).

This is corroborated by T-139's own Work Log, Session 2: "The direct-request
route was rejected because it required recurring outbound mail
authorization. A safe automated-notification route [was used instead]." The
team substituted `automated-notification` (a no-reply, file-only category)
for the happy-path validation and never returned to add the missing rule or
validate `direct-request`/`meeting-scheduling`. T-140 covered only
escalation, S-004-block, and skipped-tick continuity — not this path either.

## Evidence

- Logs / stack traces / failing assertions: none (documentation-completeness
  gap, not a code assertion failure)
- Screenshots or recordings: n/a
- Failing command or test: n/a — the gap is an absent policy rule, not a
  failing test
- First diagnostic step if not yet reproduced: n/a (already confirmed by
  inspection, see Reproduction Status)

## Reproduction Steps

1. Deploy the `email-skills` package to a workspace exactly per
   `the-intern/docs/src/operator-guide/index.md`'s "Deploying the
   email-triage scheduled job" section, adding only the S-004 rules listed
   there.
2. Place an unseen test message in the mailbox that the taxonomy classifies
   confidently as `direct-request` or `meeting-scheduling`.
3. Let the scheduled job run.
4. Observe: the `himalaya template send "$(himalaya template reply ...)"`
   call is denied by S-004 (no allow-rule matches it), so the reply is never
   sent; the run instead records a blocked open worklog item.

## Expected Behavior

Per `SKILL.md` and the category workflow docs, a confident `direct-request`
or `meeting-scheduling` match should result in exactly one reply being sent
to the sender, and this should be achievable by following the operator
guide's documented deployment steps end to end (as `automated-notification`
and escalation already are).

## Actual Behavior

Following the operator guide's deployment steps exactly leaves
`direct-request` and `meeting-scheduling` replies permanently blocked by
S-004's default-deny, because no shipped rule set admits the
`template reply`/`template send` command shape. The message is instead
recorded as a blocked open worklog item every run, with no indication in the
docs that this is expected or that additional configuration is required.

## Environment

- OS / platform: n/a (documentation/configuration gap, reproducible on any
  platform matching the operator guide's prerequisites)
- Language / runtime version: n/a
- Relevant dependencies: `bob` S-004 policy-control action gate, `himalaya`
  CLI, deployed `email-skills` package per PR #42
- Branch / commit: `dev-agent` (PR aurora-firmware/the-intern#42, head
  `ec1fbfed51175ded359e02019ccac1a739bbbe49` at time of filing)

## Related

- Task: `T-139` (happy-path validation — explicitly skipped direct-request),
  `T-140` (escalation/block/continuity validation — did not cover this
  path), `T-141` (operator guide — ships the incomplete rule list)
- Specification: `S-010-email-skills-for-pi-agent-himalaya-cli-reference-and-classification-driven-triage.md`
- Bug: `B-030` — cross-linked. A separate review finding identified that the
  `template reply`/`template forward` command shape this bug's fix will need
  a rule for was, until `B-030`'s fix, vulnerable to command injection from
  untrusted email content (naive literal-text splicing into shell arguments,
  no escaping). `B-030` established a safe heredoc-based pattern for this
  exact command family in
  `the-intern/email-skills/.pi/skills/himalaya/references/command-reference.md`'s
  "Embedding message-derived text safely" section. **Whoever resolves this
  bug must build the new `direct-request`/`meeting-scheduling` S-004 rule
  against that hardened pattern** (`"$SUBJECT"`/`"$BODY"` loaded via quoted
  heredoc, `--` before the body argument) — not against the vulnerable
  pattern that existed in the docs before `B-030`'s fix. Both bugs
  ultimately need the same kind of live T-139/T-140-style validation pass.

## Suspected Area

`the-intern/docs/src/operator-guide/index.md` (S-004 action-rule list) and
`the-intern/email-skills/README.md` ("Verified S-004 action rules for the
happy path") — both need an additional, live-validated `bash` allow-rule for
the reply-send command shape, plus live validation of the
`direct-request`/`meeting-scheduling` paths analogous to T-139/T-140.

## Fix Verification

```bash
# Deploy per the (updated) operator guide, feed the scheduled job a message
# that confidently classifies as direct-request (or meeting-scheduling),
# and confirm the reply is actually sent (not blocked) and recorded as such
# in the worklog — the same live-validation shape T-139/T-140 used for the
# other paths.
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
