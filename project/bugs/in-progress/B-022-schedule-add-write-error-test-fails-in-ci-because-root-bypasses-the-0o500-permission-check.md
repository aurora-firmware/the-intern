---
id: B-022
title: schedule.add write-error test fails in CI because root bypasses the 0o500
  permission check
severity: high
status: in-progress
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

### Diagnosis 1 — 2026-07-17

Reproduction status: confirmed (byte-for-byte match against the CI panic captured in the bug
report, reproduced locally via a validated proxy for the CI runner's UID-0 process — see rationale
in Evidence captured, since this sandbox has no passwordless root/sudo).

Evidence captured:
- Read the-intern/service/crates/admin-rpc/src/dispatch.rs:2746-2813 —
  `dispatch_schedule_add_store_write_error_returns_invalid_request` seeds a valid schedule store via
  `write_schedule_store`, then (2762-2768, `#[cfg(unix)]`) calls
  `std::fs::set_permissions(dir.path(), Permissions::from_mode(0o500))` on the tempdir holding the
  store, then dispatches `schedule.add` and asserts `DispatchOutcome::Err` /
  `CODE_INVALID_REQUEST` / message containing "failed to write schedule store".
- Read the-intern/service/crates/bob-core/src/types/schedule.rs:356-455 — `write_schedule_store`
  writes atomically: `create_dir_all(parent)` (no-op here, dir exists), reads `existing_mode` via
  `metadata(path)`, creates a uniquely-named temp file in `parent` with
  `OpenOptions::new().create_new(true).mode(mode).open(&tmp_path)`, then
  `std::fs::rename(&tmp_path, path)`. Both the temp-file creation and (in general) the rename into a
  differently-permissioned directory require the *directory's* write bit to be honored by the
  kernel's DAC check — exactly the bit the test strips to 0o500.
- Read the-intern/service/crates/admin-rpc/src/dispatch.rs:960-996
  (`persist_schedule_and_reload`) — any `Err` from `write_schedule_store` is wrapped unconditionally
  into `DispatchOutcome::Err(... CODE_INVALID_REQUEST, "schedule method: failed to write schedule
  store" ...)`; the test's `schedule_store_uid`-gated trust-boundary check (dispatch.rs:967-982) is
  not exercised (the test's dispatcher builder never calls `.with_schedule_store_uid`, so
  `schedule_store_uid` is `None`) — confirms `write_schedule_store`'s own I/O failure is the only
  thing the test is actually exercising.
- Baseline repro, non-root (current sandbox user, uid=1000): `cd the-intern/service && cargo test -p
  admin-rpc --lib dispatch::tests::dispatch_schedule_add_store_write_error_returns_invalid_request --
  --exact --nocapture` → `test ... ok` (1 passed). Confirms the test is not flaky and depends on the
  permission bit actually being enforced.
- Root-equivalent repro: this sandbox has no passwordless `sudo` (`sudo -n true` → "a password is
  required") and no docker daemon access, so genuine host root was unavailable. Used
  `unshare --map-root-user` instead — an unprivileged user namespace in which the calling process's
  real uid is mapped to namespace-uid 0, giving the process `CAP_DAC_OVERRIDE` over files owned by
  that mapping (documented Linux behavior; this is the same capability the CI report's Environment
  section attributes to the container's real-root process). Verified the underlying kernel mechanism
  first with a minimal repro: `chmod 0500` a tempdir, `touch` inside it as the current user → EACCES;
  same `touch` under `unshare --map-root-user` → succeeds (`uid=0(root)`, file created despite
  `dr-x------`). This is the exact same bypass class documented for real root.
  Then ran the actual failing test binary under the same namespace:
  `unshare --map-root-user -- bash -c "'target/debug/deps/admin_rpc-acda425cb68de143' \
  dispatch::tests::dispatch_schedule_add_store_write_error_returns_invalid_request --exact --nocapture"`
  → panicked with:
  `thread 'dispatch::tests::dispatch_schedule_add_store_write_error_returns_invalid_request' panicked
  at crates/admin-rpc/src/dispatch.rs:2810:42: expected write error, got Ok: Response { jsonrpc: "2.0",
  result: Object {"ok": Bool(true)}, id: Number(315) }` — identical file, line, panic text, and
  Response payload (including `id: Number(315)`) to the CI logs quoted in the bug report's Evidence
  section. This is a high-confidence proxy for genuine CI root, not merely a hypothesis.
- Scope check: `grep -rn "set_mode(0o[0-5]" --include=*.rs crates/` in the-intern/service returns
  only dispatch.rs:2765 — this is the only permission-bit-based failure injection in the workspace,
  so the fault is isolated to this single test with no sibling tests sharing the same fragility.
- Verified a UID-independent alternative failure mode exists at the same production call site: POSIX
  `rename(2)` onto an existing directory fails with `EISDIR` unconditionally (a filesystem
  type-conflict, not a DAC permission check — root/CAP_DAC_OVERRIDE does not exempt it). Verified with
  `python3 -c "import os; os.rename(file, existing_dir)"` → `IsADirectoryError: [Errno 21] Is a
  directory` both as the current user and under `unshare --map-root-user` (uid=0 in namespace) —
  identical failure both times. This lines up with `write_schedule_store`'s final step,
  `std::fs::rename(&tmp_path, path)` (schedule.rs:445), which is the step actually exercised by the
  test (parent dir and `existing_mode` metadata read both already succeed before this point in the
  "overwrite an existing store" scenario the test sets up).

Isolated fault: the-intern/service/crates/admin-rpc/src/dispatch.rs, test
`dispatch_schedule_add_store_write_error_returns_invalid_request` (lines 2746-2813), specifically the
failure-injection block at lines 2762-2768 (`permissions.set_mode(0o500)` +
`std::fs::set_permissions(dir.path(), permissions)`). The production code under test
(`write_schedule_store` in bob-core/src/types/schedule.rs, and its error mapping in dispatch.rs
`persist_schedule_and_reload`) is not at fault — it correctly surfaces whatever I/O error the
filesystem actually returns as `CODE_INVALID_REQUEST`; the test just fails to reliably *produce* an
I/O error on this runner.

Root cause (confirmed, not a hypothesis): the test's failure-injection strategy assumes the OS will
always enforce DAC directory-write permission bits for the test process. That assumption is false
whenever the process holds `CAP_DAC_OVERRIDE` relative to the target files — true for real root (the
self-hosted CI container runs the test suite as uid 0, per the bug report's Environment section) and
reproduced here via an equivalent namespaced-root mechanism. Under that capability, `chmod 0500` on
the directory becomes a no-op with respect to actual write-access decisions, so
`write_schedule_store`'s internal temp-file creation in that directory (and/or the terminal rename)
succeeds anyway, `schedule.add` dispatch returns `Ok`, and the test's `Err`/`CODE_INVALID_REQUEST`
assertion fails — exactly the observed and reproduced symptom. This is a UID-dependence bug in the
test's fault-injection mechanism, not in the production write/error-mapping path.

Planned fix (fix contract): replace the permission-bit-based failure injection with a UID-independent
structural conflict at the same call site the test already exercises (the final atomic rename inside
`write_schedule_store`), which fails deterministically for every UID including root:
  1. Keep the existing seed step unchanged (`write_schedule_store(&store_path, &[existing-job])`) so
     the test still represents "add to an existing store."
  2. Replace the `#[cfg(unix)] { set_mode(0o500); set_permissions(...) }` block (lines 2762-2768) with
     code that turns `store_path` itself into a directory instead of a regular file, e.g.
     `std::fs::remove_file(&store_path).expect("remove seeded store file");
     std::fs::create_dir(&store_path).expect("create blocking directory at store path");`. This makes
     the second `write_schedule_store` call's terminal `std::fs::rename(&tmp_path, &store_path)`
     (schedule.rs:445) fail with `EISDIR`/"Is a directory" unconditionally — verified above to be
     UID-independent (root and non-root both fail identically) — which `write_schedule_store` already
     wraps as `ServiceError::Persistence`, and dispatch.rs's `persist_schedule_and_reload` already maps
     to `CODE_INVALID_REQUEST` / "schedule method: failed to write schedule store" via the exact same
     code path as today, so no production code changes are needed.
  3. Remove the now-unneeded post-dispatch "restore tempdir permissions" `#[cfg(unix)]` block
     (lines 2787-2795) — there is no chmod to revert; `tempfile::tempdir()`'s `Drop` already removes
     the directory (and the blocking `store_path` directory within it) recursively on test teardown.
  4. Leave all assertions (id, `CODE_INVALID_REQUEST`, message substring) unchanged — they exercise
     the same wrapped-error path regardless of which underlying I/O error triggered it.
  5. Do not weaken or skip the test, and do not change `write_schedule_store` or the dispatch error
     mapping — the isolated fault is confined to the test's injection mechanism.

Planned verification:
  cd the-intern/service && cargo test -p admin-rpc --lib \
    dispatch::tests::dispatch_schedule_add_store_write_error_returns_invalid_request -- --exact
  (must pass as the current non-root sandbox user)
  unshare --map-root-user -- bash -c 'cd the-intern/service && cargo test -p admin-rpc --lib \
    dispatch::tests::dispatch_schedule_add_store_write_error_returns_invalid_request -- --exact'
  (must also pass under the namespaced-root proxy used for this diagnosis — the closest available
  local stand-in for the CI container's real-root process)
  cd the-intern/service && cargo test --workspace
  (full workspace regression check, matching the CI `Tests` job)

## Work Log

### Session 1 — 2026-07-17

Reproduced the diagnosed red state first, exactly as prescribed:
`unshare --map-root-user -- bash -c 'cd the-intern/service && cargo test -p admin-rpc --lib
dispatch::tests::dispatch_schedule_add_store_write_error_returns_invalid_request -- --exact'`
failed with the same panic captured in the bug report and Diagnosis Log
(`expected write error, got Ok: Response { ... id: Number(315) }`).

Implemented the fix contract's planned fix literally: replaced the `0o500`/`0o700` chmod
block with `std::fs::remove_file(&store_path)` followed by `std::fs::create_dir(&store_path)`
after the seed `write_schedule_store` call, and removed the now-unneeded post-dispatch
permission-restore block. This is UID-independent (fails identically under a plain user and
under `unshare --map-root-user`), but it fails the test on the wrong assertion:
`handle_schedule_add` reads `store_path` from disk via `load_schedule_entries_from_store` /
`read_schedule_store` *before* calling `write_schedule_store`, so turning `store_path` into a
directory makes `read_to_string` fail first with "failed to read schedule store" instead of
the write path producing "failed to write schedule store" — a discrepancy the Diagnosis Log's
evidence gathering did not surface, because it did not trace the earlier read call
`handle_schedule_add` performs for `schedule.add` specifically.

Also found that `dispatch_schedule_add_config_parse_error_preserves_request_id` (dispatch.rs:2707)
already covers the exact "failed to read schedule store" path via a malformed-JSON file (also
UID-independent, no permission bits involved) — so simply retargeting the assertion to match the
read-failure message would make the write-error test redundant with that existing test and drop
write-path coverage entirely.

Reasoned through five alternative UID-independent mechanisms that would let the read succeed
while only the write step fails (chattr +i / immutable attribute, a size-capped tmpfs bind-mounted
over the parent directory for ENOSPC, RLIMIT_FSIZE via setrlimit, a symlink or symlink loop at
store_path, deliberately filling the filesystem for ENOSPC) — none were coded, since each is
disqualified by a hard constraint (privilege the plain-sandbox process doesn't hold, cross-test
process-wide pollution, or non-hermetic host dependence).

Escalated to the Architect rather than force either a redundant test or a change outside the
"test-only fix" scope the fix contract authorized. No production code was touched this session;
the literal fix-contract attempt was left uncommitted and was discarded by the loop before Session 2.

### Session 2 — 2026-07-17

The Architect's directive (Escalation Verdict: RESOLVED): retire the dispatcher-level test
entirely — the dispatcher's persistence-error mapping is already structurally covered by
`dispatch_schedule_add_config_parse_error_preserves_request_id` — and add a UID-independent
unit test at the correct layer, bob-core, exercising `write_schedule_store`'s own terminal-rename
failure directly, without any production code change.

Executed exactly that. Removed `dispatch_schedule_add_store_write_error_returns_invalid_request`
(the `#[cfg(unix)]`-gated 0o500-chmod test) from
`the-intern/service/crates/admin-rpc/src/dispatch.rs` in full, leaving
`dispatch_schedule_add_config_parse_error_preserves_request_id` as the sole, unmodified
dispatcher-level test for the persistence-error → `CODE_INVALID_REQUEST` mapping.

Added one new unit test, `write_schedule_store_returns_persistence_error_when_rename_target_is_a_directory`,
to `the-intern/service/crates/bob-core/src/types/schedule.rs`. It creates a tempdir, creates a
*directory* at the target store path, calls `write_schedule_store` with one seeded entry, and
asserts the result is `Err(ServiceError::Persistence { .. })` whose message contains "failed to
rename temp schedule store" — matching `write_schedule_store`'s real terminal-rename failure
branch, which is unreachable from a preceding read (the writer never reads before writing) and is
not gated behind any permission bit CAP_DAC_OVERRIDE could bypass.

Verified genuineness of the assertion (not tautological) by temporarily removing the
`create_dir` call and re-running the test: it failed as expected, confirming the assertion is
actually exercised by the EISDIR condition. Restored the real test body. Verified the test passes
both as the plain sandbox user and under `unshare --map-root-user` (uid=0 inside that namespace)
— identical `ok` result both times, confirming UID-independence.

Made no production code changes. Ran all required verification clean: `cargo test -p bob-core --lib
schedule::` (40 passed, including the new test), `cargo test -p admin-rpc --lib schedule` (22
passed — retired test absent, sibling read-error test still passing), `cargo test --workspace`
(all 26 test binaries, 0 failed), and `cargo fmt --all -- --check` (clean). Committed a single
commit (`92ec858`, `test(schedule): move write-error coverage to bob-core, drop UID-dependent
test`) on `bug/B-022-schedule-add-write-error-test-root-bypass`, touching only `dispatch.rs` and
`schedule.rs`. Nothing remains outstanding on this bug.

**Obstacles Encountered:** Session 1's fix-contract attempt did not account for the read-before-write
ordering in `handle_schedule_add`, requiring Architect escalation before a correct fix direction
was available. No environment/setup issues in Session 2; the same `unshare --map-root-user` proxy
used in diagnosis and Session 1 worked identically here.

## Review

### Review Verdict — 2026-07-17

PASS

**Diagnosis→fix evidence chain:** Diagnosis 1 (2026-07-17) records reproduction status
(confirmed, byte-for-byte match against the CI panic, reproduced locally via a validated
`unshare --map-root-user` proxy since the sandbox has no passwordless root), evidence captured
(read of `dispatch.rs:2746-2813` and `schedule.rs:356-455`, baseline non-root repro, namespaced-root
repro, scope check for other permission-bit injection sites, and confirmation of a UID-independent
EISDIR-on-rename alternative), an isolated fault (the test's `0o500`-chmod failure-injection
mechanism, not the production write/error-mapping path), and a root cause (the injection assumes
DAC enforcement the test process's `CAP_DAC_OVERRIDE`, held under real root, bypasses). Session 1's
literal fix-contract attempt (turning `store_path` into a directory inside the dispatcher-level
test) was found to trip `handle_schedule_add`'s read-before-write ordering instead of the intended
write path, and was escalated rather than force a wrong fix. The Architect's directive (recorded in
Work Log Session 2, per the correction note that no separate Diagnosis 2 entry was needed since the
root cause diagnosis itself was correct) was to retire the dispatcher-level test and add a
UID-independent unit test in bob-core exercising `write_schedule_store`'s real terminal-rename
failure directly. This chain is complete and was verified before proceeding.

**Stage 1 — Bug criteria:**
- `dispatch_schedule_add_store_write_error_returns_invalid_request` was fully removed from
  `the-intern/service/crates/admin-rpc/src/dispatch.rs` (confirmed via diff and a workspace-wide
  `grep` — zero remaining references anywhere).
- `dispatch_schedule_add_config_parse_error_preserves_request_id` is byte-for-byte unchanged and
  still exercises the persistence-error → `CODE_INVALID_REQUEST` mapping (via the read/parse-error
  branch, through the same generic `map_err(... CODE_INVALID_REQUEST ...)` wrapping structure that
  `write_and_reload` uses for the write branch — confirmed by reading both call sites in
  `dispatch.rs`).
- The new bob-core test
  `write_schedule_store_returns_persistence_error_when_rename_target_is_a_directory`
  (`the-intern/service/crates/bob-core/src/types/schedule.rs`) genuinely exercises
  `write_schedule_store`'s terminal `std::fs::rename(&tmp_path, path)` EISDIR failure: independently
  verified non-tautological by commenting out its `std::fs::create_dir(&path)` call and re-running —
  the test failed as expected (`rename onto an existing directory must fail: ()`); restored and
  re-confirmed green. Independently verified UID-independence by running the test under
  `unshare --map-root-user` (namespaced root) — identical `ok` result to the plain-user run.
- No production code was modified — `write_schedule_store` (bob-core/src/types/schedule.rs) and all
  dispatch.rs logic are byte-for-byte identical to `dev-agent`; `git diff dev-agent...bug/B-022-...`
  touches only the two `#[cfg(test)] mod tests` blocks (69 lines removed from dispatch.rs, 27 lines
  added to schedule.rs — a net test-only change).
- No unrelated behavior was added; `git diff --stat` confirms only the two expected files changed.

**Fix Verification — re-run on `bug/B-022-schedule-add-write-error-test-root-bypass`:**
- `cargo test -p bob-core --lib schedule::` → 40 passed, 0 failed (includes the new test).
- `cargo test -p admin-rpc --lib schedule` → 22 passed, 0 failed (retired test absent, sibling
  read-error test present and passing).
- `cargo test --workspace` → all crates green, 0 failed across all binaries (113 passed in the
  largest suite plus the remaining crate suites, all `test result: ok`).
- `cargo fmt --all -- --check` → clean (exit 0).

**Stage 2 — Code quality:**
- Correctness: the new test's assertions (`ServiceError::Persistence` variant, message substring
  "failed to rename temp schedule store") match the exact error-construction site in
  `write_schedule_store`'s terminal `rename` call (`schedule.rs`, `"failed to rename temp schedule
  store to {}: {e}"`).
- Tests: independent (own `tempfile::tempdir()` per test), covers a distinct failure path from
  existing coverage, doubles as the regression test — confirmed to fail before the fix mechanism
  (the `create_dir` call) is present and pass after.
- Security: no secrets, no unvalidated external input introduced.
- Readability: the new test's comment clearly explains why EISDIR was chosen over a permission-bit
  approach (kernel type-conflict, not a DAC check root can bypass) — mirrors the Diagnosis Log's
  reasoning. No dead code or debugging artifacts left behind.
- Bug Fix Addendum: the fix is minimal (test-only, no production code, no unrelated refactoring);
  the removed test's coverage gap for the write-branch-specific `CODE_INVALID_REQUEST` message at
  the dispatch layer is a known, deliberate, Architect-approved tradeoff (structural mapping already
  covered by the sibling read-error test; the write-specific failure mode itself is now covered
  directly and reliably at the correct layer in bob-core) — not a gap introduced by this Developer
  session.

Both stages pass. No blocking issues found.

Next owner: Bug-Fix Loop.
