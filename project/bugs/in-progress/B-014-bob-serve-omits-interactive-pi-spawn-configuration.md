---
id: B-014
title: Bob serve omits interactive pi spawn configuration
severity: medium
status: in-progress
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
