---
id: B-032
title: denied tool calls are unattributable — neither bob's audit record nor any
  log captures the arguments
severity: medium
status: in-progress
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

### Diagnosis 1 — 2026-08-05

Reproduction status: Confirmed — via source inspection and a dynamic
(temporary, uncommitted) instrumented test.

Evidence captured:
- `grep -n "tracing::debug\|InboundFrame::Authz\|InboundFrame::Event"
  the-intern/service/crates/extension-ipc/src/multiplex.rs` shows
  `tracing::debug!` calls only at lines 61 and 102, both inside
  `record_event` (`Event` frame path). The `InboundFrame::Authz` arm of
  `handle_frame` (lines 215-238) contains no tracing call at any level.
- `MonitoringVerdict` (multiplex.rs:19-24) carries only `session`,
  `allow`, `reason` — no `tool`/`arguments` field — so `record_verdict`'s
  existing `tracing::info!` structurally cannot log the denied call's
  arguments even though it already logs `session`/`allow`/`reason`.
- `bob_core::types::records::PolicyVerdictAuditPayload`
  (`bob-core/src/types/records.rs:69-74`) is `{ allow: bool, reason:
  Option<String> }` — confirmed unchanged and out of scope for the fix.
- `policy_control::PolicyEngine::evaluate_action`'s deny branch
  (`policy-control/src/engine.rs:53-60`) builds `reason` via
  `format!("no action rule permits tool '{tool}' with the supplied
  arguments")` — only `tool` is interpolated; `arguments` never appears
  anywhere on the deny path.
- Dynamic confirmation: temporary integration test (written, run, deleted
  — not committed) built a deny-all `RulesetSnapshot`, called
  `SessionMultiplexer::handle_frame` with an `Authz` frame whose
  `arguments` contained a unique telltale command string, captured all
  tracing output at `TRACE` level, and asserted the telltale string does
  not appear anywhere in captured output. `cargo test -p extension-ipc
  --test b032_repro -- --nocapture` → 1 passed, confirming the command
  text is unrecoverable from tracing output.
- Baseline (pre-fix) gate state: `cargo test -p extension-ipc` → 38
  passed, 0 failed. `cargo fmt --all -- --check` → clean. `git status
  --porcelain` → empty after scratch test removal.

Isolated fault: `SessionMultiplexer::handle_frame`'s `InboundFrame::Authz`
arm in `the-intern/service/crates/extension-ipc/src/multiplex.rs` (lines
215-238). `tool` and `arguments` are destructured from the inbound frame
and passed to `PolicyEngine::evaluate_action`, but neither value is ever
passed to any tracing call or into `MonitoringVerdict` before the arm
returns.

Root cause or fault hypothesis: Confirmed root cause — a plain
missing-instrumentation omission. The `Event` frame path already has a
working diagnostic pattern (`tracing::debug!(session = %session, payload =
?event.payload, ...)` at lines 61/102) for exactly this purpose, but
equivalent instrumentation was never added to the `Authz` path when it was
written. `tool`/`arguments` are fully in scope at the fault location; they
are simply never emitted anywhere.

Planned verification:
1. Add a test in `multiplex.rs`'s existing `#[cfg(test)]` module
   (mirroring the existing `TracingCapture`-based test) asserting that
   after a denied `Authz` frame is handled, a captured `DEBUG`-level
   tracing line contains the frame's `session`, `tool`, and `arguments`
   values.
2. `cargo test -p extension-ipc` — full suite, including the new test,
   passes.
3. `cargo fmt --all -- --check` — passes.
4. `git diff` shows no change to `bob-core/src/types/records.rs`
   (`PolicyVerdictAuditPayload` untouched).
5. (Manual, optional) Run under `RUST_LOG=extension_ipc=debug` against a
   live denial and confirm the full command/arguments string appears in
   the log — not required for the automated gate.

Planned fix (not yet implemented): In the `InboundFrame::Authz` arm of
`multiplex.rs::handle_frame`, add one `tracing::debug!` call — mirroring
the `Event`-path pattern at lines 61/102 — emitting `session` (`%session`),
`tool`, and `arguments` (`?arguments`), placed where `tool`/`arguments` are
already in scope. Do not add `tool`/`arguments` fields to
`MonitoringVerdict` or `PolicyVerdictAuditPayload`, and do not route them
through `record_verdict` into persisted monitoring — this stays pure
tracing-only diagnostic output local to the `Authz` arm.

## Work Log

### Session 1 — 2026-08-05

Implemented the fix per the Diagnosis Log's fix contract, using TDD. Wrote
a failing test first:
`authz_frame_debug_tracing_captures_session_tool_and_arguments_for_denied_call`
in `multiplex.rs`'s existing `#[cfg(test)]` module, reusing the file's
existing `TracingCapture` helper. The test builds a deny-all
`RulesetSnapshot`, drives `SessionMultiplexer::handle_frame` with a
`TracingMonitoringHandle` and an `Authz` frame carrying a distinctive
command string, and asserts a captured `DEBUG`-level line contains the
session id, tool name, and the denied command text. Confirmed red against
pre-fix code: only the pre-existing INFO `"extension authz verdict"` line
appeared, no DEBUG line at all.

Implemented the minimal fix: one `tracing::debug!(session = %session, tool
= %tool, arguments = ?arguments, "extension authz call")` call added in
the `InboundFrame::Authz` arm of `handle_frame`, placed right after
`PolicyEngine::evaluate_action` runs (where `tool`/`arguments` are already
in scope) and before the existing `record_verdict`/wire-reply logic —
mirroring the `Event`-path pattern at lines 61/102. Added a short comment
noting this is diagnostic-only tracing (B-032), never persisted. Re-ran
the new test: green. No refactor was needed — the diff is a single
tracing line plus a comment in production code.

Ran the bug's full Fix Verification block: `cargo test -p extension-ipc`
(39 passed, 0 failed), `cargo fmt --all -- --check` (clean), and confirmed
via `git diff --name-only` that `bob-core/src/types/records.rs`
(`PolicyVerdictAuditPayload`) was not touched. Also ran `cargo build -p
bob` and `cargo test --workspace` as an extra sanity pass; both clean, no
regressions elsewhere in the workspace.

Committed the completed red→green cycle as a single commit
(`fix(extension-ipc): trace denied authz call session, tool, arguments`,
`f903cae`) on the bug branch. Nothing remains outstanding for this bug's
implementation.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that diagnosis, fix, verification, and code quality passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->
