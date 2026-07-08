---
id: B-021
title: bob chat interactive session does not use the bob chat invocation cwd as 
  CR-005/S-002 specify
severity: medium
status: resolved
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

### Diagnosis 1 — 2026-07-08

Reproduction status: confirmed (static source-path trace, cross-checked independently against the
bug report's evidence; additionally confirmed dynamically via a temporary, fully-reverted unit test
run against the real InteractiveProcess::spawn code path — see Evidence captured).

Evidence captured:
- Read the-intern/service/crates/bob/src/cli/commands/chat.rs:57-62 — `session.interactive.open`
  request hard-codes `"params": {}`; no cwd or any other field is sent by the client.
- Read the-intern/service/crates/admin-rpc/src/dispatch.rs:218-249 — `Dispatcher::dispatch` routes
  `"session.interactive.open" => self.handle_session_interactive_open(id).await` — note this call
  passes only `id`, not `request.params`, so even if the client did send a cwd it would be discarded
  at the dispatch layer before reaching the handler (this is a stronger/more specific finding than
  what the bug report evidence section states, but consistent with and reinforcing its conclusion).
- Read the-intern/service/crates/admin-rpc/src/lib.rs:95-113 — `InteractiveSessionConfig` fields:
  command, args, child_termination_deadline, extension_sock_path, extension_path. No cwd field.
- Read the-intern/service/crates/admin-rpc/src/lib.rs:480-491 — `handle_interactive_session_opening`
  builds `interactive_cfg` purely from `dispatcher.interactive_session_config()` (server-side static
  config) or hard-coded defaults; no per-connection/per-caller value is ever consulted.
- Read the-intern/service/crates/pi-agent-supervisor/src/process.rs:262-273 — `InteractiveProcessConfig`
  fields: command, args, child_termination_deadline, session_id, extension_sock_path, extension_path.
  No cwd field (contrast with `WorkerProcessConfig` at line 15-29, which has `pub worker_cwd:
  Option<PathBuf>`).
- Read the-intern/service/crates/pi-agent-supervisor/src/process.rs:301-340 — `InteractiveProcess::spawn`
  builds `tokio::process::Command` and never calls `.current_dir(...)` anywhere in the function body
  (contrast with `RpcWorkerProcess::spawn` at line 50-82, which calls `cmd.current_dir(worker_cwd)`
  at line 73-75 when `cfg.worker_cwd` is `Some`).
- Read the-intern/service/crates/bob/src/serve.rs:151-152 and 304 — `build_interactive_session_config`
  constructs `InteractiveSessionConfig` from static `BobConfig`/CLI flags only; no `pi_agent_cwd` or
  any caller cwd is threaded in (confirms the bug report's claim that CR-005's `pi_agent_cwd` is
  correctly never consulted for interactive sessions — that half of CR-005 does hold — but also that
  nothing else fills the gap).
- Ran `cargo test -p pi-agent-supervisor` and confirmed no existing test asserts interactive-session
  cwd behavior (the only cwd-related test, `spawn_sets_current_dir_on_child_when_worker_cwd_is_configured`,
  covers `RpcWorkerProcess`, not `InteractiveProcess`).
- Dynamic confirmation: added a temporary test
  `b021_diagnostic_interactive_spawn_inherits_parent_process_cwd_not_a_caller_cwd` in
  crates/pi-agent-supervisor/src/process.rs (test module only), which spawned a real
  `InteractiveProcess` running `sh -c pwd` via `InteractiveProcess::spawn` and asserted the child's
  reported cwd equals the *test process's own launch cwd* (canonicalized). Ran via
  `cargo test -p pi-agent-supervisor b021_diagnostic -- --nocapture`: PASSED, i.e. the child cwd is
  provably always the spawning process's cwd — there is no field on InteractiveProcessConfig through
  which a caller-supplied directory could even be threaded, so this holds regardless of which
  directory `bob chat` is invoked from. The instrumentation was then reverted with
  `git checkout -- crates/pi-agent-supervisor/src/process.rs`; `git status --short` on the file is
  clean and the full `cargo test -p pi-agent-supervisor` suite (61 tests) passes with the reverted
  tree, confirming no diagnostic residue remains.

Isolated fault: three-way gap, all required for a fix:
  1. the-intern/service/crates/bob/src/cli/commands/chat.rs — client never captures/sends
     `std::env::current_dir()` in the `session.interactive.open` request params.
  2. the-intern/service/crates/admin-rpc/src/dispatch.rs `Dispatcher::dispatch` /
     `handle_session_interactive_open` and lib.rs `InteractiveSessionConfig` — server discards
     `request.params` for this method entirely and has no field to carry a per-caller cwd through to
     spawn config.
  3. the-intern/service/crates/pi-agent-supervisor/src/process.rs — `InteractiveProcessConfig` has no
     cwd field and `InteractiveProcess::spawn` never calls `Command::current_dir(..)`.

Root cause: CR-005's amendment to S-002 states the pre-existing implementation already used the
`bob chat` invocation cwd for interactive sessions ("no change" needed), but no such wiring exists or
ever existed on the interactive-session path. The client-to-spawn chain for `session.interactive.open`
was built (T-104/T-105/ADR-011) without a cwd concept at all — unlike the RPC worker path
(WorkerProcessConfig.worker_cwd / T-121), which does have end-to-end cwd plumbing. This is confirmed
root cause (not a hypothesis): the absence is structural and deterministic across all three layers,
independently verified by direct code reading and by a passing dynamic test that proves the child
cwd can only ever equal the server process's own launch cwd.

Planned fix (fix contract): thread the `bob chat` invocation cwd end-to-end:
  1. In chat.rs, capture `std::env::current_dir()` at the start of `run_interactive_session` and
     include it in the `session.interactive.open` request params (e.g. `{"cwd": "<path>"}`), with a
     clear error if the cwd cannot be resolved.
  2. In dispatch.rs, pass `request.params` through to `handle_session_interactive_open` (mirroring
     how `handle_sessions_kill`/`handle_report_submit` already receive `&Option<Value>`), parse an
     optional `cwd` string field, and thread it into the spawn-config construction path in lib.rs
     (`handle_interactive_session_opening`) instead of relying solely on the static
     `InteractiveSessionConfig`.
  3. Add a `cwd: Option<PathBuf>` field to `InteractiveProcessConfig` in
     pi-agent-supervisor/src/process.rs, and call `cmd.current_dir(cwd)` in `InteractiveProcess::spawn`
     when `Some`, mirroring `RpcWorkerProcess::spawn`'s existing `worker_cwd` handling exactly
     (including leaving it unset — inherit launch cwd — when `None`, e.g. if resolving the client's
     cwd fails or the field is absent for backward compatibility).
  4. Per CR-005, `pi_agent_cwd` must continue to be never consulted for interactive sessions — the fix
     must not introduce any read of `pi_agent_cwd` on this path.

Planned verification:
  cd the-intern/service && cargo test -p pi-agent-supervisor
  (add a new regression test asserting `InteractiveProcess::spawn` sets `current_dir` from a
  caller-supplied cwd, mirroring `spawn_sets_current_dir_on_child_when_worker_cwd_is_configured`,
  plus a companion test asserting the launch-cwd-inherited fallback behavior when `cwd` is `None`,
  mirroring `spawn_inherits_launch_cwd_when_worker_cwd_is_not_configured`)
  cd the-intern/service && cargo test -p admin-rpc
  (add/extend a dispatch-level test asserting `session.interactive.open` params.cwd reaches the
  spawn config)
  cd the-intern/service && cargo test -p bob
  (add/extend a chat.rs client test asserting the request includes the invocation cwd)

## Work Log

### Session 1 — 2026-07-08

Implemented the Diagnosis 1 fix contract exactly as recorded, threading the `bob chat` invocation cwd end-to-end through three crates. In `pi-agent-supervisor/src/process.rs`, added `cwd: Option<PathBuf>` to `InteractiveProcessConfig` and a `cmd.current_dir(cwd)` call in `InteractiveProcess::spawn` when `Some`, mirroring `RpcWorkerProcess::spawn`'s existing `worker_cwd` handling verbatim. This required threading the new field through `pi-agent-supervisor`'s `Command::StartInteractiveSession` enum variant and `Handle::start_interactive_session` signature, and updating the actor's `InteractiveProcessConfig` construction plus several existing test call sites that needed a `cwd`/`None` slot added. In `admin-rpc/src/dispatch.rs`, changed `Dispatcher::dispatch`'s `"session.interactive.open"` arm to pass `&request.params` through to `handle_session_interactive_open`, which now parses an optional `params.cwd` string into a `PathBuf` and carries it on a new `cwd` field of `DispatchOutcome::InteractiveSessionOpening`. In `admin-rpc/src/lib.rs`, updated the connection loop's match arm and `handle_interactive_session_opening`'s signature to accept and forward that `cwd` into the `supervisor.start_interactive_session(...)` call, ahead of the static `InteractiveSessionConfig` (which has no cwd concept and was left untouched). Finally, in `bob/src/cli/commands/chat.rs`, `run_interactive_session` now captures `std::env::current_dir()` at the top of the function (returning a clear `invalid_request_error` if it cannot be resolved) and sends it as `params: { "cwd": ... }` on the `session.interactive.open` request instead of the previous hard-coded `params: {}`.

Followed TDD per layer, bottom-up (process.rs first, then pi-agent-supervisor/lib.rs, then admin-rpc, then bob chat.rs), since each layer's new tests required the layer below to already support the new parameter to compile. For `pi-agent-supervisor` and `bob`, genuine RED was observed directly (assertion failures) before implementing the fix. For the admin-rpc dispatch-level test, the struct field and the parsing logic landed in the same edit for compilation reasons; RED was independently confirmed after the fact by temporarily stubbing the parser to always return `None`, rerunning the new test to see it fail, then restoring the real implementation. Added a genuinely new end-to-end integration test in admin-rpc's `lib.rs` (`run_connection_session_interactive_open_with_params_cwd_spawns_child_in_that_directory`) that drives the full ADR-011 SCM_RIGHTS protocol with a real `params.cwd`, spawns a real child that writes `$(pwd)` to a redirected file, and asserts the reported directory matches — this is the strongest evidence that the fix works end-to-end, not just at each unit boundary.

Considered and rejected adding a test for the `current_dir()` resolution failure branch in `chat.rs`: reproducing that failure requires changing the OS-level cwd of the test process, which is global state shared by all tests running concurrently in the same binary; the risk of flaking unrelated tests outweighed the value of covering a one-line `map_err` wrapper with no independent logic. Verified via `grep` that no read of `pi_agent_cwd` was introduced anywhere on the interactive-session path (per CR-005 / fix-contract point 4) — only doc-comment mentions of the name exist, all explaining why it is *not* consulted here.

`cargo test --workspace` and `cargo fmt --all -- --check` are both clean at the final commit (`d8c3e13`). Nothing remains against the fix contract; ready for review.

**Obstacles Encountered:** The bug branch's checked-out copy of the canonical bug file predates the Diagnosis Log commit on `dev-agent` (branch cut before `aa1cf8b`); per instructions the Diagnosis Log was read via `git show dev-agent:...` rather than the working-tree copy, and the bug file was never touched locally on the bug branch. `InteractiveProcessConfig` struct-field additions were compile-blocking for several existing tests/call sites across `process.rs`, `pool.rs`, and `lib.rs` (pi-agent-supervisor), so those scaffolding updates had to land alongside the new field before the crate would compile — the actual RED/GREEN cycle was on the new tests' assertions, not the scaffolding. For the admin-rpc dispatch layer, the field addition and the `params.cwd` parsing logic were written in the same edit (needed for compilation); genuine RED was retroactively verified by temporarily stubbing the parser to `None`, confirming the new dispatch test failed, then restoring the real parsing.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that diagnosis, fix, verification, and code quality passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->

### Review Verdict — 2026-07-08

PASS

**Diagnosis→fix evidence chain (checked before Stage 1):** the Diagnosis Log ("Diagnosis 1 —
2026-07-08") records reproduction status (confirmed, both static source-path trace and a dynamic
diagnostic unit test against the real `InteractiveProcess::spawn`, since reverted and re-verified
clean), extensive evidence captured (file:line citations across `chat.rs`, `dispatch.rs`, `lib.rs`
(admin-rpc), `process.rs`, `serve.rs`), an isolated fault stated as a three-way gap across the three
crates, and a root cause explicitly marked "confirmed (not a hypothesis)" with supporting reasoning.
The Diagnosis Log's fix contract (4 numbered points) and planned verification (three `cargo test -p
<crate>` commands) are complete. Evidence chain is sound; proceeded to Stage 1.

**Stage 1 — Bug Criteria**

- Diagnosis Log includes reproduction status and evidence: met (see above).
- Fix addresses the isolated fault / root cause exactly as documented, across all three layers:
  - `the-intern/service/crates/bob/src/cli/commands/chat.rs`: `run_interactive_session` now captures
    `std::env::current_dir()` and sends it as `params: { "cwd": ... }` on `session.interactive.open`,
    with a clear `invalid_request_error` if resolution fails — matches fix-contract point 1.
  - `the-intern/service/crates/admin-rpc/src/dispatch.rs`: `Dispatcher::dispatch` now passes
    `&request.params` to `handle_session_interactive_open`, which parses an optional `params.cwd`
    string into `PathBuf` (non-string values safely fall back to `None`) and carries it on a new
    `cwd` field of `DispatchOutcome::InteractiveSessionOpening` — matches fix-contract point 2.
  - `the-intern/service/crates/admin-rpc/src/lib.rs`: `handle_interactive_session_opening` now
    accepts and forwards `cwd` into `supervisor.start_interactive_session(...)`, ahead of/alongside
    the untouched static `InteractiveSessionConfig` — matches fix-contract point 2.
  - `the-intern/service/crates/pi-agent-supervisor/src/process.rs`: `InteractiveProcessConfig` gains
    `cwd: Option<PathBuf>`, and `InteractiveProcess::spawn` calls `cmd.current_dir(cwd)` when `Some`,
    mirroring `RpcWorkerProcess::spawn`'s `worker_cwd` handling exactly, including leave-unset-when-
    `None` fallback — matches fix-contract point 3.
  - Fix-contract point 4 (never read `pi_agent_cwd` on this path): verified independently via
    `git diff dev-agent...bug/B-021-... | grep pi_agent_cwd` — the only four hits are doc-comment
    mentions explaining the exclusion; no code reads the setting anywhere in the diff.
- Fix Verification steps followed: ran all three commands from the Diagnosis Log's planned
  verification (the bug file's own Fix Verification section only lists the
  `pi-agent-supervisor` command, but the fuller diagnosis-log plan explicitly extends it to
  `admin-rpc` and `bob`, and the Work Log confirms the same three crates were exercised):
  `cd the-intern/service && cargo test -p pi-agent-supervisor` — 63 passed, including the two new
  regression tests (`interactive_spawn_sets_current_dir_on_child_when_cwd_is_configured`,
  `interactive_spawn_inherits_launch_cwd_when_cwd_is_not_configured`).
  `cd the-intern/service && cargo test -p admin-rpc` — 112 passed, including three new tests: two
  dispatch-level parsing tests and a strong end-to-end test
  (`run_connection_session_interactive_open_with_params_cwd_spawns_child_in_that_directory`) that
  drives the real ADR-011 SCM_RIGHTS protocol and asserts a real spawned child's cwd.
  `cd the-intern/service && cargo test -p bob` — 5 chat-module tests passed, including the new
  `sends_invocation_cwd_in_session_interactive_open_request_params`.
  Also ran `cargo test --workspace` (all suites, 0 failed) and `cargo fmt --all -- --check` (clean)
  and `cargo build -p bob` (clean, no warnings) on the bug branch in an isolated worktree, matching
  the Work Log's claims.
- No unrelated behavior added: `git diff dev-agent...bug/B-021-bob-chat-cwd-does-not-use-invocation-
  directory --stat` touches only the six files implicated by the fix contract, all inside
  `the-intern/service`; no changes outside that tree. The canonical bug file itself is untouched on
  the branch (confirmed empty diff), consistent with the Work Log's Obstacles note about the branch
  predating the Diagnosis Log commit.

**Stage 2 — Code Quality**

- Correctness: the `cwd`-threading logic in each layer mirrors the existing, already-tested
  `worker_cwd` pattern (`RpcWorkerProcess::spawn` / `WorkerProcessConfig`) closely enough that no new
  failure modes are introduced; non-string/absent `params.cwd` degrades gracefully to `None`
  (inherit launch cwd) rather than erroring.
- Tests: new tests cover both the configured-cwd and unset-cwd (fallback) paths at each of the three
  layers, plus one true end-to-end test through the real socket/SCM_RIGHTS protocol. Tests use
  unique temp directories/session IDs and clean up after themselves; no shared mutable state
  observed.
- Security: `params.cwd` is caller-supplied but the trust boundary here is the same as
  `session.interactive.open` overall — a local, 0700-permissioned Unix socket restricted to the
  invoking user (per the existing "no pre-flight admission" doc comment); this is not a new
  privilege the client didn't already have. No secrets, no injection surface.
- Readability: field and function names are descriptive (`cwd`, `interactive_cwd`, doc comments
  cite CR-005/B-021 and explain the `None` fallback); no dead code or commented-out blocks.
- Performance: no unnecessary loops, blocking calls, or resource leaks; the process-spawn path is
  unchanged apart from the added `current_dir` call.

**Bug Fix Addendum**

- Fix is minimal for the isolated fault: the change touches exactly the three-layer plumbing chain
  named in the fix contract (client → dispatch → supervisor/spawn), plus the unavoidable call-site
  scaffolding (`None` cwd arguments added to pre-existing test constructors in `lib.rs`/`pool.rs`)
  needed for the crate to compile with the new field. No unrelated refactor or feature code is
  present in the diff.
- Regression tests exist and are genuinely new: Work Log documents true RED-before-GREEN for the
  `pi-agent-supervisor` and `bob` layers, and a retroactive RED verification (temporarily stubbing
  the parser to always return `None`) for the `admin-rpc` dispatch test, where the field and parsing
  landed together for compilation reasons — a reasonable, explicitly-documented exception, not an
  unverified claim.
- No unrelated refactoring/cleanup/feature code bundled in: confirmed by direct diff review of all
  six touched files.
- Diagnosis Log fix contract matches the implementation point-for-point (verified above).

**Minor observation (non-blocking):** the Developer considered and explicitly rejected adding a test
for the `current_dir()`-resolution-failure branch in `chat.rs`, reasoning that it would require
mutating the OS-level cwd of the whole test binary (shared, concurrent global state) for one line of
`map_err` wrapping with no independent logic. This is a reasonable, documented trade-off and not a
gap that blocks the verdict.
