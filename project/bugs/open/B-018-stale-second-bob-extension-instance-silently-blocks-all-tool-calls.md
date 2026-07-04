---
id: B-018
title: stale second bob extension instance silently blocks all tool calls
severity: medium
status: open
created: '2026-07-04'
---

# stale second bob extension instance silently blocks all tool calls

## Summary

pi loads extensions from its own `~/.pi/agent/settings.json` `packages` list
*in addition to* the `--extension <path>` flag bob passes (CR-003). When an
older release copy of `bob.ts` is present there (observed: the 0.1.3 release
archive, installed under the pre-CR-003 manual model), two bob extension
instances run in every supervised session. The stale instance speaks the
obsolete string verdict wire format (`"verdict":"allow"|"block"`), while the
service now sends a structured object (`{"allow":bool,"reason":…}`); the
stale hook parses every current verdict as invalid and fails closed, so
**every tool call is blocked** even though Policy Control returned allow and
the current extension's hook allowed. There is no detection, no version
handshake, and no operator-visible signal beyond duplicated audit records.
CR-003 made bob own extension delivery precisely to prevent this version
skew, but a leftover `packages` entry silently reintroduces it.

## Reproduction Status

Status: confirmed

Confirmed on the dev machine on 2026-07-04: `~/.pi/agent/settings.json`
contains `"packages": ["../../bob-the-intern/the-intern-bob-extension-0.1.3/bob.ts"]`;
that file's `handleInboundLine` accepts only string verdicts. Audit records in
`.tmp/bob-dev/state/bob/audit.jsonl` show every extension event and every
authz verdict duplicated in pairs per session (two instances, same
`BOB_SESSION_ID`, two socket connections), with `allow: true` verdicts while
interactive tool calls are blocked in the TUI.

## Evidence

- `~/.pi/agent/settings.json` `packages` entry pointing at
  `~/bob-the-intern/the-intern-bob-extension-0.1.3/bob.ts`.
- Old copy's parser (`handleInboundLine`): accepts only
  `frame.verdict === "allow" || frame.verdict === "block"`; anything else
  resolves `"error"` → fail closed → hook returns block.
- Current service wire format: `extension-ipc/src/framing.rs`
  `OutboundFrame::AuthzVerdict { verdict: PolicyVerdict }` serializes as
  `{"verdict":{"allow":…,"reason":…}}`.
- Audit log: paired duplicate records per tool call/event, e.g. session
  `f18275fd` on 2026-06-30 16:37 — two identical `allow` verdicts and two
  `tool_execution_start`/`tool_execution_end` records per instant.
- Operator symptom: every interactive `bob chat` tool call is denied with the
  extension's fail-closed warning while `bob audit tail` shows allow.

## Reproduction Steps

1. Install an old release extension archive and reference it from
   `~/.pi/agent/settings.json` `packages` (the pre-CR-003 install model).
2. Start the service (`./scripts/run-bob-dev.sh`) with a policy that allows
   `bash`/`read`/`write`.
3. Open `bob chat` and ask the agent to run any tool.
4. Observe the tool call is blocked despite the audit log recording
   `allow: true`, and every event/verdict appearing twice in the audit log.

## Expected Behavior

Exactly one bob extension instance — the one bob supplies via
`pi --extension` — participates in the authz path per session. If a second
instance (or a wire-format mismatch) is present, it is detected and surfaced
loudly: at minimum a distinguishable warning and audit signal; ideally the
session refuses to start or the stale instance disables itself, so an
allow-verdict-but-blocked state cannot exist silently.

## Actual Behavior

Both instances load silently. Each opens its own `extension.sock` connection
under the same session id and registers its own blocking `tool_call` hook.
The stale instance cannot parse current verdict frames, fails closed, and pi
blocks the tool because one of its hooks blocked. The operator sees blanket
denials that contradict the audit log, with no hint that a second, outdated
extension copy is the cause. Duplicate audit records are the only trace.

## Environment

- OS / platform: Linux (dev machine, single-user-local per ADR-008)
- Language / runtime version: pi-agent binary on PATH (tested version
  recorded in `README.md`); extension source `the-intern/extensions/bob.ts`
- Relevant dependencies: pi settings `packages` extension loading; release
  archive `the-intern-bob-extension-<tag>.tar.gz`
- Branch / commit: `dev-agent` @ 56787d1

## Related

- Specification: `project/specs/S-003-js-extension-for-pi-agent-event-forwarding.md`
  (CR-003 amendment: bob owns extension delivery, fail-closed),
  `project/specs/S-004-policy-control-pre-flight-admission-and-the-blocking-tool-call-authorization-path.md`
- Decision: ADR-009 (extension default path), ADR-010 (the `tool_call` gate
  is interactive chat's security gate — so silent blanket blocking is a
  usability *and* observability defect)

## Suspected Area

Wire-contract versioning between `the-intern/extensions/bob.ts` and
`the-intern/service/crates/extension-ipc/src/framing.rs` (no version field,
no handshake); absence of duplicate-instance detection in `bob.ts` and of any
diagnostics in the service when one session id opens multiple connections.
The immediate operator remediation (remove the stale `packages` entry from
`~/.pi/agent/settings.json`) is environmental and outside the repo; this bug
covers making the failure detectable/impossible, and documenting the
migration in the operator docs.

## Fix Verification

```bash
# From the-intern/extensions/: extension unit tests cover the new
# detection/handshake behaviour.
npm test
# From the-intern/service/:
cargo test --workspace
# Manual: with a deliberately stale second copy wired into pi settings,
# start a session — bob must surface a loud, attributable warning (or refuse
# the session) instead of silently blocking all tool calls.
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
