---
id: B-032
title: denied tool calls are unattributable — neither bob's audit record nor any
  log captures the arguments
severity: medium
status: open
created: '2026-08-05'
task: T-139
---

# denied tool calls are unattributable — neither bob's audit record nor any log captures the arguments

## Summary

B-030's live-validation session had 3 tool calls (2 `bash`, 1 `read`) denied by
S-004, but the exact denied command/argument text could not be recovered
afterward for diagnosis. `PolicyVerdictAuditPayload`
(`the-intern/service/crates/bob-core/src/types/records.rs:69-74`) only carries
`allow`/`reason`, and the `InboundFrame::Authz` arm in
`the-intern/service/crates/extension-ipc/src/multiplex.rs:213-238` emits no
tracing at any level — the existing `payload = ?event.payload` debug lines at
`multiplex.rs:61`/`:102` are on the unrelated `Event` frame path, not `Authz`.
This makes every future live S-004 validation blind to exactly what was
denied unless the denial happens to also be logged elsewhere.

## Reproduction Status

Status: confirmed

Confirmed by source inspection during B-030's live-validation diagnosis
session (2026-08-05): traced the full authorization path and found no code
path that logs a denied call's arguments.

## Evidence

- Logs / stack traces / failing assertions: `bob` audit trail entries for
  denied calls contain only `allow: false` and the fixed reason string
  `"no action rule permits tool '{tool}' with the supplied arguments"`
  (`the-intern/service/crates/policy-control/src/engine.rs:56-58`) — no
  arguments.
- Screenshots or recordings: n/a
- Failing command or test: n/a — this is a missing-instrumentation gap, not
  a failing test
- First diagnostic step if not yet reproduced: n/a, already confirmed by
  source inspection

## Reproduction Steps

1. Run `bob` with any S-004 rule set that denies a `bash` or `read` tool call
   from a live pi-agent session (e.g.
   `RUST_LOG=extension_ipc=debug cargo run -p bob -- serve`).
2. Trigger a denial (submit a tool call not admitted by any configured rule).
3. Attempt to find the denied command/arguments in `bob`'s `audit.jsonl` or
   server logs.
4. Observe: only the tool name (via the fixed deny-reason string) is
   present; the actual arguments are nowhere in the audit trail or logs.

## Expected Behavior

The denied tool call's arguments (command string for `bash`, path for
`read`, etc.) should be recoverable from logs or the audit trail for
post-hoc diagnosis of S-004 rule gaps.

## Actual Behavior

Neither the audit record (`PolicyVerdictAuditPayload`, `allow`/`reason`
only) nor any tracing output captures the denied call's arguments — only
the tool name survives, interpolated into the fixed deny-reason string in
`policy-control/src/engine.rs:56-58`.

## Environment

- OS / platform: n/a
- Language / runtime version: n/a
- Relevant dependencies: `bob` service crates `extension-ipc` and
  `policy-control`
- Branch / commit: `dev-agent`; discovered during B-030's live-validation
  diagnosis session, 2026-08-05

## Related

- Bug: `B-030` (the live-validation run that surfaced this gap; its retry is
  blocked on this fix landing first, per Architect escalation-review
  directive of 2026-08-05, so any future denial is attributable)
- Specification: `S-005-monitoring-audit-log-and-external-action-reporting.md`
  (defines `PolicyVerdictAuditPayload`'s scope — this fix must stay outside
  it; see Suspected Area)

## Suspected Area

`the-intern/service/crates/extension-ipc/src/multiplex.rs` (the
`InboundFrame::Authz` arm) — add a `tracing::debug!` call mirroring the
existing `Event`-path lines at `:61`/`:102`, emitting `session`, `tool`, and
`arguments`. This is diagnostic tracing only. **Do not fix this by widening
`PolicyVerdictAuditPayload`** — that struct is a `bob`-defined structured
field set under S-005 Component 1, so changing it is spec-affecting, and it
would durably persist untrusted email subject/body into a permanent JSONL
audit log for which S-005's Exclusions provide no deletion, redaction, or
retention workflow.

## Fix Verification

```bash
# With the tracing fix in place, deliberately trigger a denied bash call
# under RUST_LOG=extension_ipc=debug and confirm the full command string
# appears in the log.
cargo test -p extension-ipc
cargo fmt --all -- --check
# git diff must show no change to records.rs (PolicyVerdictAuditPayload
# untouched).
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
