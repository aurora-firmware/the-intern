---
id: B-057
title: non_serve tests inherit XDG_RUNTIME_DIR and BOB_* env
severity: medium
status: open
created: '2026-10-14'
---

# non_serve tests inherit XDG_RUNTIME_DIR and BOB_* env

## Summary

`crates/bob/tests/non_serve.rs` spawns the `bob` binary through
`bob_command_with_temp_state`, which isolates `XDG_STATE_HOME` and `HOME` but
inherits everything else from the test process — notably `XDG_RUNTIME_DIR`,
`XDG_CONFIG_HOME`, and every `BOB_*` variable (bob's config accepts any
`BOB_*` key as an override). The suite asserts behaviour *without* a running
service, so on a developer machine where an installed `bob serve` is running,
or where the shell exports the dev environment's socket paths, the tests
reach a real service: one fails on the exit code, the `audit tail` tests
stream forever and hang `cargo test --workspace`, and the runtime-dir
fallback test sees an explicit socket override instead of the fallback.
CI is unaffected (no live bob on the runners). Test-only; no production code
is wrong.

## Reproduction Status

Status: confirmed

Reproduced 2026-10-14 in two environments: with the desktop session's
`XDG_RUNTIME_DIR=/run/user/1000` and a live installed `bob serve`, and with
the `scripts/dev-env.sh` environment (which exports `BOB_ADMIN_SOCK_PATH`).
With `XDG_RUNTIME_DIR` pointed at an empty temp dir and no `BOB_*` exported,
all 13 tests pass.

## Evidence

- Logs / stack traces / failing assertions:
  - live service: `status_exits_non_zero_when_admin_socket_is_missing`
    panicked at `non_serve.rs:16` — `left: Some(0)`, `right: Some(1)`; two
    `target/debug/bob audit tail --filter …` children of the `non_serve`
    binary then streamed from the live service until killed.
  - dev env: `missing_socket_error_flags_unresolved_runtime_dir` panicked at
    `non_serve.rs:48` — stderr was `missing admin socket at
    …/.tmp/bob-dev/run/admin.sock`, with no `XDG_RUNTIME_DIR` hint, because
    the inherited `BOB_ADMIN_SOCK_PATH` replaced the fallback path.
- Screenshots or recordings: n/a
- Failing command or test: `cargo test -p bob --test non_serve`
- First diagnostic step if not yet reproduced: n/a

## Reproduction Steps

1. Start a bob service whose admin socket is at `$XDG_RUNTIME_DIR/bob/admin.sock`
   (an installed `bob serve` in a desktop session), or export
   `BOB_ADMIN_SOCK_PATH` to any path.
2. From `the-intern/service/`, run `cargo test -p bob --test non_serve`.
3. Observe the failure (and, with a live service, the hang in the `audit tail` tests).

## Expected Behavior

Every `non_serve` test runs the binary against a private runtime/config
environment of its own, so the result does not depend on the caller's
`XDG_*` or `BOB_*` variables or on any service running on the machine.

## Actual Behavior

The tests use whatever socket the inherited environment resolves to: they
connect to a live service (wrong exit code, hang) or to an explicit
`BOB_ADMIN_SOCK_PATH` override (wrong error message).

## Environment

- OS / platform: Linux (Debian 13, GNOME/Wayland session)
- Language / runtime version: cargo 1.96.0
- Relevant dependencies: none
- Branch / commit: `dev-agent` at `4f8e239`

## Related

- Task: none (found while running the dev-loop baseline)
- Specification: none

## Suspected Area

`the-intern/service/crates/bob/tests/non_serve.rs` —
`bob_command_with_temp_state` (environment of the spawned binary).

## Fix Verification

```bash
# Must pass with a live bob serve running AND with the dev env exported:
./scripts/cargo-dev.sh test -p bob --test non_serve
(cd the-intern/service && cargo test -p bob --test non_serve)
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
