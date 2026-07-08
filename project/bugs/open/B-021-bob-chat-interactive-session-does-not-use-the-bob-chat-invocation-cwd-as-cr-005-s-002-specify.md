---
id: B-021
title: bob chat interactive session does not use the bob chat invocation cwd as 
  CR-005/S-002 specify
severity: medium
status: open
created: '2026-07-08'
task: T-129
---

# bob chat interactive session does not use the bob chat invocation cwd as CR-005/S-002 specify

## Summary

The CR-005 amendment to S-002 (approved and applied 2026-07-05) states that
`bob chat` "runs the supervised interactive `pi` session in the current
working directory where the `bob chat` command is invoked; it does **not**
consult `pi_agent_cwd`" and CR-005's resolved decision records this as
"Interactive chat: use the cwd where `bob chat` is invoked (no change)" — i.e.
the CR-005 author believed the pre-existing implementation already provided
this behaviour, so no implementation task was created for it. It does not:
the `bob chat` client never sends its own working directory to `bob serve`,
and the server never calls `current_dir` when spawning the interactive `pi`
child. In practice the interactive session's working directory is whatever
directory the long-running `bob serve` process itself happens to be running
in — not the directory the operator typed `bob chat` from. This surfaced
while writing accurate operator-guide content for T-129 (documenting
`pi_agent_cwd`/`--cwd` precedence); T-129 is docs-only and out of scope to
fix this.

## Reproduction Status

Status: confirmed (static — verified by reading the full `bob chat` data
path; the divergence is deterministic, not a race or environment-dependent
flake)

## Evidence

- `the-intern/service/crates/bob/src/cli/commands/chat.rs`: the
  `session.interactive.open` JSON-RPC request sent by the client hard-codes
  `"params": {}` — no working-directory (or any other) field is included, so
  the server has no way to learn where the `bob chat` client was invoked
  from.
- `the-intern/service/crates/admin-rpc/src/lib.rs`: `InteractiveSessionConfig`
  (the struct that configures how `session.interactive.open` spawns the
  child) has fields `command`, `args`, `child_termination_deadline`,
  `extension_sock_path`, `extension_path` — no `cwd`/working-directory field
  exists on this struct at all.
- `the-intern/service/crates/pi-agent-supervisor/src/process.rs`:
  `InteractiveProcessConfig` likewise has no working-directory field, and
  `InteractiveProcess::spawn` never calls `Command::current_dir(..)` on the
  `tokio::process::Command` it builds (contrast with
  `RpcWorkerProcess::spawn`, a few dozen lines above in the same file, which
  does call `cmd.current_dir(worker_cwd)` when `WorkerProcessConfig.worker_cwd`
  is `Some`). Per `std::process::Command` semantics, a child spawned without
  `current_dir` inherits the *spawning process's* cwd — here, `bob serve`'s
  own launch cwd — not the cwd of whichever remote client asked it to spawn
  a session.
- `crates/bob/src/serve.rs::build_interactive_session_config` confirms no
  `pi_agent_cwd` or any per-caller cwd is threaded into
  `InteractiveSessionConfig` either.

## Reproduction Steps

1. Start `bob serve` from directory `A` (e.g. `the-intern/service`).
2. From a different directory `B`, run `bob chat`.
3. Ask the interactive pi session to report its working directory (e.g. `pwd`
   via a shell tool, or inspect the child process's `/proc/<pid>/cwd` on
   Linux).
4. Observe the reported cwd is `A` (bob serve's launch cwd), not `B` (the
   directory `bob chat` was invoked from).

## Expected Behavior

Per the approved CR-005 amendment to S-002 (Component 7 / interactive-chat
workflow): the interactive `pi` session spawned by `bob chat` should run in
the working directory from which the `bob chat` command itself was invoked,
and should never consult `pi_agent_cwd`.

## Actual Behavior

The interactive `pi` session always runs in whatever directory the `bob
serve` process is itself running in (its own launch cwd) — completely
independent of the directory `bob chat` was invoked from, and also
independent of `pi_agent_cwd` (which is correctly never consulted for
interactive sessions, so that half of the CR-005 claim does hold).

## Environment

- OS / platform: Linux (also applies to macOS; the spawn code path is not
  platform-specific)
- Language / runtime version: Rust workspace at `the-intern/service`
- Relevant dependencies: `tokio::process::Command` inheriting cwd semantics
- Branch / commit: observed on `dev-agent` at the current tip (T-127/T-128
  already merged); the gap predates CR-005 and CR-005 did not add any code to
  close it

## Related

- Task: `T-129` (discovered while documenting CR-005's cwd behaviour in the
  operator guide)
- Specification: `S-002-bob-service-shell-architecture.md` (Component 7 /
  interactive-chat workflow bullet, and the Amendment Log row for CR-005)
- Change request: `CR-005-configurable-working-directory-for-bob-serve-workers-and-scheduled-entries.md`
  (§"Interactive chat" impact note and §"Resolved decisions") and
  `CR-005-amendment-drafts.md` §1e / §7 item 3

## Suspected Area

`the-intern/service/crates/bob/src/cli/commands/chat.rs` (client never sends
its cwd), `the-intern/service/crates/admin-rpc/src/lib.rs`
(`InteractiveSessionConfig` has no cwd field), and
`the-intern/service/crates/pi-agent-supervisor/src/process.rs`
(`InteractiveProcessConfig`/`InteractiveProcess::spawn` never call
`current_dir`).

## Fix Verification

```bash
# After a fix threads the bob-chat invocation cwd through session.interactive.open
# to InteractiveProcess::spawn (or the spec/CR-005 decision is revised instead),
# a targeted regression test in pi-agent-supervisor should assert that
# InteractiveProcess::spawn sets current_dir from a caller-supplied cwd, mirroring
# the existing spawn_sets_current_dir_on_child_when_worker_cwd_is_configured test
# for RpcWorkerProcess::spawn:
cd the-intern/service && cargo test -p pi-agent-supervisor
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
