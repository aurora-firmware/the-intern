---
id: B-022
title: schedule.add write-error test fails in CI because root bypasses the 0o500
  permission check
severity: high
status: open
created: '2026-07-17'
---

# schedule.add write-error test fails in CI because root bypasses the 0o500 permission check

## Summary

`dispatch_schedule_add_store_write_error_returns_invalid_request` (added in
commit `82302c2 fix(service): address pr review findings`, currently on
`dev-agent` / PR #38) forces a `schedule.add` store-write failure by chmodding
the temp parent directory to `0o500` (read-only for its owner) and asserting
the dispatcher returns `CODE_INVALID_REQUEST`. On the self-hosted CI runner
the test process runs as `root`, and the Linux kernel exempts root from the
discretionary permission check entirely (`DAC_OVERRIDE`), so the write
succeeds and the dispatcher returns `Ok` instead of the expected error. This
currently fails the `Tests` CI job on every run and blocks PR #38 from
merging — CI is red on an otherwise passing PR (`Build`, `Format`,
`Documentation`, `User Documentation` all pass).

## Reproduction Status

Status: confirmed — reproduced directly in the CI job logs (not a flake; it
fails deterministically on this runner because it always executes as root).

## Evidence

- Failing command: `cargo test -p admin-rpc --lib` (invoked via the
  workspace `cargo test --workspace` CI step).
- CI run logs (both matrix jobs):
  `https://github.com/aurora-firmware/the-intern/actions/runs/29053708124/job/86240236238`
  `https://github.com/aurora-firmware/the-intern/actions/runs/29053709716/job/86240241702`
- Failing assertion:
  ```
  thread 'dispatch::tests::dispatch_schedule_add_store_write_error_returns_invalid_request' panicked at crates/admin-rpc/src/dispatch.rs:2810:42:
  expected write error, got Ok: Response { jsonrpc: "2.0", result: Object {"ok": Bool(true)}, id: Number(315) }
  test result: FAILED. 113 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.63s
  ```
- Test source: `the-intern/service/crates/admin-rpc/src/dispatch.rs`, test
  `dispatch_schedule_add_store_write_error_returns_invalid_request` (currently
  around line 2746 on `dev-agent`). It calls
  `std::fs::set_permissions(dir.path(), permissions)` with `mode(0o500)` on
  the tempdir holding the schedule store, then asserts the subsequent
  `schedule.add` dispatch returns `DispatchOutcome::Err` with
  `CODE_INVALID_REQUEST` and a "failed to write schedule store" message.

## Reproduction Steps

1. On a machine/container where the current user is `root` (or run
   `sudo -E cargo test -p admin-rpc --lib dispatch_schedule_add_store_write_error_returns_invalid_request -- --exact --nocapture`
   as root locally).
2. Observe the test panics with `expected write error, got Ok: ...` because
   `std::fs::write`/the schedule-store writer succeeds despite the `0o500`
   directory mode.
3. As a non-root user, the same test passes, because the OS actually enforces
   the permission bit for a non-privileged process.

## Expected Behavior

`cargo test --workspace` (and the CI `Tests` job) should pass regardless of
whether the test process runs as root or as a non-privileged user — CI
correctness should not depend on the runner's effective UID.

## Actual Behavior

The test's failure-injection mechanism (chmod `0o500` on the parent
directory) is a no-op under root, so the write succeeds, the dispatcher
returns success, and the test's `Err`/`CODE_INVALID_REQUEST` assertion fails.
This currently fails CI on every run for PR #38.

## Environment

- OS / platform: Linux (self-hosted GitHub Actions runner, container image
  `localhost:5000/rust-dev:1.0.1`), test process runs as `root` in that
  container.
- Language / runtime version: Rust workspace at `the-intern/service`,
  `RUSTUP_TOOLCHAIN: 1.96.0-x86_64-unknown-linux-gnu`.
- Relevant dependencies: `std::fs::set_permissions` /
  `std::os::unix::fs::PermissionsExt` (Unix DAC permission model; root has
  `CAP_DAC_OVERRIDE` and bypasses owner/group/other permission bits).
- Branch / commit: `dev-agent` at `57f6506d60581da4c76a18d9a6aa84d6bdf59b4d`
  (PR #38 head). The test was introduced by commit `82302c2`.

## Related

- PR: `#38` (`Promote dev-agent → main: scheduler JSON-state persistence,
  reliability fixes, per-entry cwd resolution`) — this failure currently
  blocks CI on that PR.
- Local review report: `pr-38-review.md` (uncommitted, working tree only).

## Suspected Area

`the-intern/service/crates/admin-rpc/src/dispatch.rs`, test
`dispatch_schedule_add_store_write_error_returns_invalid_request` — the
failure-injection strategy (directory permission bits), not the
`schedule.add` production code path it exercises (that logic already has
independent coverage of the "invalid request" response shape via the
sibling `dispatch_schedule_reload_reads_from_disk_and_returns_ok`-style
tests and is not itself suspected of being broken).

## Fix Verification

```bash
# Run as a non-root and, if possible, as a root user (or in a container that
# matches the CI image) — both must pass:
cd the-intern/service && cargo test -p admin-rpc --lib dispatch_schedule_add_store_write_error_returns_invalid_request -- --exact
cd the-intern/service && cargo test --workspace
```

## Diagnosis Log

## Work Log

## Review
