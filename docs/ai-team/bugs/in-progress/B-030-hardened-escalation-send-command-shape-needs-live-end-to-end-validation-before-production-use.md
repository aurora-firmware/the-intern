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

### Diagnosis 1 — 2026-08-05

Reproduction status: **Blocked — external provider quota, earliest retry
2026-08-08.** Live validation was started but interrupted before reaching
the escalation-send step this bug needs evidence for. Not a code-level
failure to reproduce; the target code path was never exercised to
completion.

Evidence captured:
- Deployed an owner-only isolated workspace (mode 700) with
  `manager_address = "daneel@aurorafw.com"` used as both sender and
  recipient, so the live send could be fully controlled and verified
  without touching any third party. Ran an isolated `bob` instance with the
  exact `[[policy.action_rules]]` set copied verbatim from
  `the-intern/docs/src/operator-guide/index.md`.
- The real mailbox's two pre-existing unrelated unseen messages (PR #42
  thread) were temporarily relocated to `INBOX.Trash` and restored
  afterward with their unseen flag verified intact.
- Injected one synthetic, self-controlled trigger message straddling
  `automated-notification`/`suspected-spam`/`meeting-scheduling` signals
  (to force escalation) and containing adversarial shell metacharacters
  (`` ` ``, `$(...)`, `;`, a leading-dash line) as an extra live
  injection-safety check. Registered a 1-minute scheduled job and tailed
  the audit log.
- **The first live tick (session `e3f69d6d-...`, 13:28:01 UTC) did run the
  agent and issued real tool calls** — 2 `bash` calls and 1 `read` call —
  all three denied with `"no action rule permits tool '<x>' with the
  supplied arguments"`. The exact denied command/argument text is **not
  recoverable**: `bob`'s audit record for `tool_execution_start`/verdict
  events never carries the arguments (`PolicyVerdictAuditPayload` is
  `allow`/`reason` only — `the-intern/service/crates/bob-core/src/types/records.rs:69-74`),
  and the `InboundFrame::Authz` arm in
  `the-intern/service/crates/extension-ipc/src/multiplex.rs:213-238` emits
  no tracing at any level (the existing `payload = ?event.payload` debug
  lines at `multiplex.rs:61`/`:102` are on the unrelated `Event` frame
  path, not `Authz`).
- Per `SKILL.md:66-104`'s run order (step 1: `bash` existence check on
  `worklog/<date>.md` + worklog/reference reads; step 2: `bash` envelope
  list; escalation is step 3, reached only after a message is read and
  classified low-confidence), a first tick issuing exactly 2 bash + 1 read
  before stopping never got past steps 1-2 — the escalation rule itself
  was never evaluated. These three denials carry no signal about the
  hardened escalation command shape under test. They may, however, be a
  real signal about a *different*, separately-suspected gap: see new bug
  filed for the opening-call rule coverage below.
- After restarting `bob` with `RUST_LOG=extension_ipc=debug` (to capture
  full payloads for any future denial — later found not to cover the
  `Authz` path either, see spin-off bug below), the next three ticks made
  **zero** tool calls and instead surfaced verbatim:
  `"errorMessage": "You have hit your ChatGPT usage limit (plus plan). Try
  again in ~4306 min."` (model `gpt-5.5`, provider `openai-codex`). A
  direct manual probe, `pi -p "Say the single word: ping"`, reproduced the
  identical block (`~4303 min` remaining) outside of `bob` entirely,
  confirming this is a pi/provider-side quota exhaustion, not a `bob` or
  skill defect. No fallback provider is authenticated in this environment.
- No `worklog/*.md` file was ever created in the deployed workspace, and
  the trigger message's Seen flag was never set — consistent with the run
  never getting past its first, denied tool calls.
- Environment fully cleaned up afterward: scheduled job removed, `bob`
  shut down cleanly (six-phase shutdown, sockets removed), synthetic
  trigger message moved to `INBOX.Trash` (soft-deleted, not purged, for
  follow-up), the two real messages restored to `INBOX` unseen, working
  tree clean on the bug branch.

Isolated fault: none isolated. The two unknowns B-030 exists to close —
(a) how pi's `bash` tool executes a real heredoc-bearing command, and
(b) whether the live S-004 `wildmatch` engine admits the real
agent-composed escalation command — were never reached by any session.

Root cause or fault hypothesis: **Deliberately not established.** The
blocking factor is an external environment constraint (pi's only
authenticated model provider fully quota-exhausted for ~72h from
2026-08-05T13:28 UTC), not a demonstrated defect in the hardened heredoc
pattern, the SKILL.md instructions, or the S-004 rule set. Architect
escalation review (2026-08-05) classified this as an execution/
infrastructure blocker, not a design or architecture question — no ADR
warranted, no human escalation required. The fix landed on `dev-agent`
already (`af5132a`); this bug's residual risk while it stays open is
acceptable because a wrong-but-*narrow* S-004 rule fails safe (S-004
denies → recorded as a blocked worklog item per `SKILL.md:164-168`, never
an autonomous unsafe send) — the dangerous failure direction (a rule too
*wide*) was already checked statically against the real `wildmatch` 2.6.1
crate for the unquoted-heredoc bypass, bare `$BODY`, missing `--`, and the
pre-fix literal-splice shape, and the shell-injection property itself was
proven with a real bash subshell and an argv-printing stub — neither of
which needs live infrastructure.

Planned verification: Resume once pi's `openai-codex` quota resets (ETA
~2026-08-08) or an alternate authorized model provider/credential becomes
available. Reuse the documented setup above (workspace layout,
config.toml rule set, trigger-message construction — deploys and starts in
under two minutes), but start `bob serve` with the `Authz`-path tracing fix
(spin-off bug filed below) in place from the very first tick, so any
denial's exact command text is captured immediately instead of being lost.
Let the run reach the escalation-send step and confirm: the heredoc
command runs without a pi `bash`-tool syntax/execution error, the hardened
escalation rule admits it (`allow=true`), exactly one escalation email
arrives at `manager_address`, and the worklog records it correctly — the
same AC-1-style evidence T-140 captured for the original command shape.
Two spin-off bugs (tracing gap; suspected opening-call rule-coverage gap)
are independently actionable now, without live model access, and should
be worked during the wait.

**Architect escalation note (2026-08-05):** Per Phase 1 escalation-review,
this bug stays in `bugs/in-progress/` rather than returning to `open/` —
there is no `blocked/` lifecycle state for bugs, and `open/` would invite a
fresh pickup that re-derives the environment and re-hits the same lockout.
Do not resolve B-030 on the strength of static evidence alone: it closes
only once a retry produces an `allow=true` verdict on the escalation `bash`
call, exactly one delivered escalation email, and a worklog entry recording
it.

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
