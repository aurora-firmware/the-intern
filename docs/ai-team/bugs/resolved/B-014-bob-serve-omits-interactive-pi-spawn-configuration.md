---
id: B-014
title: Bob serve omits interactive pi spawn configuration
severity: medium
status: resolved
created: '2026-06-24'
task: T-105
---

# Bob serve omits interactive pi spawn configuration

## Summary

`bob serve` constructs `admin_rpc::Config` without populating its
`interactive_session` field. Interactive `bob chat` launches therefore ignore
the resolved Bob configuration and fall back to an empty extension socket path
and the `bob` executable as the pi extension. Production interactive sessions
can fail to launch or run without the authorization/event-forwarding extension.

## Reproduction Status

Status: confirmed

Confirmed deterministically by tracing the configuration flow on `dev-agent` at
commit `1ae86bce90bf9ea718414b538eb12e8350fb3d0f`.

## Evidence

- `bob/src/serve.rs` creates `admin_rpc::Config` with struct-default
  `interactive_session: None`.
- `admin-rpc/src/lib.rs` handles `None` by selecting command `pi`, no socket
  environment path, and `current_exe()` as `--extension`.
- No existing test asserts that `BobConfig` interactive spawn fields reach
  `admin_rpc::Config`.

## Reproduction Steps

1. Load a `BobConfig` with non-default `pi_agent_command`,
   `extension_sock_path`, and `extension_path`.
2. Start the service through `bob::serve`.
3. Request `session.interactive.open` and inspect the spawn configuration.

## Expected Behavior

The interactive child uses the configured pi command, no RPC-mode arguments,
the configured shutdown deadline, and the configured extension socket and file
paths.

## Actual Behavior

The handler uses its fallback configuration: command `pi`, no socket path, a
ten-second deadline, and the running `bob` executable as the extension path.

## Environment

- OS / platform: Linux
- Language / runtime version: Rust workspace toolchain managed by mise
- Relevant dependencies: `bob`, `admin-rpc`, `pi-agent-supervisor`
- Branch / commit: `dev-agent` / `1ae86bce90bf9ea718414b538eb12e8350fb3d0f`

## Related

- Task: `T-105`
- Change request: `CR-002-bob-chat-launches-an-interactive-pi-session.md`
- Related extension configuration: `CR-003-bob-loads-its-pi-extension-by-path-from-the-xdg-data-directory.md`

## Suspected Area

`the-intern/service/crates/bob/src/serve.rs`, where the admin-RPC configuration
is assembled.

## Fix Verification

```bash
cd the-intern/service
cargo test -p bob serve::tests
cargo test -p admin-rpc
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

### Diagnosis 1 — 2026-06-24

Reproduction status: Confirmed deterministically by code-path inspection on
`dev-agent` commit `4d36efe`. `try_start_subsystems` constructs
`admin_rpc::Config` without `interactive_session`, so the field remains `None`.

Evidence captured: `bob/src/serve.rs:207-218` initializes the admin-RPC config
with `..Default::default()` and no interactive configuration. In
`admin-rpc/src/lib.rs:474-483`, `None` selects an empty extension socket path
and `current_exe()` as the extension file. `BobConfig` already contains the
correct command, shutdown deadline, extension socket, and extension file path.

Isolated fault: The admin-RPC configuration assembly in
`the-intern/service/crates/bob/src/serve.rs` omits the mapping from `BobConfig`
to `admin_rpc::InteractiveSessionConfig`.

Root cause or fault hypothesis: T-105 added an optional spawn configuration to
admin-RPC and tested it at that crate boundary, but the service composition root
was not updated to supply the production configuration. The fallback comment
assumed production would override it, while no override exists.

Planned fix: Add a small `build_interactive_session_config` mapper in
`bob::serve`, cover all fields with a unit test, and set
`admin_rpc::Config::interactive_session` to `Some(...)`. Interactive arguments
must be empty because `BobConfig::pi_agent_args` selects RPC mode and is valid
only for worker processes.

Planned verification: First add a mapper test and confirm it fails before the
mapper exists. Then run `cargo test -p bob serve::tests`,
`cargo test -p admin-rpc`, and `cargo fmt --all -- --check` from
`the-intern/service`.

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

### Session 1 — 2026-06-24

Implemented the diagnosis contract on
`bug/B-014-bob-serve-omits-interactive-pi-spawn-configuration`. The red test
`interactive_session_config_maps_bob_spawn_settings_without_rpc_args` initially
failed to compile because the diagnosed mapper did not exist. Added the minimal
mapper and explicitly set `admin_rpc::Config::interactive_session` at the bob
service composition root. The mapper passes the configured pi command,
shutdown deadline, extension socket, and extension file while deliberately
using empty arguments for interactive mode instead of the RPC worker arguments.

The focused regression test passed after implementation. Initial broader test
runs inside the restricted sandbox produced the repository's documented Unix
socket `Operation not permitted` failures; rerunning outside the sandbox passed:
26/26 `bob serve::tests` and 99/99 `admin-rpc` tests. `cargo fmt --all --
--check` also passed. Implementation commit: `aa530fd`.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that diagnosis, fix, verification, and code quality passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->

### Review Verdict — 2026-06-24

PASS

Stage 1 passed: the Diagnosis Log contains the full evidence chain and the
branch fix directly addresses the omitted production mapping. Both Fix
Verification suites passed outside the restricted Unix-socket sandbox, and the
red/green regression test covers every mapped field plus exclusion of RPC-mode
arguments. No unrelated implementation files changed.

Stage 2 passed: the mapper is focused and readable, introduces no new input or
security surface, and the service composition explicitly supplies the
configuration that admin-RPC already supports. The change is minimal and
matches the diagnosis contract.
