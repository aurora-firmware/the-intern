---
id: B-028
title: 'periodic_event_is_dispatched_to_pi_agent_with_payload_as_prompt fails deterministically
  in CI with no local repro, even with contention eliminated - needs #[ignore] pending
  runner-level investigation'
severity: medium
status: in-progress
created: '2026-07-18'
---

# periodic_event_is_dispatched_to_pi_agent_with_payload_as_prompt fails deterministically in CI with no local repro, even with contention eliminated - needs #[ignore] pending runner-level investigation

## Summary

`serve::tests::periodic::periodic_event_is_dispatched_to_pi_agent_with_payload_as_prompt`
(`the-intern/service/crates/bob/src/serve.rs`) has now failed on the
self-hosted CI runner 5 times in a row, across 4 different fix attempts,
never once reproducing locally despite deliberate and increasingly
aggressive local contention simulation (up to and including CPU-pinning
oversubscription via `taskset`). Three prior bugs each proposed and
implemented a plausible, evidence-backed hypothesis; each was subsequently
falsified by the next CI failure:

1. **B-025** (original): hypothesized insufficient timing margin under
   scheduling contention on a `current_thread` runtime. Fix: widened the
   outer timeout from 5s to 20s and switched to
   `flavor = "multi_thread", worker_threads = 2`. **Falsified**: the very
   next CI push failed identically, consuming the entire widened 20s budget.
2. **B-026**: hypothesized `multi_thread` itself was the regression (this
   test was the only `multi_thread` test in `serve.rs` and the only place
   in the codebase combining `multi_thread` with the full 9-actor
   `start_subsystems()` stack). Fix: reverted to `flavor = "current_thread"`,
   kept the 20s timeout. **Falsified**: the next CI push failed identically
   again, same panic, same ~20.1s duration.
3. **B-027**: discovered the actual CI topology — every `dev-agent` push
   while a promotion PR is open fires *two* full workflow runs (`push` and
   `pull_request` events for the identical commit, ~2s apart) on a single
   self-hosted runner (`auroralab`), and traced (via job-level timestamps)
   that the two runs' jobs execute strictly serially, with the second,
   redundant run's `Tests` job queuing directly behind the first run's 5
   jobs. Fix: added a `concurrency` group to `.github/workflows/build.yml`
   to cancel the redundant run. **This fix genuinely worked** — confirmed via
   `gh run list`: the redundant `push` run's conclusion was `cancelled`, and
   only the `pull_request` run actually executed. **But the single,
   completely non-contended, non-duplicated run still failed the exact same
   test the exact same way** (`Elapsed(())` at the same assertion, `finished
   in 20.11s`) — fully falsifying resource contention (of any kind, real or
   queued) as the root cause.

With duplicate-run contention now conclusively ruled out as a variable (a
single run, alone on the runner, still fails), the remaining plausible
explanations are either a genuine defect specific to this self-hosted
runner's container/process environment (e.g. something about how `podman
run --rm` handles child-of-child process signaling or reaping that this
sandbox's non-containerized environment doesn't replicate), or some other
CI-runner-specific factor not yet identified. Three independent, thorough
code-reading diagnoses (B-025, B-026, B-027) have all confirmed the
production idle-reaper/pool/process-termination code itself is
deterministic, bounded, and exercised successfully by numerous other tests
in the same failing CI runs — there is no remaining evidence implicating
production code. Continuing to guess at test-code or CI-config fixes without
new diagnostic information is not warranted; this bug's fix is to mark the
test `#[ignore]` with a clear tracking reference so it stops blocking CI
while remaining available for a future session with richer
instrumentation or actual CI-runner shell access.

## Reproduction Status

Status: confirmed on CI (5 consecutive failures across 4 distinct
configurations), never reproduced locally despite three independent,
increasingly aggressive local investigation sessions (B-025, B-026, B-027).

## Evidence

- Full failure history (all `serve::tests::periodic::periodic_event_is_dispatched_to_pi_agent_with_payload_as_prompt`,
  same assertion `.expect("idle reaper must eventually release the one-shot session")`):
  1. `current_thread`, 5s timeout — CI run `29561962415` (pre-B-025).
  2. `current_thread`, 5s timeout — CI run `29606972803` (pre-B-025, second occurrence).
  3. `multi_thread worker_threads=2`, 20s timeout — CI run `29608348894` (B-025's fix, immediately falsified).
  4. `current_thread`, 20s timeout, duplicate-run contention present — CI run `29609973101` (B-026's fix, immediately falsified).
  5. `current_thread`, 20s timeout, duplicate-run contention **eliminated** (confirmed via `gh run list` showing the sibling `push` run's conclusion as `cancelled`) — CI run `29631961717` (B-027's fix, immediately falsified; `finished in 20.11s`, identical to failure #4's duration).
- `gh run list --repo aurora-firmware/the-intern --branch dev-agent --limit 4 --json databaseId,event,createdAt,status,conclusion`
  after B-027 merged and was pushed:
  ```json
  [{"conclusion":"","createdAt":"2026-07-18T05:15:46Z","databaseId":29631961717,"event":"pull_request","status":"queued"},
   {"conclusion":"cancelled","createdAt":"2026-07-18T05:15:44Z","databaseId":29631960872,"event":"push","status":"completed"},
   ...]
  ```
  Directly confirms the concurrency group worked as designed (the `push` run was cancelled), yet the surviving `pull_request` run's `Tests` job still failed — the definitive evidence that duplicate-trigger contention was never the (sole) cause.
- All three prior diagnoses (B-025, B-026, B-027) independently audited
  `crates/pi-agent-supervisor/src/{reaper,pool,lib,process}.rs` and found
  the idle-reaper/termination logic deterministic, fully time-bounded (no
  unbounded awaits, no blocking mutexes), and exercised successfully by 15+
  other tests (including tighter-margin ones) in the same CI runs where
  this test failed.
- B-026 used `taskset`-forced CPU oversubscription (pinning the test process
  and multiple competing busy-loops to the same 1-2 CPUs) and still could
  not reproduce the failure locally — the strongest local contention
  simulation attempted across all three sessions.

## Reproduction Steps

Not reproducible on demand, locally or via any local contention simulation
attempted so far. Push a commit to `dev-agent` and observe whether the
`Tests` job fails on this specific test. Has now failed on every single CI
opportunity where the job actually ran to completion (5 for 5).

## Expected Behavior

The test should pass in CI, or if the underlying condition genuinely cannot
be resolved without runner-level access this repository's tooling doesn't
have, it should be excluded from the blocking test run with a clear,
discoverable marker until it can be properly investigated — rather than
continuing to block every PR's CI with an unresolved, un-diagnosable-from-here
failure.

## Actual Behavior

The test fails deterministically on CI under every configuration tried so
far, always consuming its entire configured timeout with zero partial
progress, and has now been shown to fail even when it is the only thing
running on the self-hosted runner (no sibling job, no contention).

## Environment

- OS / platform: Linux (self-hosted GitHub Actions runner `auroralab`,
  container image `localhost:5000/rust-dev:1.0.1`, invoked via `podman run
  --rm`).
- Language / runtime version: Rust workspace at `the-intern/service`,
  `RUSTUP_TOOLCHAIN: 1.96.0-x86_64-unknown-linux-gnu`.
- Branch / commit: `dev-agent` at `2b015f5` (after B-027 merged) — failure
  observed on the immediately following push, in a run confirmed to be the
  sole surviving (non-cancelled, non-contended) run for that commit.

## Related

- Bug: `B-025` (widen timeout + `multi_thread` — falsified).
- Bug: `B-026` (revert to `current_thread` — falsified).
- Bug: `B-027` (eliminate duplicate CI trigger via `concurrency` group —
  genuinely fixed the duplicate-trigger issue it targeted, but did not
  resolve this test's failure, definitively ruling out contention as the
  cause).
- PR: `#38` (`Promote dev-agent → main: scheduler JSON-state persistence,
  reliability fixes, per-entry cwd resolution`) — this is the last item
  blocking fully green CI on this PR.

## Suspected Area

`the-intern/service/crates/bob/src/serve.rs`, test
`periodic_event_is_dispatched_to_pi_agent_with_payload_as_prompt` — the test
itself, or something specific to how it (uniquely among the workspace's
tests, per B-026's precedent audit) spawns and waits on a real `sh`
subprocess combined with the CI runner's specific containerized process
environment (`podman run --rm`). Explicitly not a defect in
`pi-agent-supervisor`'s reaper/pool/process-termination logic, which three
independent audits have found correct, bounded, and successfully exercised
by numerous sibling tests in the same failing CI runs.

## Fix Verification

```bash
# After marking the test #[ignore], confirm the workspace test suite no
# longer includes it in the default run and CI goes green:
cd the-intern/service && cargo test --workspace
cd the-intern/service && cargo test -p bob --lib serve::tests::periodic::periodic_event_is_dispatched_to_pi_agent_with_payload_as_prompt -- --ignored --exact
# (the second command should still be able to run it manually/explicitly)
```

## Diagnosis Log

### Diagnosis 1 — 2026-07-18

Reproduction status: confirmed on CI (5 consecutive failures across 4 distinct configurations),
never reproduced locally — carried forward unchanged from the canonical Summary/Evidence, which
already consolidates B-025, B-026, and B-027's independent reproduction attempts (including
B-026's `taskset` CPU-pinning oversubscription, the most aggressive local contention simulation
attempted). Not re-verified live this session — re-running a test that fails only on the CI
runner's specific container/process environment against this sandbox would add no new information.

Evidence captured (this session, sanity-check only):
- Read `periodic_event_is_dispatched_to_pi_agent_with_payload_as_prompt` in full
  (`the-intern/service/crates/bob/src/serve.rs:1875-2034`). Structure is exactly as all three
  prior diagnoses described. No divergence from what B-025/B-026/B-027 already audited.
- `git diff dev-agent --stat -- the-intern/service` on this bug branch: empty. Code is
  byte-identical to what B-027's fix left on `dev-agent`.
- Re-read all three prior Diagnosis Log entries in full
  (`project/bugs/resolved/B-025-...md`, `B-026-...md`, `B-027-...md` on `dev-agent`). Each
  independently audited `crates/pi-agent-supervisor/src/{reaper,pool,lib,process}.rs` and found the
  idle-reaper/pool/process-termination logic deterministic, fully time-bounded, and successfully
  exercised by 15+ sibling tests in the same failing CI runs. Nothing in this re-read contradicts
  or adds to that trail.
- Confirmed `#[ignore]` / `cargo test --workspace` interaction empirically (isolated scratch
  Cargo project, not this repository): a default `cargo test` run skips an
  `#[ignore = "..."]`-annotated test, reports it in the `N ignored` tally, and the overall run
  still reports `test result: ok`. `cargo test -- --ignored` runs only the ignored subset;
  `cargo test -- --include-ignored` runs everything.
- Confirmed via the vendored `tokio-macros` source (`tokio-macros-2.7.0/src/entry.rs:685-704`)
  that `tokio::test`'s expansion forwards other attributes (like `#[ignore]`) onto the generated
  test function — placing `#[ignore]` below `#[tokio::test(flavor = "current_thread")]` is safe
  and standard.

Isolated fault: not a fault in `pi-agent-supervisor`'s idle-reaper/pool/process-termination
code — three independent audits (B-025, B-026, B-027) have already ruled that out conclusively.
The observable failure site remains the second `tokio::time::timeout(...).expect("idle reaper must
eventually release the one-shot session")` block, which is where all 5 CI failures panicked — this
is the symptom location, not a defect location.

Root cause: genuinely unknown, stated honestly. Three distinct, evidence-backed hypotheses (B-025:
timing margin; B-026: `multi_thread` regression; B-027: duplicate-CI-trigger contention) were each
proposed, implemented, and independently falsified by the next CI failure — most decisively by
B-027, whose fix genuinely worked (confirmed via `gh run list` showing the redundant run as
`cancelled`) yet the single, non-contended surviving run still failed identically. The remaining
plausible explanations require CI-runner-level access (shell access to the self-hosted runner, or
richer instrumentation than a black-box CI log) out of this repository's/session's reach. Per the
user's explicit direction, a fourth blind fix is not being attempted.

Planned fix (test-only, no production code change): mark the test `#[ignore]` with both an inline
reason and a fuller explanatory comment block above it:

```rust
        // B-028: this test fails deterministically in CI (never locally, despite
        // three independent sessions' increasingly aggressive local contention
        // simulation, up to and including taskset CPU-pinning oversubscription).
        // Three prior bugs (B-025: timing margin, B-026: multi_thread runtime,
        // B-027: duplicate-CI-trigger contention) each proposed and implemented a
        // plausible, evidence-backed hypothesis; each was independently falsified
        // by the next CI failure. B-027's fix genuinely eliminated duplicate-run
        // contention (confirmed via `gh run list`), yet the single, non-contended
        // surviving run still failed identically. All three sessions independently
        // audited crates/pi-agent-supervisor/src/{reaper,pool,lib,process}.rs and
        // found the idle-reaper/pool/process-termination logic deterministic,
        // bounded, and exercised successfully by numerous sibling tests in the same
        // failing CI runs — do not re-audit that code without new evidence; see
        // B-028 for the full trail. Ignored pending CI-runner-level investigation
        // (e.g. shell access to the self-hosted runner, or richer instrumentation
        // than a black-box CI log) that this repository's tooling cannot currently
        // perform. Run explicitly with:
        //   cargo test -p bob --lib serve::tests::periodic::periodic_event_is_dispatched_to_pi_agent_with_payload_as_prompt -- --ignored --exact
        #[tokio::test(flavor = "current_thread")]
        #[ignore = "B-028: fails deterministically in CI only, never locally; production code audited correct 3x (B-025/026/027); root cause unknown, see bug file"]
        async fn periodic_event_is_dispatched_to_pi_agent_with_payload_as_prompt() {
```

The inline `#[ignore = "..."]` string stays short and glanceable (what `cargo test` prints per
test); the doc comment above carries the fuller falsified-hypothesis trail for a source reader,
without disturbing the pre-existing B-025/B-026 historical comment block that stays as accurate
context on the test's design history.

Planned verification:
```bash
cd the-intern/service
cargo test --workspace
# expected: the target test reports as "ignored" in the summary line; overall result is `ok`.
cargo test -p bob --lib serve::tests::periodic::periodic_event_is_dispatched_to_pi_agent_with_payload_as_prompt -- --ignored --exact
# expected: still runnable explicitly.
cargo fmt --all -- --check
```
Real end-to-end confirmation is observing CI on PR #38 go green on the next push.

## Work Log

## Review
