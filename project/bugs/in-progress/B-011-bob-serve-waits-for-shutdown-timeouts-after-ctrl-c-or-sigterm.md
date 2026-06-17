---
id: B-011
title: bob serve waits for shutdown timeouts after Ctrl-C or SIGTERM
severity: medium
status: in-progress
created: '2026-06-17'
---

# bob serve waits for shutdown timeouts after Ctrl-C or SIGTERM

## Summary

`bob serve` receives Ctrl-C (`SIGINT`) and `SIGTERM` promptly, but it does not
exit promptly. Instead, shutdown waits for the configured phase 3 drain deadline
and then the phase 4 pi-agent reap deadline to expire before completing. With
production defaults this makes an idle service appear hung for roughly 40
seconds after the user asks it to stop.

## Reproduction Status

Status: confirmed

Confirmed on `dev-agent` with controlled `bob serve` runs using shortened
shutdown deadlines. Both Ctrl-C/SIGINT and `kill -TERM` enter the shutdown path
immediately, then wait for phase 3 and phase 4 timeout expiry.

## Evidence

- Ctrl-C/SIGINT reproduction command:
  `env RUST_LOG=info BOB_ADMIN_SOCK_PATH=/tmp/bob-sigterm-debug/admin.sock BOB_EXTENSION_SOCK_PATH=/tmp/bob-sigterm-debug/extension.sock BOB_SHUTDOWN_DRAIN_DEADLINE=3000ms BOB_SHUTDOWN_REAP_DEADLINE=3000ms target/debug/bob serve`
- After Ctrl-C, logs showed `shutdown signal received, signal: "SIGINT"`,
  followed by `shutdown: phase 3 — drain deadline exceeded; proceeding` after
  3 seconds and `shutdown: phase 4 — reap deadline exceeded; proceeding` after
  another 3 seconds.
- SIGTERM reproduction command:
  `env RUST_LOG=info BOB_ADMIN_SOCK_PATH=/tmp/bob-sigterm-debug/admin.sock BOB_EXTENSION_SOCK_PATH=/tmp/bob-sigterm-debug/extension.sock BOB_SHUTDOWN_DRAIN_DEADLINE=1000ms BOB_SHUTDOWN_REAP_DEADLINE=1000ms target/debug/bob serve`,
  then `kill -TERM <bob-pid>`.
- After SIGTERM, logs showed `shutdown signal received, signal: "SIGTERM"`,
  then phase 3 and phase 4 both expired at their configured 1-second deadlines.
- In both reproductions, `admin-rpc`, `requests-handler`, `persistence`, and
  `extension-ipc` stopped quickly, while the main `monitoring`,
  `policy-control`, `chat-adapter`, `scheduler-adapter`, and
  `pi-agent-supervisor` actors did not stop before the deadlines.
- `pgrep -ax bob` and `pgrep -ax pi` returned no processes after the controlled
  reproductions completed.

## Reproduction Steps

1. Build `bob` from `the-intern/service`.
2. Start `bob serve` with explicit socket paths and short shutdown deadlines:
   `env RUST_LOG=info BOB_ADMIN_SOCK_PATH=/tmp/bob-sigterm-debug/admin.sock BOB_EXTENSION_SOCK_PATH=/tmp/bob-sigterm-debug/extension.sock BOB_SHUTDOWN_DRAIN_DEADLINE=1000ms BOB_SHUTDOWN_REAP_DEADLINE=1000ms target/debug/bob serve`
3. Send Ctrl-C or run `kill -TERM <bob-pid>`.
4. Observe that the signal is logged immediately, but shutdown only completes
   after the phase 3 drain deadline and phase 4 reap deadline expire.

## Expected Behavior

Ctrl-C/SIGINT and SIGTERM should stop an idle `bob serve` promptly and cleanly:
the service should cancel/close owned listeners and connection tasks, drop all
subsystem handles, let actors observe closed channels, reap pi-agent children,
remove socket files, and exit without relying on the drain/reap timeout fallback
path.

## Actual Behavior

`bob serve` handles the signal but waits for shutdown timeout fallback paths:
phase 3 waits until `shutdown_drain_deadline` expires, then phase 4 waits until
`shutdown_reap_deadline` expires. With defaults from `BobConfig`, this is
30 seconds plus 10 seconds.

## Environment

- OS / platform: Linux
- Language / runtime version: Rust workspace (`the-intern/service`)
- Relevant dependencies: tokio signal handling, tokio tasks, Unix domain sockets
- Branch / commit: `dev-agent` at local checkout on 2026-06-17

## Related

- Specification: `S-002-bob-service-shell-architecture.md`
- Related code paths: `the-intern/service/crates/bob/src/serve.rs`,
  `the-intern/service/crates/admin-rpc/src/lib.rs`

## Suspected Area

Shutdown ownership for the admin RPC listener and active connection tasks.
`admin-rpc::start` spawns `run_listener` as a detached task; that listener loops
forever and owns a `Dispatcher` containing cloned subsystem handles. Those
clones keep subsystem channels open during `bob` shutdown, so actor join handles
do not resolve until the configured shutdown deadlines expire.

## Fix Verification

```bash
cd the-intern/service
cargo test -p bob serve::tests
cargo test -p bob --test shell_e2e -- --nocapture
cargo test --workspace

# Add a regression test or shell e2e assertion that starts an idle bob serve,
# sends SIGINT or SIGTERM, and asserts it exits before the configured
# drain/reap deadlines are consumed.
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

### Diagnosis 1 — 2026-06-17

Reproduction status:
Confirmed. Both Ctrl-C/SIGINT and `kill -TERM` are observed immediately by
`bob serve`, but shutdown waits for configured phase 3 and phase 4 deadlines to
expire before exiting.

Evidence captured:
- Ctrl-C/SIGINT run with `BOB_SHUTDOWN_DRAIN_DEADLINE=3000ms` and
  `BOB_SHUTDOWN_REAP_DEADLINE=3000ms` logged immediate signal receipt, then
  phase 3 timeout expiry, then phase 4 timeout expiry.
- SIGTERM run with `BOB_SHUTDOWN_DRAIN_DEADLINE=1000ms` and
  `BOB_SHUTDOWN_REAP_DEADLINE=1000ms` logged the same behavior for
  `signal: "SIGTERM"`.
- Shutdown logs showed only `admin-rpc`, `requests-handler`, `persistence`, and
  `extension-ipc` stopped before phase 3 timeout. The actors whose channels are
  still held by the detached admin listener dispatcher did not stop before the
  deadlines.

Isolated fault:
`the-intern/service/crates/admin-rpc/src/lib.rs` spawns `run_listener` as a
detached task in `admin_rpc::start`; `run_listener` loops forever and owns a
`Dispatcher` with cloned subsystem handles. `bob` shutdown has no handle to
cancel or await the listener, so those clones stay alive while
`run_shutdown_protocol` awaits subsystem joins in
`the-intern/service/crates/bob/src/serve.rs`.

Root cause or fault hypothesis:
The top-level signal handling is correct. The shutdown graph is wrong: detached
admin listener and possible active connection tasks keep subsystem handle clones
alive after the runtime drops its own handles, preventing channel-close-driven
actor shutdown. Phase 3 and phase 4 then complete only by timeout fallback.

Planned fix:
Make the admin listener and active connection tasks owned by cancellable runtime
state. On shutdown, cancel/abort the listener so it stops accepting new
connections and drops its dispatcher clones before awaiting subsystem joins.
Also ensure active admin connection tasks are cancelled or drained in the same
shutdown phase so their dispatcher clones cannot keep actors alive.

Planned verification:
Add a regression test that starts an idle `bob serve`, sends SIGINT or SIGTERM,
and asserts clean exit before consuming the configured drain/reap deadlines.
Run `cargo test -p bob serve::tests`, `cargo test -p bob --test shell_e2e --
--nocapture`, and `cargo test --workspace`.

### Diagnosis 2 — 2026-06-17

Reproduction status:
Confirmed. On an idle `bob serve` process with `BOB_SHUTDOWN_DRAIN_DEADLINE=700ms`
and `BOB_SHUTDOWN_REAP_DEADLINE=700ms`, both `SIGTERM` and `SIGINT` were logged
immediately, but process exit still took about 1.4s and only completed after
phase 3 and phase 4 timeout fallback paths fired.

Evidence captured:
- `cargo build -p bob`
- Unsandboxed SIGTERM repro from `the-intern/service`:
  `RUST_LOG=info BOB_ADMIN_SOCK_PATH=/tmp/bob-b011-term4-.../admin.sock BOB_EXTENSION_SOCK_PATH=/tmp/bob-b011-term4-.../extension.sock BOB_SHUTDOWN_DRAIN_DEADLINE=700ms BOB_SHUTDOWN_REAP_DEADLINE=700ms target/debug/bob serve --config-monitoring.audit_log_path=/tmp/bob-b011-term4-.../audit.jsonl`
  then `kill -TERM <pid>`.
  Observed `elapsed_ms=1407`, immediate `shutdown signal received, signal: "SIGTERM"`,
  then `shutdown: phase 3 — drain deadline exceeded; proceeding`, then
  `shutdown: phase 4 — reap deadline exceeded; proceeding`.
- Unsandboxed SIGINT repro with the same configuration, then `kill -INT <pid>`.
  Observed `elapsed_ms=1404`, immediate `shutdown signal received, signal: "SIGINT"`,
  then the same phase 3 and phase 4 timeout fallback messages.
- No admin client connected during either run, so no accepted admin connection was
  needed to trigger the delay.

Isolated fault:
`admin_rpc::start` in `the-intern/service/crates/admin-rpc/src/lib.rs` spawns
`run_listener(listener, dispatcher, bus)` with `tokio::spawn(...)` and returns only
the command-actor `Handle` plus actor `JoinHandle<()>`. `bob::start_subsystems` in
`the-intern/service/crates/bob/src/serve.rs` clones supervisor, policy, monitoring,
chat-adapter, and scheduler handles into the admin-rpc dispatcher, but `Runtime`
does not retain any join/cancel handle for the spawned admin listener task.

Root cause:
The shutdown protocol drops the top-level runtime handles, but the detached
admin listener still owns a cloned `Dispatcher`, and that dispatcher still owns
cloned subsystem handles. Because the listener is not cancelled or awaited in
phase 1, channel-close-driven shutdown never reaches monitoring, policy-control,
chat-adapter, scheduler-adapter, or pi-agent-supervisor promptly. Phase 3 then
times out waiting on actor joins, and phase 4 times out waiting on the supervisor
join. Active admin connection tasks share the same ownership flaw, but the idle
reproduction proves the detached listener alone is sufficient to cause B-011.

Planned fix:
Make the admin listener an owned, cancellable part of runtime state instead of a
detached task. `bob` shutdown phase 1 must explicitly stop and await the admin
listener before draining subsystem joins, and admin-rpc should also track/cancel
spawned connection tasks so no dispatcher clones survive shutdown.

Planned verification:
- Add a regression that starts idle `bob serve`, sends `SIGTERM` and/or `SIGINT`,
  and asserts exit happens before consuming the configured drain/reap deadlines,
  not merely before `drain + reap + margin`.
- Run:
  `cargo test -p bob serve::tests`
  `cargo test -p bob --test shell_e2e -- --nocapture`
  `cargo test --workspace`

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

### Session 1 — 2026-06-17

I implemented the diagnosed shutdown fix by moving admin-RPC listener ownership
under a shared shutdown signal and making the listener own and drain active
connection tasks instead of spawning detached work that `bob` could not cancel.
In `bob` shutdown phase 1, I now request admin-RPC shutdown before dropping
subsystem handles so the listener and any connection tasks release their
dispatcher clones before phase 3 waits on actor joins. I added a unit-level
regression in `serve.rs` that measures idle shutdown duration against the
configured drain deadline, and tightened the shell E2E SIGTERM path to assert
the spawned idle service exits before that fallback deadline is consumed. The
first red run in the restricted sandbox was misleading because Unix-socket
startup failed there, so I reran the shutdown regressions outside the sandbox to
get a real reproduction; both failed on the new timing assertion before the fix
and passed after it. I kept the public `admin_rpc::start` return shape unchanged
and rejected a broader API redesign because the existing handle-plus-join
contract was enough once the listener and connection lifecycle were made
internally owned. Nothing remains on the bug branch from the implementation
side.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that diagnosis, fix, verification, and code quality passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->
