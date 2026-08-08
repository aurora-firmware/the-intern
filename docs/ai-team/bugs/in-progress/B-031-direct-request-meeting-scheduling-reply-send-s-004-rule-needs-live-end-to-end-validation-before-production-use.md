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

### Diagnosis 1 — 2026-08-05

Reproduction status: **Blocked — external provider quota, same class of
blocker as `B-030`, earliest retry ~2026-08-08.** Live validation cannot
be attempted at all (not even started) because pi's only authenticated
model provider is fully quota-exhausted.

Evidence captured:
- Fresh, independent direct probe, outside `bob` entirely:
  `date -u +"%Y-%m-%dT%H:%M:%SZ"` → `2026-08-05T15:44:02Z`, then `timeout
  60 pi -p "Say the single word: ping"` → `You have hit your ChatGPT
  usage limit (plus plan). Try again in ~4174 min.` (exit code 1).
- `pi --version` → `0.80.3`, confirming the binary itself is present and
  runs — the failure is the provider's usage-limit response, not a
  tool/install error.
- The ~4174 min figure (≈69.6h from 15:44 UTC ≈ 2026-08-08 ~13:18 UTC) is
  consistent with, and slightly decayed from, `B-030`'s own independently
  captured ETA of ~72h from 2026-08-05T13:28 UTC and a separate
  orchestrator probe (~4175 min) taken minutes earlier — three
  independent samples over ~2h16m all point to the same single quota
  window, not three different outages.
- Confirmed B-031's fix content needs no further code-level attention
  before it can be live-validated: `git log --oneline f303848..HEAD --
  the-intern/docs/src/operator-guide/index.md
  the-intern/email-skills/README.md` shows no commits have touched either
  file since B-029's fix landed. The S-004 allow-rule for the `himalaya
  template reply` -> `himalaya template send` shape
  (`operator-guide/index.md:892`, `email-skills/README.md:231`) is
  present, identical between both files, and unchanged. No re-run of the
  wildmatch harness was needed — B-029's own review already covered that
  exhaustively.

Isolated fault: Not applicable — no code-level fault. The blocking
condition is entirely external: pi's only authenticated model provider
(`openai-codex`, ChatGPT Plus) has no completions available at all, for
any prompt, inside or outside `bob`, until the quota window resets.

Root cause or fault hypothesis: External infrastructure blocker — the
same ChatGPT Plus usage-limit exhaustion already diagnosed for `B-030`
(~2026-08-08 ETA), now independently re-confirmed for `B-031` rather than
merely inherited. No live validation of the S-004 reply-send rule can be
attempted while this holds.

Planned verification: Deferred until the provider quota resets
(~2026-08-08). At that point, follow B-031's existing Fix Verification
section: deploy `email-skills` per the operator guide's current
(post-B-029) S-004 rule set, feed the scheduled job a message that
confidently classifies as `direct-request` or `meeting-scheduling`, and
confirm the reply is actually composed, admitted by S-004, sent, and
recorded in the worklog. `B-030` and `B-031` can reasonably be
validated together in one live session once the blocker clears.

**Escalation disposition note (2026-08-05):** The Developer returned
ESCALATE (no code-level fault, external blocker only) with a structured
escalation request asking whether B-031 should stay in
`bugs/in-progress/` and be validated together with `B-030` once the
quota clears. This is the identical class of blocker, and the identical
procedural question, that the Architect already resolved for `B-030` via
Phase 1 escalation-review earlier today (2026-08-05): stay in
`in-progress/` (no `blocked/` lifecycle state exists for bugs; `open/`
would invite a fresh pickup that re-hits the same lockout), no ADR or
design change is warranted, and no Phase 2 human escalation is needed for
a pure ~72h infrastructure wait. The bug-fix loop applied that
already-established precedent directly here rather than spawning a
duplicate Architect consultation for an identical procedural question
already answered same-day — documented here for auditability rather than
silently skipped.

**Authorization update (2026-08-05, human):** The human confirmed both
`daneel@aurorafw.com` (the environment's configured `himalaya` sender
account) and `jose.moreno@aurorafw.com` (the human's own address) are test
addresses, and authorized live reply-send tests between them. For the
retry, the test `direct-request`/`meeting-scheduling` message should
arrive as if from `jose.moreno@aurorafw.com` (or another controlled test
sender) so the agent's reply is sent from `daneel@aurorafw.com` back to
`jose.moreno@aurorafw.com`, rather than using `daneel@aurorafw.com` for
both ends the way `B-030`'s initial (interrupted) attempt did. This does
not change the S-004 rule or fix content under test — only the live
test's message routing.

### Diagnosis 2 — 2026-08-08

Reproduction status: **Confirmed — the S-004 reply-send rule this bug
exists to validate is proven correct against a real, live, agent-composed
command, but the overall live-validation success criteria (a delivered
reply email, worklog recording "fully handled") are not met this cycle,
blocked by a newly-discovered, independent defect outside this bug's own
scope.** pi's provider quota reset as anticipated. Validated together with
`B-030` in one combined live session, per both bugs' own cross-linked note.

Evidence captured:
- Same deployment (isolated `bob` instance, deployed workspace, full S-004
  rule set from the operator guide, `RUST_LOG=extension_ipc=debug` from the
  first tick) as `B-030`'s Diagnosis 2 entry — not repeated here in full;
  see that entry for the shared setup detail, including the project-trust
  gate (`B-035`) and worker-reaping gap (`B-036`) discovered and worked
  around along the way.
- Injected one synthetic trigger message via `himalaya template write | ...
  template send`, headers set so it appears to be **from
  `jose.moreno@aurorafw.com` to `daneel@aurorafw.com`** per the human's
  2026-08-05 authorization update: subject "Confirming our call Tuesday at
  2pm PT", body confirming an already-arranged meeting time (a clean,
  unambiguous `meeting-scheduling` "confirm or acknowledge a stated time"
  case per `references/categories/meeting-scheduling.md` — deliberately not
  an availability-decision case, so a confident autonomous reply was the
  correct expected outcome).
- Live session `9377acc6-0aba-429b-a7eb-4f5c3281d6cf` (same session that
  handled `B-030`'s trigger message) read the message, classified it as a
  confident `meeting-scheduling` acknowledgement (correct), and composed
  the reply-send exactly per `command-reference.md`'s "Replying" section as
  one `bash` tool call:
  ```
  BODY=$(cat <<'R7K2M9Q4V6N8P1S3T5U0'
  Thanks Jose — confirming Tuesday, August 11 at 2:00pm PT for the Q3 roadmap sync.

  Talk then,
  Daneel
  R7K2M9Q4V6N8P1S3T5U0
  )
  himalaya template send "$(himalaya template reply 105 -- "$BODY")"
  ```
  Confirmed via `bob`'s `extension_ipc` debug trace: `extension authz call
  ... tool=bash arguments=Object {"command": "BODY=$(cat <<'R7K2M9Q4V6N8P1S3T5U0'..."}`
  immediately followed by `extension authz verdict ... allow=true
  reason=None` (2026-08-08T15:43:49Z) — **S-004's `B-029` reply-send rule
  correctly admitted the real, live-composed command**, matching the
  pattern statically verified in `B-029`'s own review. This is the specific
  thing this bug was filed to validate, and it passed.
- The command then ran via pi's `bash` tool without any shell/tool syntax
  error, but `himalaya` itself failed:
  `tool_execution_end` captured `... executing reply template command ...
  getting messages 105 from folder INBOX ... executing send template
  command ... building new smtp context` followed by `Error: 0: cannot
  parse template` (`send.rs:77`), `isError` reflected in the tool result.
  Independently, manually reproduced the identical `himalaya` failure
  outside `bob` entirely with the simplest possible template
  (`command-reference.md`'s own "Observed" `template write` example, fed to
  `template send` as a positional argument), and confirmed piping the exact
  same content into `template send` via stdin instead succeeds
  (`Message successfully sent!`). **This is a `himalaya v1.2.0` CLI defect
  in its positional-argument template parsing, unrelated to `bob`, S-004,
  or the heredoc-safety pattern** — filed as new bug `B-034`, cross-linked
  below. Notably, `B-030`'s escalation command (same session, same
  workspace, same `himalaya` binary) succeeded, because that command uses
  the pipe form (`... | himalaya template send`) that `B-034` confirms
  works, while `B-031`'s reply-send pattern uses the positional-argument
  form (`himalaya template send "$(...)"`) that `B-034` confirms is broken.
- The agent then attempted to debug the failure with a follow-up inspection
  command (`himalaya template reply 105 -- "$BODY"`, without the `template
  send` pipe) — correctly denied by S-004 (`allow=false`, no rule admits a
  bare `template reply` call), since that narrower rule is intentionally
  scoped to the exact composed shape, not general-purpose `himalaya`
  exploration. The worklog entry the agent then wrote attributes the
  overall failure to "blocked by the action-authorization gate" — a minor
  misdiagnosis on the agent's part (conflating the himalaya-level failure
  of the *admitted* first command with the correctly-*denied* second
  debugging command), but the functional outcome is still fully correct and
  safe per `SKILL.md`/`references/escalation.md`'s block-handling rule:
  `worklog/2026-08-08.md` records `## 15:43 — Confirming our call Tuesday
  at 2pm PT (from Jose Moreno <jose.moreno@aurorafw.com>)` /
  `- Done: ... attempted to send a reply ..., but the reply action did not
  complete and a subsequent retry/inspection command was blocked ...` /
  `- Left: blocked by the action-authorization gate ...` / `- Next: closes
  once an allow rule admits this call — re-check at the next first-run
  reconciliation.` — no false "handled" claim, no autonomous fallback
  action taken, message correctly left open.
- No email was actually delivered to `jose.moreno@aurorafw.com` for this
  message (confirmed: the only `"Message successfully sent!"` in this
  session's log corresponds to `B-030`'s escalation call, not this one).
- Environment cleaned up as one combined pass with `B-030`'s — see that
  bug's Diagnosis 2 entry for full cleanup detail (schedule removed, `bob`
  shut down gracefully, both synthetic messages moved to `INBOX.Trash`, the
  7 real relocated messages restored with unseen flag intact,
  `~/.pi/agent/trust.json` reverted, scratch directories removed, `git
  status` clean throughout).

Isolated fault: not in this bug's own scope. `bob`'s S-004 reply-send rule
and the `email-skills` package's heredoc-based reply construction are both
confirmed correct against the real live-composed command. The isolated
fault for why the live send did not complete is in the external `himalaya
v1.2.0` binary's `template send` positional-argument parsing — tracked as
`B-034`, not this bug.

Root cause or fault hypothesis: `B-034` (cross-linked). This bug's own
hypothesis — that the S-004 rule and heredoc pattern might not actually
admit/work against a real live agent-composed command — is refuted: they
do. The reason the live end-to-end criteria are not met this cycle is
entirely external to what this bug was created to test.

Planned verification: once `B-034` is resolved (e.g. `command-reference.md`'s
"Replying"/"Composing and Sending" sections switched to the working pipe
form, matching the pattern the escalation flow already uses, and the
corresponding S-004 rule shape updated to match if the command text
changes), re-run this bug's live validation end to end and confirm a real
reply email is delivered and the worklog records the message as fully
handled — the same evidence standard `B-030` just met.

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

### Session 1 — 2026-08-08

Ran the live end-to-end validation this bug has been blocked on since
2026-08-05, combined with `B-030` in one session per both bugs' own
cross-linked note, now that pi's provider quota reset. Full shared setup
detail (deployment, the project-trust gate and worker-reaping gap
discovered and worked around, cleanup) is recorded once in `B-030`'s
Session 1 entry rather than duplicated here.

Injected a synthetic `meeting-scheduling` confirmation message appearing to
be from `jose.moreno@aurorafw.com` to `daneel@aurorafw.com`, per the
human's authorization update. The live agent session classified it
correctly (confident `meeting-scheduling` acknowledgement) and composed the
reply-send command exactly per `command-reference.md`'s documented
"Replying" pattern. `bob`'s S-004 `B-029` reply-send rule admitted the real
command (`allow=true`) — the specific thing this bug exists to validate,
and it passed cleanly. However, the actual `himalaya template send
"$(...)"` call then failed at the `himalaya` CLI level with `cannot parse
template`, a defect unrelated to `bob`/S-004/the heredoc pattern. Confirmed
this independently by reproducing the identical failure manually outside
`bob`, and confirmed the same content piped via stdin instead of passed
positionally succeeds. Filed this as new bug `B-034` rather than patching
anything inline, per this session's explicit instructions not to attempt
an on-the-spot fix. `B-030`'s escalation command, run in the same session
against the same `himalaya` binary, succeeded, because it already uses the
working pipe form — so this is specifically a defect in the reply-send
pattern's documented composition, not a general `himalaya`/environment
failure.

The agent's own worklog entry safely recorded the message as blocked (not
falsely as sent or handled) and left it open for retry, matching
`SKILL.md`'s block-handling contract, even though its stated reason
("blocked by the action-authorization gate") slightly mis-attributes the
failure to S-004 rather than to the himalaya-level parse error — noted in
Diagnosis 2 as a minor observation, not a defect requiring action, since
the functional safety outcome (no autonomous fallback, no false "handled"
claim) is correct either way.

This bug does not close this cycle: the S-004 rule hypothesis it was filed
to test is now proven correct, but the overall live-validation success
criteria (a delivered reply, worklog "fully handled") remain unmet, blocked
on `B-034`. Recommend the Reviewer confirm this Diagnosis Log's evidence
chain, keep `B-031` in `bugs/in-progress/` (not `resolved/`), and treat
`B-034`'s resolution as the prerequisite for this bug's next retry cycle.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that diagnosis, fix, verification, and code quality passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->
