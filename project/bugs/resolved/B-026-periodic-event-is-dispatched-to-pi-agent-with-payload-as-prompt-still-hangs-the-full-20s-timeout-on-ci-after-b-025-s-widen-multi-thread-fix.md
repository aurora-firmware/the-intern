---
id: B-026
title: periodic_event_is_dispatched_to_pi_agent_with_payload_as_prompt still 
  hangs the full 20s timeout on CI after B-025's widen+multi_thread fix
severity: high
status: resolved
created: '2026-07-17'
---

# periodic_event_is_dispatched_to_pi_agent_with_payload_as_prompt still hangs the full 20s timeout on CI after B-025's widen+multi_thread fix

## Summary

B-025 diagnosed the CI failures of
`serve::tests::periodic::periodic_event_is_dispatched_to_pi_agent_with_payload_as_prompt`
(`the-intern/service/crates/bob/src/serve.rs`) as a test timing-margin issue —
a `#[tokio::test(flavor = "current_thread")]` test whose 5s outer timeout was
theorized to be insufficient under CI-runner scheduling contention (two
workflow runs firing for the same commit, since PR #38's head branch is
`dev-agent`). The fix (commit `d1a51c7`, merged) switched the test to
`flavor = "multi_thread", worker_threads = 2` and widened both outer
timeouts from 5s to 20s. That fix was reviewed PASS and merged, but the very
next CI run failed the **same test, same assertion, same panic message**
again — and critically, the failure log shows `finished in 20.16s`, meaning
the test consumed the *entire* widened 20-second budget without the idle
reaper's release ever being observed. This is a much stronger signal than
the original B-025 evidence: exhausting a 20x-widened timeout (200x the
configured 100ms `pi_agent_idle_reap_timeout`) is far less consistent with
"occasionally not enough scheduling headroom" and more consistent with
either (a) a genuine hang/deadlock specific to the CI environment that B-025
did not identify, (b) a regression introduced by the `multi_thread` runtime
switch itself, or (c) CI-runner resource starvation severe enough (e.g. CPU
quota/cgroup throttling causing multi-second-to-tens-of-seconds freezes,
not just slower scheduling) that no reasonable fixed timeout is safe. B-025
should be treated as necessary-but-insufficient, not wrong to have
attempted — but its "just widen + change flavor" fix did not resolve the
underlying issue and a deeper investigation is needed before merging PR #38
with confidence in a stable CI signal.

## Reproduction Status

Status: confirmed on CI (second and third consecutive CI failure of this
same test, across three separate pushes to `dev-agent`/PR #38 — the first
two with the original 5s timeout, pre-B-025; this third one with B-025's
20s timeout + multi_thread already applied). Still never reproduced locally
despite deliberate contention simulation in both B-025's diagnosis and its
implementation session.

## Evidence

- CI run (post-B-025-merge): `https://github.com/aurora-firmware/the-intern/actions/runs/29608348894/job/87976900354`
  — `Tests` job:
  ```
  thread 'serve::tests::periodic::periodic_event_is_dispatched_to_pi_agent_with_payload_as_prompt' panicked at crates/bob/src/serve.rs:2025:14:
  idle reaper must eventually release the one-shot session: Elapsed(())
  test result: FAILED. 157 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 20.16s
  ```
  Note the line number shifted from `:2003`/`:2002` (pre-B-025) to `:2025`
  because B-025's diff added lines above it — same call site, same
  `.expect("idle reaper must eventually release the one-shot session")`.
- The *parallel* matrix job for the same commit
  (`https://github.com/aurora-firmware/the-intern/actions/runs/29608346872/job/87976893577`)
  passed, with the entire `Tests` job finishing in 43s total (all ~275
  tests across the workspace) — meaning the passing job was not itself
  under heavy load system-wide, which is at least mildly inconsistent with
  a pure "whole runner is CPU-starved" explanation, though it doesn't rule
  out asymmetric load between the two specific jobs.
- Two prior CI failures on the *pre-B-025* code (5s timeout,
  `current_thread`) are documented in B-025's own bug file:
  `https://github.com/aurora-firmware/the-intern/actions/runs/29561962415/job/87826174214`
  and
  `https://github.com/aurora-firmware/the-intern/actions/runs/29606972803/job/87972449137`
  — both also `Elapsed(())` at the same assertion, both also only on one of
  two parallel matrix jobs.
- B-025's local verification (10-13 isolated runs, 20 concurrent runs under
  simulated contention with two background full-suite loops) never
  reproduced any failure — the failure is CI-environment-specific and has
  now defeated a 4x timeout increase plus a runtime-flavor change.

## Reproduction Steps

Not reproducible on demand locally. Push a commit to `dev-agent` (PR #38's
head branch, which triggers two concurrent CI workflow runs for the same
commit) and observe whether one of the two `Tests` jobs fails on this test.
Has now failed 3 out of 3 times this has been observable in CI across two
different timeout configurations (5s pre-B-025, 20s post-B-025).

## Expected Behavior

The test should pass reliably on CI. If the underlying cause is CI-runner
resource contention severe enough to stall a test for 20+ real seconds, that
either needs a fundamentally different test design (not dependent on a race
against wall-clock time) or is an infrastructure capacity issue that a test
timeout cannot paper over indefinitely.

## Actual Behavior

The test consumes its entire timeout budget (confirmed at both 5s and 20s)
without the idle reaper's release being observed, on one of two concurrent
CI jobs, every time it has been observed to fail — never a near-miss
(e.g., failing at 4.8s of a 5s budget or 19s of a 20s budget with only
fractional shortfall), which points away from "borderline timing" and
toward either a real stall/hang under CI conditions or brutally severe,
essentially unbounded contention.

## Environment

- OS / platform: Linux (self-hosted GitHub Actions runner, container image
  `localhost:5000/rust-dev:1.0.1`).
- Language / runtime version: Rust workspace at `the-intern/service`,
  `RUSTUP_TOOLCHAIN: 1.96.0-x86_64-unknown-linux-gnu`.
- Relevant dependencies: real subprocess spawn/IPC via `pi-agent-supervisor`;
  the supervisor's idle-reaper background task; as of B-025,
  `#[tokio::test(flavor = "multi_thread", worker_threads = 2)]`.
- Branch / commit: `dev-agent` at `47a539e` (after B-025 merged) — failure
  observed on the immediately following CI run.

## Related

- Bug: `B-025` (prior diagnosis/fix attempt for the same test failing the
  same way; its fix is merged but did not resolve the issue — this bug
  supersedes it with stronger evidence).
- PR: `#38` (`Promote dev-agent → main: scheduler JSON-state persistence,
  reliability fixes, per-entry cwd resolution`) — still blocks fully green
  CI on this PR.

## Suspected Area

`the-intern/service/crates/bob/src/serve.rs`, test
`periodic_event_is_dispatched_to_pi_agent_with_payload_as_prompt`, and/or
`the-intern/service/crates/pi-agent-supervisor/` (idle reaper, pool,
process termination) — B-025's diagnosis found this production code
deterministic and bounded by reading it, but did not achieve live
reproduction to actually exercise it under failure conditions; that
conclusion should be re-examined given the fix's failure to resolve the
issue. Also consider whether `flavor = "multi_thread"` itself interacts
badly with any `!Send`/thread-affinity assumption elsewhere in the
supervisor or its test doubles.

## Fix Verification

```bash
cd the-intern/service && cargo test -p bob --lib serve::tests::periodic::periodic_event_is_dispatched_to_pi_agent_with_payload_as_prompt -- --exact
cd the-intern/service && cargo test --workspace
# Real verification requires observing at least two consecutive green CI
# Tests runs on both matrix jobs after the fix lands.
```

## Diagnosis Log

### Diagnosis 1 — 2026-07-17

Reproduction status: unconfirmed locally (consistent with both prior investigation attempts on
B-025). This session went further than either prior attempt: in addition to re-running the test in
isolation (5/5 passed, ~0.21-0.22s each), I built the test binary directly and used `taskset` to
force genuine CPU oversubscription that B-025's "run more copies of the suite" simulation could not
achieve on this 20-core sandbox (which always left `worker_threads = 2` with real spare cores
available regardless of background load):
  - 6 pure-spin busy-loop processes pinned to the same 2 CPUs the test process was also pinned to:
    5/5 runs still passed in 0.14-0.17s.
  - The entire test process (both of its multi_thread worker OS threads) pinned to a single physical
    CPU, alongside 3 competing busy loops on that same CPU: 3/3 runs still passed in 0.13-0.14s.
  Ordinary preemptive CPU contention, even pushed to deliberate oversubscription of the exact thread
  count this test's runtime now depends on, does not reproduce the failure on this hardware/kernel.
  This is informative negative evidence, not proof of absence — it argues against "generic scheduling
  delay" as sufficient and points toward something CI-container-specific (e.g. genuine cgroup CPU-quota
  throttling, which pauses a cgroup for a bounded slice of an accounting period rather than merely
  delaying it under fair round-robin contention — a qualitatively different mechanism `taskset`+busy-loop
  contention cannot replicate).

Evidence captured:
- Read the full canonical B-026 bug file and B-025's resolved bug file, including B-025's Diagnosis
  Log, Work Log, and Review Verdict.
- Read the full failing test (`crates/bob/src/serve.rs:1909-2027`) on the bug branch. Confirmed
  `git diff dev-agent --stat -- the-intern/service` is empty — no code changes made or needed.
- Read the full idle-reaper call chain again, independently: `crates/pi-agent-supervisor/src/lib.rs`
  (`Actor::run`'s single `tokio::select!` loop — commands, `interactive_exit_tick`, `reap_tick`, all
  serialized within one task, so no cross-task lock contention is possible inside the actor itself),
  `crates/pi-agent-supervisor/src/pool.rs::reap_idle_and_surplus`/`send_prompt_and_drain`/
  `kill_session` (no `std::sync::Mutex` or other blocking primitives anywhere in this crate — confirmed
  via grep, zero non-doc-comment hits), and `crates/pi-agent-supervisor/src/process.rs::terminate`
  (SIGTERM → `time::timeout(child_termination_deadline, child.wait())` → `try_wait` → SIGKILL →
  `wait()` again; operates directly parent→child, so the classic "PID-1-in-a-container doesn't reap
  orphaned grandchildren" gotcha does not apply — the test process is the direct, live parent
  throughout).
- Precedent audit (hypothesis 1 — container/subprocess-reaping bug): `process.rs`'s own `#[cfg(test)]`
  module exercises this exact `terminate()` code path (including force-kill-after-deadline scenarios)
  in 15 tests, ALL `#[tokio::test(flavor = "current_thread")]`, including
  `terminate_force_kills_when_child_exceeds_deadline` and
  `actor_shutdown_terminates_active_and_warm_worker_processes` (2 processes reaped in one shutdown).
  None of these — nor the tighter-margin `idle_reaper_removes_session_after_idle_timeout_without_prompt_activity`
  (a fixed 180ms sleep with zero retry/polling margin) — has ever been reported flaky in CI, including
  in the exact CI runs where the target test failed. If subprocess SIGTERM/wait/SIGKILL reaping were
  unreliable in this container, the much tighter-margin sibling test would be the more likely first
  casualty, not this one. This weakens hypothesis 1 considerably.
- Precedent audit (hypothesis 2 — multi_thread regression): exactly 12 `flavor = "multi_thread"`
  occurrences exist in the whole codebase: 8 in `crates/admin-rpc/src/lib.rs`, 3 in
  `crates/bob/src/cli/commands/chat.rs`, and this 1 in `serve.rs`. Read all 11 non-target occurrences:
  admin-rpc's 8 tests use `UnixStream::pair()`/`UnixListener` with a single hand-spawned "server" task
  — pure in-process IPC, no real subprocess spawn/wait for most; the interactive-session subset does
  spawn a real `sh` child but wires only the `pi-agent-supervisor` actor plus a directly-constructed
  `Dispatcher`, never the full `start_subsystems()` actor stack; chat.rs's 3 tests are socket-only, no
  subprocess. An `awk` scan of every `#[tokio::test(...)]` in `serve.rs` (44 matches) confirms ALL 44
  other tests use `current_thread`; the target test is the ONLY `multi_thread` test in the entire file,
  and the ONLY place in the whole codebase combining `multi_thread` with the full 9-actor
  `start_subsystems()` stack (monitoring, persistence, policy-control, pi-agent-supervisor actor,
  requests-handler, extension-ipc, admin-rpc, scheduler-adapter, periodic dispatcher) — a task topology
  with zero precedent anywhere else `multi_thread` is used, competing for just `worker_threads = 2`.
- Precedent audit (hypothesis 3 — CI-runner resource starvation): read `.github/workflows/build.yml`
  in full. The `tests` job runs `podman run --rm ... sh -lc 'cargo test --workspace'` with no
  `--cpus`/`--memory`/cgroup flags visible in the workflow, and no repository documentation of
  self-hosted-runner resource caps. Cannot cite a discoverable, principled resource limit from
  anything in this repository — if cgroup throttling is the true mechanism, confirming it requires
  access to the runner host/container-runtime configuration outside this repo's visibility.
- Read `Cargo.lock`: tokio `1.52.3` (current, modern release; no widely-known open multi_thread/process
  reaping correctness bug at this version that would explain a deterministic-looking full-timeout hang
  independent of this codebase's own task topology).

Isolated fault: not a defect in `pi-agent-supervisor`'s reaper/pool/process code — re-confirmed
deterministic, bounded, and free of any blocking/locking hazard, and its exact `terminate()` path is
exercised successfully by many sibling tests in the same CI runs. The best-supported isolated variable
is `serve.rs:1924`'s `#[tokio::test(flavor = "multi_thread", worker_threads = 2)]` attribute (added by
B-025), which is structurally unprecedented: it is the only place in the codebase combining
`multi_thread` with the full 9-actor `start_subsystems()` stack, and the only `multi_thread` test in
`serve.rs` (vs. 44 `current_thread` siblings with an unblemished CI record).

Root cause / fault hypothesis (not fully proven — live reproduction not achieved despite this
session's more aggressive attempts): B-025's runtime-flavor change is the most likely proximate cause
of this failure's changed signature (full-timeout consumption instead of a near-miss). Under
`current_thread`, all 9 of bob's background actors cooperatively round-robin on one OS thread with
tokio's deterministic, fair scheduler — correctness only depends on the OS promptly scheduling that
one thread at all, which this session's local CPU-starvation experiments (and 44 other current_thread
`start_subsystems` tests' clean CI history) show is robust even under heavy contention. Under
`multi_thread, worker_threads = 2`, correctness now additionally depends on the OS scheduler making
genuine, concurrent progress on (up to) 2 specific OS threads together. Plain preemptive contention
(even oversubscribed, per this session's `taskset` experiments) does not break that dependency on this
hardware — but a self-hosted-runner-specific mechanism this sandbox cannot replicate (most plausibly
cgroup CPU-quota throttling, which pauses a cgroup for a bounded slice of an accounting period rather
than merely delaying it under fair scheduling) plausibly could, and would produce exactly the observed
signature: a full, hard stop with zero partial progress, hitting the same ceiling every time. This
reconciles hypotheses 2 and 3 rather than treating them as exclusive: `multi_thread` is the enabling
regression (a new dependency on genuinely-concurrent multi-thread scheduling that 44 sibling tests and
15 real-subprocess pi-agent-supervisor tests never had), and a CI-runner-specific throttling effect
(not discoverable from this repository) is the plausible trigger. Hypothesis 1 (a genuine
subprocess-reaping/termination defect) is not well supported: the exact same `terminate()` code path,
including force-kill scenarios and multi-process shutdown, is exercised successfully by numerous
`current_thread` tests in the same failing CI runs.

Planned fix (test-only, no production code changes):
1. Revert `serve.rs:1924`'s `#[tokio::test(flavor = "multi_thread", worker_threads = 2)]` back to
   `#[tokio::test(flavor = "current_thread")]` for
   `periodic_event_is_dispatched_to_pi_agent_with_payload_as_prompt` — removing the one structurally
   unprecedented variable B-025 introduced, restoring this test to the same runtime model as its 44
   siblings in `serve.rs` and the real-subprocess tests in `pi-agent-supervisor` that have never shown
   CI flakiness.
2. Keep both `Duration::from_secs(20)` outer polling timeouts from B-025 as-is — they are a safety net
   against a hung suite, not the fix mechanism, and narrowing them back to 5s is not warranted by any
   evidence gathered.
3. Update the B-025-authored comments justifying `multi_thread` to instead record B-026's finding:
   `multi_thread` had no working precedent for this task topology anywhere in the codebase and is the
   prime suspect for the changed failure signature, so it is reverted; the widened timeout is retained
   only as a safety net.
4. Do not add a new event-driven idle-release notification API to `pi-agent-supervisor` as part of this
   fix — production code is out of this bug's scope, and the existing polling design is not the
   isolated fault. Note for a possible future task: an event-driven idle-release notification mirroring
   the existing `watch_interactive_session_exit` mechanism would be a strictly better long-term design
   for this style of test and should be proposed as a separate enhancement, not folded into this fix.

Planned verification:
```bash
cd the-intern/service
cargo test -p bob --lib serve::tests::periodic::periodic_event_is_dispatched_to_pi_agent_with_payload_as_prompt -- --exact
cargo test --workspace
cargo fmt --all -- --check
```
Given local irreproducibility, the only real confirmation is observing at least two consecutive green
CI `Tests` runs on both matrix jobs after the fix lands. Falsification condition: if this exact test
fails again in CI under `current_thread` after this fix, that disproves hypothesis 2 as sufficient on
its own and the next investigation (a fresh bug, not another timeout increase) must pursue
infrastructure-level evidence outside this repository's visibility.

## Work Log

### Session 1 — 2026-07-17

Implemented B-026's fix contract exactly as specified: reverted
`periodic_event_is_dispatched_to_pi_agent_with_payload_as_prompt` in
`the-intern/service/crates/bob/src/serve.rs` from
`#[tokio::test(flavor = "multi_thread", worker_threads = 2)]` back to
`#[tokio::test(flavor = "current_thread")]`. Left both `Duration::from_secs(20)`
outer polling timeouts from B-025 untouched — they're a safety net, not the
fix mechanism. Rewrote the B-025-authored comment block above the attribute
to record B-026's finding: this was the only `multi_thread` test in
`serve.rs` (versus 44 `current_thread` siblings with a clean CI record) and
the only place in the codebase combining `multi_thread` with the full
9-actor `start_subsystems()` stack, making it the prime suspect for the
changed failure signature rather than a genuine defect in the reaper/pool/
process code. Did not touch `pi-agent-supervisor` production code and did
not add any event-driven notification API — both explicitly out of scope.
`git diff dev-agent --stat -- the-intern/` confirms exactly one file changed
(`serve.rs`, 16 insertions/9 deletions).

Verification: ran the target test in isolation 8 times total, all passed in
~0.21-0.22s, confirming reverting to `current_thread` causes no local
regression. `cargo test --workspace` reports 0 failures across every crate.
`cargo fmt --all -- --check` clean. Committed as `dbc4cea` on
`bug/B-026-idle-reaper-test-still-hangs-on-ci`.

Being explicit about what this session can and cannot claim, matching the
diagnosis's own honesty: the original CI failure was never reproduced
locally, not in B-025's investigation, not in B-026's more aggressive
`taskset`-based CPU-oversubscription attempts, and not in this
implementation session. Everything run here is consistency verification —
it demonstrates the fix introduces no regression, but it cannot demonstrate
the fix resolves the CI-specific hang, since that failure mode has no local
reproduction to test against. Real confirmation requires observing at least
two consecutive green CI `Tests` runs on both matrix jobs after this change
lands. If this exact test fails again in CI under `current_thread`, that
would disprove the `multi_thread`-regression hypothesis and the next
investigation should pursue CI-infrastructure-level evidence (e.g. cgroup
CPU-quota configuration) outside this repository's visibility, rather than
another timeout adjustment.

**Obstacles Encountered:** None blocking. Pre-existing, unrelated
working-tree state (`pr-35-review.md`/`pr-38-review.md`) left untouched.

## Review

### Review Verdict — 2026-07-17

PASS

**Evidence chain.** Diagnosis Log contains a complete fix contract (isolated
fault: `serve.rs:1924`'s `flavor = "multi_thread", worker_threads = 2)`
attribute; planned fix: revert to `current_thread`, keep the 20s timeouts,
update the justifying comment, no production changes; planned verification:
target test, workspace test, fmt, plus CI observation). The Work Log's
implementation matches the contract exactly — verified independently below,
not inferred from the diff.

**Stage 1 — Bug criteria.**
- `git diff dev-agent...bug/B-026-idle-reaper-test-still-hangs-on-ci --stat`
  shows exactly one file, `the-intern/service/crates/bob/src/serve.rs`
  (16 insertions, 9 deletions), one diff hunk. No production code
  (`pi-agent-supervisor`, `bob` non-test modules) was touched, matching the
  contract's explicit exclusion.
- The only functional change is
  `#[tokio::test(flavor = "multi_thread", worker_threads = 2)]` →
  `#[tokio::test(flavor = "current_thread")]` on
  `periodic_event_is_dispatched_to_pi_agent_with_payload_as_prompt`. Both
  `Duration::from_secs(20)` outer timeouts (lines 1991, 2016 post-fix) are
  byte-for-byte unchanged from B-025 — confirmed via `grep -n
  "from_secs(20)"`. The remaining diff lines are the comment block, rewritten
  to record B-026's finding instead of B-025's original justification.
- No lifecycle file (`project/bugs/...`) was touched on the bug branch —
  confirmed via `git diff dev-agent...bug/... --name-only -- project/`
  (empty) and `git log --stat` on `dbc4cea`.
- No unspecified behavior was added; nothing outside the fix contract's four
  numbered steps appears in the diff.

**Stage 2 — Code quality / bug-fix addendum.**
- Fix is minimal: single attribute + accompanying comment, nothing else.
- No unrelated refactor or feature code is bundled in.
- Fix contract matches implementation exactly (checked point-by-point above).
- Regression test: per the addendum, "a regression test exists that fails
  before the fix and passes after it" is structurally unsatisfiable here —
  the same as B-025 — because the failure is CI-container-specific and has
  never reproduced locally across two independent, increasingly aggressive
  investigation attempts (B-025's simulated background load, B-026's
  `taskset`-based genuine CPU oversubscription up to single-core pinning
  with competing busy loops). This is treated as a known, precedent-approved
  exception rather than a gap, consistent with B-025's review.

**Independent re-verification of the precedent audit.** The task asked me to
scrutinize the precedent-audit reasoning rather than accept it at face
value, so I independently re-derived its factual claims from the codebase
rather than trusting the Diagnosis Log's numbers:
- Post-fix, `grep -c '#\[tokio::test'` on `serve.rs` = 45, and `grep -o
  'flavor = "[a-z_]*"'` shows all 45 as `current_thread`, 0 as
  `multi_thread` — confirms the "44 current_thread siblings, this test was
  the only multi_thread one" claim.
- Whole-workspace `grep -rn 'flavor = "multi_thread"'` finds exactly 11
  remaining occurrences (8 in `crates/admin-rpc/src/lib.rs`, 3 in
  `crates/bob/src/cli/commands/chat.rs`) — confirms the "12 total, one of
  which is the target" claim.
- `chat.rs`'s three `multi_thread` tests are socket-only
  (`UnixListener`/`UnixStream` with a hand-spawned server task, no
  subprocess, no `start_subsystems()`) — confirmed by reading all three test
  bodies.
- `crates/admin-rpc/Cargo.toml` does not depend on the `bob` crate at all
  (only `bob-core`), so `admin-rpc`'s tests are *structurally* incapable of
  exercising the full 9-actor `start_subsystems()` stack — this is stronger
  than the Diagnosis Log's own framing ("no working precedent"); it is not
  merely unprecedented, it is impossible in that crate.
- The "15 tests" figure attributed to `process.rs`'s termination-path
  precedent is a loose approximation: `process.rs` alone has 17
  `#[tokio::test]` fns (all `current_thread`), of which a narrower subset
  specifically exercises `terminate()` directly; the crate-wide picture
  (`process.rs` 17 + `lib.rs` 21 + `pool.rs` 12 = 50 tests, all
  `current_thread`, 0 `multi_thread`) supports the qualitative point even if
  "15" isn't an exact reproducible count. This is a minor imprecision in the
  Diagnosis Log, not a materially misleading one — noted here for the
  record, not blocking.
- Conclusion: the precedent audit's arithmetic and structural claims hold up
  under independent re-derivation. It is still circumstantial in the strict
  sense (no live reproduction, no mechanistic proof that `multi_thread`
  itself is the trigger rather than a correlated but incidental factor) —
  the Diagnosis Log is explicit and honest about this, stating the
  conclusion is "not fully proven" and giving a falsification condition.
  But "circumstantial" is not the same as "weak": the asymmetry between a
  100% failure rate (2/2 real CI opportunities) for the one-of-a-kind
  `multi_thread` + full-actor-stack combination versus a 0% known-flakiness
  rate across 45+50 structurally comparable `current_thread` tests in the
  same CI runs is a legitimate, quantifiable basis for a decision, even
  without a mechanistic explanation of *why* `multi_thread` would fail this
  way under CI-specific conditions (the cgroup-throttling hypothesis is
  offered as a plausible mechanism, correctly labeled as unconfirmable from
  inside this repository).

**Is revert-to-current_thread the right call despite no proof?** Yes, per
the same standard applied to B-025: the fix is safe (reduces the test to a
runtime configuration with a clean, extensive precedent, not a novel one),
minimal (one attribute plus a comment), reversible (a single-line change),
and is the best-justified option actually available given that live
reproduction has now been attempted twice with escalating rigor and failed
both times. It does not paper over the problem by further widening a
timeout (which would have been the weaker move — retrying the same kind of
fix that already failed) or reach for an out-of-scope production change.
Retaining the 20s timeouts as a safety net independent of the fix mechanism
is correct: it means the fix doesn't rely on the timeout margin to work, and
doesn't regress the margin if the `multi_thread` hypothesis turns out to be
wrong. The Diagnosis Log's falsification condition (a repeat failure under
`current_thread` disproves hypothesis 2 and mandates a fresh, infrastructure-
focused investigation rather than another timeout bump) is exactly the right
next-step commitment for an unfalsifiable-locally fix, and the Work Log's
honesty about what could and could not be demonstrated locally is
appropriate, not a shortfall — repeating that honesty rather than
overclaiming local proof is the correct behavior here.

**Local re-verification performed independently in this review** (bug
branch `bug/B-026-idle-reaper-test-still-hangs-on-ci`, commit `dbc4cea`):
- `cd the-intern/service && cargo test -p bob --lib
  serve::tests::periodic::periodic_event_is_dispatched_to_pi_agent_with_payload_as_prompt
  -- --exact` — run 5 times, 5/5 passed, ~0.21-0.22s each.
- `cd the-intern/service && cargo test --workspace` — 0 failures across
  every crate (bob 158 passed, pi-agent-supervisor 63 passed, admin-rpc 116
  passed, and all others green; doc-tests all 0/0).
- `cargo fmt --all -- --check` — clean, exit 0.

**Non-blocking suggestion (lower-risk/more-conclusive alternative for next
time).** If this revert does not resolve the CI failure, the next
investigation will again be starting from a bare `Elapsed(())` panic with no
further detail. A cheap, in-scope improvement for a future session: replace
the two `.expect("...")` calls at the timeout sites with messages (or a
`match`/`unwrap_or_else`) that dump observable state at the moment of
timeout — e.g., `runtime._pi_agent_supervisor.list_sessions()`'s length/ids,
or elapsed-time checkpoints logged via `tracing`/`eprintln!` at each poll
iteration. This is pure test-diagnostic instrumentation (no production code,
no behavior change), would not have been required for this fix, but would
substantially increase the evidentiary value of a third CI failure if the
`multi_thread` hypothesis turns out to be wrong — worth proposing as a
follow-up rather than blocking this fix on it.

**Minor observation (non-blocking).** The Diagnosis Log's "15 tests" count
for `process.rs`'s termination-path precedent doesn't exactly match my
independent count (17 total tests in that file); the qualitative claim
(extensive `current_thread` precedent, zero known flakiness) still holds
under the broader, independently-verified count. Not a correctness issue,
just a note for precision in future diagnosis logs.

Next owner: active Bug-Fix Loop.
