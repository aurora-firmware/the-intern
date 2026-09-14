---
id: B-046
title: verify_trusted_store tests assume tempdir defaults to 0700
severity: medium
status: open
created: '2026-09-14'
---

# verify_trusted_store tests assume tempdir defaults to 0700

## Summary

Two tests (`bob::config::tests::loads_schedule_entries_from_json_store_when_store_exists`
and `bob_core::types::schedule::tests::verify_trusted_store_accepts_owner_only_store`)
assume `tempfile::tempdir()` always produces an owner-only (`0700`) directory.
It does not: on Unix, `tempfile::tempdir()`'s created directory permissions
are the OS default (`0777`) minus the process's `umask`, not an explicit
`0700`. Under any umask that leaves the group-write bit set (e.g. `0002`,
a legitimate, common convention for group-collaborative setups — not
unusual or sandbox-specific), the resulting directory is `0775`, which
`verify_trusted_store`'s ADR-009/ADR-012 trust check then correctly refuses
as "group/other writable". The tests fail deterministically on any such
machine; `verify_trusted_store` itself is not at fault — it is doing
exactly what it's specified to do.

## Reproduction Status

Status: confirmed

Reproduced directly: added a throwaway probe test creating a bare
`tempfile::tempdir()` and printing its resolved mode; measured `0775` with
this environment's `umask` at `0002` (`0777 & ~0002 == 0775`). Both affected
tests fail with the exact same error text this predicts.

## Evidence

- Failing command: `cargo test -p bob --lib config::tests::loads_schedule_entries_from_json_store_when_store_exists`
  ```
  thread '...' panicked at crates/bob/src/config.rs:1871:10:
  config should load: Configuration { detail: "schedule store parent directory /tmp/.tmpdvK59s is group/other writable (mode 775); refusing to trust its contents" }
  ```
- Failing command: `cargo test -p bob-core --lib verify_trusted_store`
  ```
  thread '...types::schedule::tests::verify_trusted_store_accepts_owner_only_store' panicked at crates/bob-core/src/types/schedule.rs:888:52:
  owner-only 0600 store must be trusted: Configuration { detail: "schedule store parent directory /tmp/.tmpFd4eGv is group/other writable (mode 775); refusing to trust its contents" }
  ```
- `cargo test --workspace` fail-fasts on the first failure (`bob --lib`) by
  default, so the second instance (`bob-core --lib`) was only found by
  running each crate individually with `--no-fail-fast`/per-crate. Every
  other crate (`admin-rpc`, `extension-ipc`, `monitoring`, `persistence`,
  `pi-agent-supervisor`, `policy-control`, `requests-handler`,
  `scheduler-adapter`) passes cleanly — neither of their test suites has
  this pattern in a way that's currently exercised.
- Probe evidence (throwaway test, not committed):
  `PROBE path="/tmp/.tmpEQx7sC" mode=775 owner_uid=1000 current_uid=1000`,
  `umask` = `0002`.

## Reproduction Steps

1. On a machine/shell with `umask 0002` (or any umask that doesn't clear
   the group-write bit), run:
   `cd the-intern/service && cargo test -p bob-core --lib verify_trusted_store -- --nocapture`
2. Observe `verify_trusted_store_accepts_owner_only_store` fails; the other
   three `verify_trusted_store_*` tests in the same file pass, because they
   explicitly `set_permissions` on the directory/file under test rather
   than trusting the ambient tempdir mode.
3. Separately: `cargo test -p bob --lib config::tests::loads_schedule_entries_from_json_store_when_store_exists` fails the same way.

## Expected Behavior

Both tests should pass regardless of the ambient process umask, since they
are testing that a directory that *is* owner-only-safe is accepted — the
directory's actual safety should not depend on an unstated environmental
assumption.

## Actual Behavior

Both tests create their working directory via bare `tempfile::tempdir()`
and never harden its permissions, so under a umask that leaves the
group-write bit set, the directory ends up genuinely group-writable and
`verify_trusted_store` correctly refuses it — failing the test's own
"must be trusted" expectation for reasons unrelated to the behavior each
test is actually trying to verify.

## Environment

- OS / platform: Linux (reproduced with `umask 0002`); not umask-specific to
  any one platform — any Unix shell/container with a non-restrictive umask
  reproduces it identically.
- Language / runtime version: Rust, `tempfile` crate 3.27.0 (per `Cargo.lock`)
- Relevant dependencies: `bob-core` (`verify_trusted_store`,
  `write_schedule_store`), `bob` (`config::load_with_sources`)
- Branch / commit: `dev-agent` at the time of diagnosis (post `9fd481f`)

## Related

- Task: none
- Specification: none — this is a test-fixture defect, not a behavior gap
  in any approved spec. `verify_trusted_store`'s enforcement itself is
  correct per ADR-009/ADR-012 and needs no change.

## Suspected Area

`crates/bob/src/config.rs` (one test) and
`crates/bob-core/src/types/schedule.rs` (one test) — specifically their use
of bare `tempfile::tempdir()` as a stand-in for an owner-only directory.

## Fix Verification

```bash
cd the-intern/service
cargo test -p bob-core --lib verify_trusted_store -- --nocapture
cargo test -p bob --lib config::tests::loads_schedule_entries_from_json_store_when_store_exists -- --nocapture
cargo test --workspace --no-fail-fast --lib
```

## Diagnosis Log

### Diagnosis 1 — 2026-09-14

Reproduction status: confirmed (see Evidence above).
Evidence captured: probe test measuring the real mode `tempfile::tempdir()`
produces under this shell's `umask 0002`; both failing tests' exact panic
messages; a full per-crate sweep confirming no other crate is affected.
Isolated fault: `crates/bob/src/config.rs:1832` (test
`loads_schedule_entries_from_json_store_when_store_exists`) and
`crates/bob-core/src/types/schedule.rs:881` (test
`verify_trusted_store_accepts_owner_only_store`) — both call bare
`tempfile::tempdir()` and treat its result as owner-only without hardening
it, unlike the sibling `verify_trusted_store_fails_closed_on_*` tests in
the same file, which already explicitly `set_permissions` before asserting.
Root cause: `tempfile::tempdir()` does not explicitly force `0700`; its
result is the OS default `mkdir` permission (`0777`) minus the calling
process's umask. Neither test accounts for that, unlike this project's own
production code (`ensure_directory`/`set_owner_only_mode` in
`init_materializer.rs`), which explicitly `chmod`s to `0700` for exactly
this reason.
Planned fix: in both tests, explicitly
`std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700))`
immediately after creating the tempdir and before writing the schedule
store into it — mirroring the explicit-`set_permissions` pattern the
sibling negative-path tests in `schedule.rs` already use.
Planned verification: the two previously-failing tests pass; the full
per-crate sweep stays green; no other test in either file regresses.

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
