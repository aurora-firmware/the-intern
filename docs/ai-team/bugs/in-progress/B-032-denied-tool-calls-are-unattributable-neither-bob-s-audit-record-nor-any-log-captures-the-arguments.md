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

### Session 2 — 2026-08-05

Addressed the Reviewer's FAIL verdict (below): the production fix from
Session 1 was confirmed sound, but the new regression test was flaky under
plain `cargo test -p extension-ipc` due to a `tracing-core`
callsite-interest race — a brand-new callsite's `Interest` is a global,
process-wide cache decided by whichever thread touches it first; several
pre-existing tests in the same file drive `handle_frame`'s `Authz` arm
with no subscriber at all, and under the parallel test harness one of
those can win the race and permanently cache "not interested" for the new
callsite before the `TracingCapture`-based test's thread-local override
ever gets consulted.

Reproduced the flake empirically against the as-committed code (`f903cae`)
before touching anything: 30 repeated runs of `cargo test -p
extension-ipc` produced 11 failures (~37% on this machine), always on the
same test and assertion — a solid red baseline matching the Reviewer's
report.

Implemented the Reviewer's second suggested remediation: added
`ensure_global_test_subscriber()` in `multiplex.rs`'s test module, guarded
by a `static std::sync::Once`, installing a permissive `tracing_subscriber::fmt`
subscriber (writing to `io::sink`, `TRACE` max level) as the process-wide
*global* default via `tracing::subscriber::set_global_default`. Called
once, as the first line of the existing shared `TracingCapture::new()`
helper, so both the new test and the pre-existing `TracingCapture`-based
test benefit identically, without touching any other test in this file or
`lib.rs`. Confirmed race-free by reading `tracing-core` 0.1.36's actual
source: installing a new global default unconditionally triggers a full
rebuild of every already-registered callsite's cached interest against
every currently-alive dispatcher, so the race is closed deterministically
regardless of scheduling order.

Verified: single run → 39 passed, 0 failed. Then 40 repeated invocations
(exceeding the requested 30+) → 40/40 clean, 0 failures. `cargo fmt --all
-- --check` stayed clean throughout. `cargo test --workspace` surfaced 3
unrelated failures in `pi-agent-supervisor` (process/signal-kill tests);
isolated and confirmed pre-existing and out of scope — that crate passes
64/64 in isolation and is untouched by this diff, consistent with this
repo's documented sandbox caveat about process/signal tests. Re-confirmed
`records.rs` untouched across the whole bug branch after the fix.

Committed the fix as a second cycle on the bug branch
(`test(extension-ipc): fix authz tracing test flake under parallel
harness`, `e78cf8a`), on top of the Session 1 fix commit (`f903cae`).
Nothing else remains outstanding; ready for re-review.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that diagnosis, fix, verification, and code quality passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->

### Review Verdict — 2026-08-05

FAIL

Diagnosis→fix evidence chain: complete and verified. The Diagnosis Log
records confirmed reproduction (source inspection plus a dynamic scratch
test), concrete evidence (grep results, `MonitoringVerdict`'s field list,
`PolicyVerdictAuditPayload`'s field list, the deny-reason `format!` call),
an isolated fault (the `Authz` arm of `handle_frame` never traces
`tool`/`arguments`), a confirmed root cause (missing instrumentation,
mirroring the existing `Event`-path pattern), and a planned fix/verification
contract. This matches what was implemented: one `tracing::debug!(session =
%session, tool = %tool, arguments = ?arguments, "extension authz call")`
call added in the `InboundFrame::Authz` arm of `multiplex.rs::handle_frame`
(`multiplex.rs:224-227`), placed after `PolicyEngine::evaluate_action` runs
and before `record_verdict`/the wire reply — `tool` and `arguments` are
still in scope and only borrowed here (`%tool`, `?arguments`), so nothing is
moved out from under the later `record_verdict`/`evaluate_action` calls.
`git diff dev-agent...HEAD -- the-intern/service/crates/bob-core/src/types/records.rs`
is empty — `PolicyVerdictAuditPayload` is untouched, honoring the bug's hard
constraint. The diff is minimal: one file, +49/-0, one commit
(`f903cae`), no unrelated changes. `cargo fmt --all -- --check` is clean and
`git status` is clean on the bug branch.

Blocking issue — Stage 2, Tests (independence):

- **File and location**: `the-intern/service/crates/extension-ipc/src/multiplex.rs`,
  new test `authz_frame_debug_tracing_captures_session_tool_and_arguments_for_denied_call`
  (added at ~line 392), and its production counterpart, the new
  `tracing::debug!` call at `multiplex.rs:227`.
- **What is wrong**: the new regression test is flaky under the bug's own
  Fix Verification command, `cargo test -p extension-ipc` (default, parallel
  test-threads — the same invocation CI uses via `cargo test --workspace`).
  I ran `cargo test -p extension-ipc` 50 times in a row (20 + 30, unmodified
  working tree, `git status` clean throughout) and observed 10 failures
  (~20%), always and only on this new test, always on the assertion
  `"expected at least one DEBUG line for the denied authz call"` — the DEBUG
  line the fix emits is intermittently entirely absent from the test's
  captured tracing output, even though `handle_frame` unconditionally
  executes the `tracing::debug!` call on every `Authz` frame. Re-running
  with `cargo test -p extension-ipc -- --test-threads=1` (serial), the same
  test passed 5/5 times, and the pre-existing analogous test
  (`tracing_monitoring_handle_record_event_emits_one_info_event_with_session_and_event_fields`,
  which also uses `TracingCapture`) never failed once in 30 parallel runs —
  isolating the flake to the new test/callsite, not the file's existing
  pattern.

  Root mechanism (verified against `tracing-core` 0.1.36 source,
  `~/.cargo/registry/.../tracing-core-0.1.36/src/callsite.rs` and
  `dispatcher.rs`): a `tracing` callsite's `Interest` is a *global*,
  process-wide cache, computed once on that callsite's first-ever
  invocation and reused thereafter unless explicitly rebuilt. `TracingCapture`
  uses `tracing::subscriber::set_default(...)`, a *thread-local* override —
  but many other tests in this same file (`authz_frame_returns_deny_...`,
  `distinct_sessions_do_not_cross_deliver_replies`,
  `route_for_session_reflects_new_default_...`, etc.) also unconditionally
  drive an `Authz` frame through `handle_frame`, without any subscriber
  override, and `cargo test`'s default harness runs all of these in
  parallel across OS threads. Because the new `tracing::debug!` callsite at
  `multiplex.rs:227` did not exist before this fix, whichever test thread
  happens to trigger it *first*, process-wide, decides its cached interest;
  if a concurrently-running plain test (no subscriber) wins that race while
  this test's `TracingCapture` dispatcher isn't visible to that thread at
  that instant, the callsite gets cached "not interested" and the DEBUG
  event silently no-ops for the rest of the process — including for this
  test's own later, correctly-scoped assertion. This is a known category of
  gotcha with `tracing::subscriber::set_default` + brand-new callsites in
  multi-threaded test binaries; it is not a defect in the production fix
  itself (the tracing call is correctly placed and correctly worded), it is
  a test-isolation defect in how the new test observes it.

- **What should change**: make the new test deterministic under the
  project's real `cargo test -p extension-ipc` invocation (no
  `--test-threads=1` workaround, since that isn't how the bug's Fix
  Verification or CI actually runs it). Acceptable approaches, in order of
  robustness:
  1. Serialize this test against any other test that can reach
     `handle_frame`'s `Authz` arm (e.g. a module-level
     `static AUTHZ_TRACING_TEST_LOCK: std::sync::Mutex<()>` held for the
     duration of `TracingCapture`-based tests), removing the cross-thread
     race window outright, or
  2. Replace the per-test `tracing::subscriber::set_default` +
     format-string-matching pattern with a subscriber/layer installed once
     for the whole test binary (e.g. via `std::sync::Once` at module load),
     that captures events into a buffer keyed by a per-test correlation id
     (the test already generates a unique `session` UUID and a unique
     command string — key the capture buffer on that instead of relying on
     which thread's tracing macro invocation gets dispatched), avoiding the
     runtime enable/disable interest-cache race entirely.
  Whichever approach is chosen, re-verify with repeated (30+) runs of plain
  `cargo test -p extension-ipc` — a single green run, or even 5, is not
  enough evidence given the ~20% observed failure rate.

Everything else evaluated cleanly (diagnosis chain, fix placement and
wording, `arguments` logged via `?arguments` consistent with the existing
`?event.payload` pattern, `records.rs` untouched, no unrelated changes,
clean `cargo fmt`, clean `git status`) — the only outstanding work is
closing this test-independence gap.
