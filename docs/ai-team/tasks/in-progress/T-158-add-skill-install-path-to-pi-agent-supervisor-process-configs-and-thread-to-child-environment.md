---
id: T-158
title: Add skill_install_path to pi-agent-supervisor process configs and thread 
  to child environment
status: pending
priority: high
assigned-role: developer
created: '2026-08-09'
spec: S-011
---

# Add skill_install_path to pi-agent-supervisor process configs and thread to child environment

## Description

S-011 Implementation Order Phase 4. Add a `skill_install_path:
Option<PathBuf>` field to the pi-agent-supervisor crate's per-spawn-path
config structs (`WorkerProcessConfig` and `InteractiveProcessConfig` in
`the-intern/service/crates/pi-agent-supervisor/src/{lib.rs,process.rs}`) and
set it as a new `BOB_SKILL_INSTALL_PATH` environment variable on the spawned
child in both `RpcWorkerProcess::spawn` and `InteractiveProcess::spawn`
(`process.rs`), mirroring exactly how `BOB_EXTENSION_SOCK_PATH` is already
conditionally set from `extension_sock_path`. When the resolved path is
empty/unset, the env var must be omitted rather than set to an empty
string, so the extension (T-160) can distinguish "not configured" from
"configured but empty" — matching ADR-014 §4's fail-open behaviour (missing
path → no skills, not a spawn failure). This task is independent of
`BobConfig` itself (T-157); it only extends the supervisor crate's own
config surface, the same split T-119/T-121 used for `pi_agent_cwd`.

**Interactive path note (verified against current code):** the
`pi_agent_cwd`/`extension_path` precedent does not fully carry over here.
`InteractiveProcessConfig` is constructed in `Actor::run`'s
`Command::StartInteractiveSession` arm (`lib.rs`) from caller-supplied
parameters routed through `Handle::start_interactive_session` from
`admin-rpc`, which never consults the actor's own `Config` on that path
(CR-005 precedent). T-159's `serve.rs` wiring alone therefore cannot reach
interactive sessions — this task must have the actor's
`StartInteractiveSession` handler populate `InteractiveProcessConfig.skill_install_path`
directly from the actor's own `Config.skill_install_path` (AC-4 below),
without adding a new parameter to `start_interactive_session` or touching
`admin-rpc`.

## Acceptance Criteria

AC-1: The system shall add an optional `skill_install_path` field to both
      `WorkerProcessConfig` and `InteractiveProcessConfig`.
AC-2: WHEN `skill_install_path` is set and non-empty on either config THE
      SYSTEM SHALL set `BOB_SKILL_INSTALL_PATH` on the spawned child's
      environment to that value.
AC-3: WHILE `skill_install_path` is unset or empty THE SYSTEM SHALL NOT set
      `BOB_SKILL_INSTALL_PATH` on the spawned child's environment, and
      spawning shall still succeed.
AC-4: WHEN the actor handles `Command::StartInteractiveSession` THE SYSTEM
      SHALL populate the resulting `InteractiveProcessConfig.skill_install_path`
      from the actor's own `Config.skill_install_path`, so interactive
      sessions carry the service-wide value without a new RPC parameter.

## Dependencies

- None

## Files to Touch

- `the-intern/service/crates/pi-agent-supervisor/src/process.rs` — add the
  field to both config structs and set the env var in both `spawn`
  implementations
- `the-intern/service/crates/pi-agent-supervisor/src/lib.rs` — thread the
  field through the crate's own `Config` type and populate it on the
  `StartInteractiveSession` handling path (AC-4)
- `the-intern/service/crates/pi-agent-supervisor/src/pool.rs` — map the new
  field in `SessionPool::worker_process_config_for_session` and the
  dedicated-worker variant, mirroring the existing `worker_cwd` mapping

## Verification

```bash
cd the-intern/service && cargo test -p pi-agent-supervisor
```

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
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->
